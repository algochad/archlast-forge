# Releasing

How a release reaches every place people get archlast-forge from. Releases are lockstep: one version for all nine packages, the engine image, and the version strings in the docs' samples. 0.6.1 and 0.7.0 were released with exactly these steps.

## The publishing points

| Point | What | How it is published | Needs |
| ----- | ---- | ------------------- | ----- |
| git | `master`, and the tag `vX.Y.Z` | `git push` | push access |
| npm | `@archlast/forge-runtime`, `-client`, `-react`, `-vue`, `-svelte`, `-framework`, `-dashboard`, `-cli`, and `create-archlast-forge` | the **publish** job of `.github/workflows/release.yml`, on a `v*` tag | the `NPM_TOKEN` repository secret (a granular token with read and write on all packages, new names included) |
| GHCR | `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` and `:latest` | the **engine-image** job of the same workflow; it runs first, because a new project's `archlast-forge up` pulls the image the moment the packages exist | `GITHUB_TOKEN` (automatic) |
| Docs site | `apps/docs`, built and served by Caddy | **not in any workflow**: Coolify builds it (see [the docs site](#the-docs-site)) | the Coolify project |

The CLI pulls the engine image whose tag equals its own version, so the packages and the image must always be released together. Inside this repo the CLI builds the image itself if it is missing, which is why nothing breaks locally when they are out of step.

## Rules

- **Publishing can't be taken back.** npm never lets a version be reused, and people may already have pulled an image tag. Publish only when the user asks for a release. A request to commit or push is not one.
- **Never tag before CI is green on the exact commit that gets the tag.** The release workflow rebuilds and smoke-tests, but it is the last line of defense, not the first.
- **Bun 1.4.4.** Check `bun --version` (mise installs it; see `mise.toml`). If `bun` on the PATH is older, call the mise binary: `~/.local/share/mise/installs/bun/1.4.4/bin/bun`.
- **The version.** A patch for fixes, a minor for new public API or behavior (0.7.0 added the `access` option), a pre-release such as `0.8.0-rc.1` only when the user asks (read [Known gaps](#known-gaps) first).

## Steps

Run from the repository root, on `master`, with a clean working tree. `X.Y.Z` is the new version.

1. **Land the change first**, in its own commit(s), with its tests and docs: a message that says what changed and why, and numbers where there are any. The version commit comes after it, so the history reads change, then release.
2. **Set the version**: `bun scripts/version.ts X.Y.Z`. It sets `version` in every `packages/*/package.json` and nothing else.
3. **Update the version strings it doesn't touch**, all under `apps/docs/content`:
   - the banner in sample output, `archlast-forge X.Y.Z  ·` (`backend`, `cli`, `framework`, `getting-started`, `tutorial`);
   - the engine image tag, `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` (`backend`, `troubleshooting`, `cli`);
   - the example range `"@archlast/forge-runtime": "^X.Y.Z"` (`functions`);
   - the header of `reference`, "Signatures are copied from the source of version X.Y.Z".

   Find every one with `grep -rn "<previous version>" apps docs packages --include=*.mdx --include=*.md --include=*.json --include=*.ts --include=*.tsx | grep -v node_modules`. What is left should be a deliberate baseline, such as a benchmark README that says which version it measured.
   If the public API changed, make sure `reference.mdx` shows it: its signatures are copied from the source.
4. **Refresh and check**: `bun install` (updates the workspace versions in `bun.lock`), then `bun install --frozen-lockfile` and `bun run --cwd apps/docs build` must both pass, as CI will run them.
5. **Commit** as `Version X.Y.Z`. The body says what the release contains (see `git log --grep '^Version'`).
6. **Push and wait for CI**:
   ```bash
   git push origin master && sleep 8                        # let the run register
   id=$(gh run list --branch master --limit 1 --json databaseId -q '.[0].databaseId')
   until [ "$(gh run view $id --json status -q .status)" = completed ]; do sleep 20; done
   gh run view $id --json conclusion,jobs -q '"conclusion: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
   ```
   The `test` job typechecks and builds, runs the tests against SQLite, Postgres, Redis and S3, packs the tarballs and serves a full-stack app and a backend from them, then runs the Docker end-to-end scripts. `engine-image` builds the image. Both must be `success`.
7. **Tag and push the tag**, which starts the release workflow:
   ```bash
   git tag -a vX.Y.Z -m "Version X.Y.Z"
   git push origin vX.Y.Z && sleep 8
   id=$(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')
   until [ "$(gh run view $id --json status -q .status)" = completed ]; do sleep 20; done
   gh run view $id --json conclusion,jobs -q '"conclusion: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
   ```
   The workflow builds and pushes the image, then runs `bun scripts/pack.ts --smoke` and publishes each tarball in `.pack/` with `npm publish --access public`, under `latest` (under `next` when the tag contains a `-`).
8. **Verify the registries.** A green workflow is not proof: npm can take a few minutes to show a version, so look with `--prefer-online` and retry.
   ```bash
   for d in packages/*; do
     p=$(bun -e "console.log(require('./$d/package.json').name)")
     echo "$p $(npm view --prefer-online $p version)"        # every line should say X.Y.Z
   done
   tok=$(curl -s "https://ghcr.io/token?scope=repository:algochad/archlast-forge-engine:pull" | bun -e "console.log(JSON.parse(await Bun.stdin.text()).token)")
   for t in X.Y.Z latest; do
     curl -sI -H "Authorization: Bearer $tok" -H "Accept: application/vnd.oci.image.index.v1+json" \
       https://ghcr.io/v2/algochad/archlast-forge-engine/manifests/$t | grep -iE "^HTTP|docker-content-digest"
   done                                                       # 200, and the same digest for both tags
   ```
9. **Redeploy the docs site**, so its samples, pages and `llms.txt` match the release (below). Then report what was published, with the commit, the tag and the image digest.

## The docs site

`apps/docs` is a static site (React, pre-rendered pages, Caddy) that Coolify builds from `apps/docs/compose.yaml`: the Docker Compose build pack, Base Directory `/apps/docs`, Docker Compose Location `/compose.yaml`, a domain on the `docs` service. It needs `SITE_URL` as a build variable, an origin like `https://docs.example.com`, which gives the pages canonical links and the site a `sitemap.xml` (the build fails on anything but an origin). The Dockerfile copies only `apps/docs`, so it doesn't use the root lockfile.

Check a build before a release with `bun run --cwd apps/docs build`; it fails when a page is missing from the sidebar or a link names no page. To see the container as Coolify runs it: `cd apps/docs && docker compose run --build --rm -p 8080:80 docs`.

**Whether Coolify redeploys on a push to `master` is not recorded in the repository.** After a release, open the Coolify project and check that the deployment shows the release commit, or trigger it. If you can't see Coolify, tell the user the site needs redeploying instead of assuming it did.

## When it goes wrong

- **CI is red.** Fix it, push, wait for green. Nothing is tagged yet, so nothing is lost.
- **The release workflow fails before npm** (image build, pack smoke test, a missing `NPM_TOKEN`: the publish step says so). Nothing is on npm. Fix the cause. If the fix is a repository secret, `gh run rerun <id>` is enough. If it is a new commit, the tag has to move: delete it (`git tag -d vX.Y.Z; git push origin :refs/tags/vX.Y.Z`), push the fix, wait for CI, tag again. Only do this while nothing has reached npm. The image job runs first, so `:X.Y.Z` and `:latest` on GHCR may already hold a build of the broken commit until the new run overwrites them; check the digest afterwards (step 8).
- **It fails while publishing to npm.** Some packages may be live and npm refuses to publish a version twice, so a rerun stops at the first one that is. Do not finish by hand under the same version. Release the next patch (`X.Y.Z+1`, all packages) and, if the incomplete version could mislead anyone, `npm deprecate` it with a message.
- **A bad release is out.** It can't be unpublished safely: deprecate the version and release a patch.

## Known gaps

- **Pre-release tags move `latest` on GHCR.** The npm side honors `-` in the tag (it publishes under `next`), but `release.yml` tags the image `:latest` unconditionally, so `0.8.0-rc.1` would become `latest`. Change the workflow before cutting a pre-release.
- **No GitHub Release is created**, so there are no release notes beyond the tag and the commit messages. The `Version X.Y.Z` commit body is the changelog.
- **The docs site isn't published by a workflow** (above).
