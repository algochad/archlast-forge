# Releasing

How a release reaches every place people get archlast-forge from. Releases are lockstep: one version for all nine packages, the engine image, and the version strings in the docs' samples. 0.6.1 and 0.7.0 were released with exactly these steps.

## Branches

Two branches are protected by rulesets (Settings > Rules): nothing is pushed to either, everything is a pull request.

| Branch | What it is | Takes pull requests from | Must pass |
| ------ | ---------- | ------------------------ | --------- |
| `staging` | where changes land and are reviewed; the default target for contributors | contributors' branches and forks, and the owner's `release/X.Y.Z` | the `test` job, and the owner's review |
| `master` | what is released from; the engine image is built when it is updated | `staging` only | the `test`, `source-branch` and (on a version change) `release-notes` jobs |

- **Contributors** branch from `staging` and open their pull request into `staging`. The owner reviews it there (see [Reviewing a pull request](#reviewing-a-pull-request)). Pull requests into `master` from anywhere but `staging` fail the `source-branch` check. (Until the `staging` branch exists the check passes, only for the pull request that introduces it; it needs GitHub to answer "no such branch" exactly, and fails on any other answer.)
- **Nothing publishes from `staging`.** The `engine-image` job of `ci.yml` runs only when `master` is updated (a push to `master`, which is a merge from `staging`), and it only builds the image and runs it. The image and the packages are published by `release.yml`, which starts by itself when CI passes on a merge into `master` that ships something (see [The release](#the-release)). Pull requests and `staging` can't overwrite the production image: they never push one.
- **The release notes** are a commit on `staging` before it is merged into `master`: they move from "Unreleased" to the new version in `apps/docs/content/release-notes.mdx`, so the docs site that is built from `master` has them.
- The owner can bypass either ruleset, but only through a pull request.

## The publishing points

| Point | What | How it is published | Needs |
| ----- | ---- | ------------------- | ----- |
| git | `master` (by pull request: it is protected), and the tag `vX.Y.Z` | a merged PR; the tag is made by the release workflow, after the packages are published | the owner's account |
| npm | `@archlast/forge-runtime`, `-client`, `-react`, `-vue`, `-svelte`, `-framework`, `-dashboard`, `-cli`, and `create-archlast-forge` | the **publish** job of `.github/workflows/release.yml`, which starts by itself when CI passes on a merge into `master` that ships something | the `NPM_TOKEN` repository secret (a granular token with read and write on all packages, new names included) |
| GHCR | `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` and `:latest` | the **engine-image** job of the same workflow (`latest` moves only for a real release, not a pre-release); it runs first, because a new project's `archlast-forge up` pulls the image the moment the packages exist | `GITHUB_TOKEN` (automatic) |
| Docs site | `apps/docs`, built and served by Caddy | **not in any workflow**: Coolify builds it (see [the docs site](#the-docs-site)) | the Coolify project |

The CLI pulls the engine image whose tag equals its own version, so the packages and the image must always be released together. Inside this repo the CLI builds the image itself if it is missing, which is why nothing breaks locally when they are out of step.

## Rules

- **Publishing can't be taken back, and merging starts it.** npm never lets a version be reused, and people may already have pulled an image tag. Every merge into `master` that ships something is a release, once CI passes. So merge into `master` only when the user asks for it, with the change reviewed on `staging`. A request to commit or push is not one. `[skip release]` in a commit message of the merge skips it.
- **A release is only ever made from a commit of `master` with green CI.** The release workflow's first job, `plan`, refuses a commit that isn't reachable from `master` or has no successful CI run before anything is pushed. It also ends there for a merge that ships nothing (see below) and for a commit that was released already.
- **Nobody tags by hand, and nobody bumps the version by hand for an ordinary release.** The workflow picks the version, stamps it into the packages and the image, publishes, and only then makes the tag `vX.Y.Z` and the GitHub release, so a tag exists only for a release that happened.
- **Bun 1.4.4.** Check `bun --version` (mise installs it; see `mise.toml`). If `bun` on the PATH is older, call the mise binary: `~/.local/share/mise/installs/bun/1.4.4/bin/bun`.

## The release

Every merge into `master` that ships something releases itself, from `staging` or not. `release.yml` runs after CI succeeds on the merge commit, and `scripts/release-plan.ts` decides, from what changed since the last release (the highest `v*` tag), with the rules in `scripts/release-bump.ts` (tests: `scripts/release-bump.test.ts`, run by CI):

| What changed since the last release | Release |
| ----------------------------------- | ------- |
| nothing a package or the engine image ships: only `apps/docs`, `docs`, `skills`, `.github`, `scripts`, tests, `bun.lock` | **none**: the run ends at `plan` |
| `[skip release]` in a commit message | **none** |
| a fix, an internal change, a dependency: anything that ships and adds nothing to what users see | **patch**: `0.17.0` becomes `0.17.1` |
| a new or removed public export (the entry files of the packages, the top level of `packages/runtime/src`), a new CLI flag, a new engine setting, a new scaffolded file or package, a `feat:` or breaking (`!:`, `BREAKING CHANGE`) commit, or `[minor]` in a commit message | **minor**: `0.17.4` becomes `0.18.0` |
| `[release]` in a commit message | at least a patch, even if nothing shipped |
| `packages/*/package.json` above the last release (someone ran `scripts/version.ts`) | **that version**, as it is: for 0.18.0 by choice, or 1.0.0 |

- **The version is not committed.** The repository's `package.json` keeps the line (`0.17.0`), the workflow works out `0.17.3` from the tags, stamps it into the packages and the image, and the tag `v0.17.3` records it. So the version in the repository can be behind the published one: the last release is the highest `v*` tag (`git tag --list 'v*'`) or `npm view @archlast/forge-runtime version`.
- **The same commit gets the same version**, so a re-run after a failure finishes the same release (npm's packages are skipped, the image is rebuilt from the same commit).
- **The notes:** a release whose version a person set uses its `## X.Y.Z` section of the release notes page for its GitHub release; any other release gets the subjects of the commits since the last release, with a link to the comparison. The story of a version is written on the docs' Release notes page when it is worth telling.
- A pre-release (`0.18.0-rc.1`, set with `scripts/version.ts`) publishes under `next`, moves no `latest` (npm or image) and is a GitHub pre-release.

## Steps

An ordinary release, a patch or a minor the rules pick, has no steps beyond reviewing and merging:

1. A change is a pull request into `staging` (reviewed as [below](#reviewing-a-pull-request)); put a line under "Unreleased" in `apps/docs/content/release-notes.mdx` for what users notice.
2. Merge `staging` into `master` (a pull request, a merge commit): `gh pr create --base master --head staging --fill`, `gh pr checks --watch` (`test`, `source-branch` and `release-notes` must pass), `gh pr merge --merge` (the owner may merge without a second reviewer; keep `staging`). **This merge is the release**, if it ships something.
3. **Watch the release**, which starts by itself when CI succeeds on the merge commit of `master`:
   ```bash
   sleep 20                                                  # the Release run starts when the CI run finishes
   id=$(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')
   until [ "$(gh run view $id --json status -q .status)" = completed ]; do sleep 20; done
   gh run view $id --json conclusion,jobs -q '"conclusion: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
   ```
   `plan` checks the commit is on `master` with green CI and works out the version; `engine-image` stamps it and pushes `:X.Y.Z` (and `:latest` for a real release); `publish` stamps it into the packages, runs `bun scripts/pack.ts --smoke` and publishes each tarball in `.pack/` with `npm publish --access public`, under `latest` (under `next` for a pre-release), skipping a package npm already has; `tag` makes `vX.Y.Z` on the commit and the GitHub release. `git pull --tags` brings the tag. A run that ends at `plan` was not a release: its log says why.
4. **Verify the registries.** A green workflow is not proof: npm can take a few minutes to show a version, so look with `--prefer-online` and retry.
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

5. **Redeploy the docs site**, so its samples, pages, release notes and `llms.txt` match the release (below). Then report what was published, with the commit, the tag and the image digest.


### Choosing the version yourself

For a new minor line by choice (0.18.0), 1.0.0 or a pre-release, set the version in a pull request, and that exact version is released:

1. **Set the version**: `bun scripts/version.ts X.Y.Z`. It sets `version` in every `packages/*/package.json` and nothing else.
2. **Update the version strings it doesn't touch**, all under `apps/docs/content`:
   - the banner in sample output, `archlast-forge X.Y.Z  ·` (`backend`, `cli`, `framework`, `getting-started`, `tutorial`);
   - the engine image tag, `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` (`backend`, `troubleshooting`, `cli`);
   - the example range `"@archlast/forge-runtime": "^X.Y.Z"` (`functions`);
   - the header of `reference`, "Signatures are copied from the source of version X.Y.Z".

   Find every one with `grep -rn "<previous version>" apps docs packages --include=*.mdx --include=*.md --include=*.json --include=*.ts --include=*.tsx | grep -v node_modules`. What is left should be a deliberate baseline, such as a benchmark README that says which version it measured. If the public API changed, make sure `reference.mdx` shows it: its signatures are copied from the source.
3. **Write the release notes**: in `apps/docs/content/release-notes.mdx`, rename "Unreleased" to `## X.Y.Z` and open a new empty "Unreleased" above it. Say what a user must do to upgrade, and what moved. The `release-notes` check fails the pull request into `master` if the version changed and this heading is missing; `bun scripts/check-release-notes.ts origin/master` runs it here.
4. **Refresh and check**: `bun install` (updates the workspace versions in `bun.lock`), then `bun install --frozen-lockfile` and `bun run --cwd apps/docs build` must both pass, as CI will run them. `bun scripts/release-plan.ts` shows what the workflow will do with it.
5. **Commit** as `Version X.Y.Z` (the body says what the release contains), on a branch from `staging` (`git switch -c release/X.Y.Z`), `gh pr create --base staging`, merge it, then merge `staging` into `master` as in the steps above.

## Reviewing a pull request

The owner reviews every pull request into `staging` before it merges; the rulesets require a review and a green `test` job, and the review is where the rest is checked:

- **Security:** new input is validated (`v` validators, `ForgeError` for what callers should see); no secret, token or internal detail in a response, log or error; auth checked in every function that isn't public, `internal*` for what clients must not call; no `fetch` or I/O in a query or mutation; new Redis keys built from `config.redisPrefix`; new dependencies are needed, maintained and pinned; no change to a workflow, a ruleset, `release.yml` or a Dockerfile that the pull request doesn't explain.
- **Tests:** every change of behavior has a test that fails without it, in the package it changes (`bun run test`, `bun run typecheck`); a bug fix has its regression test.
- **Docs and the skill:** a change to the public API, a CLI flag or what the scaffolder writes updates `apps/docs/content`, the skill (`bun run skill:check`) and "Unreleased" in the release notes.
- **Fit:** it follows `docs/decisions.md`; a change to a settled choice says so and why.

A pull request from a fork runs the same checks; read what it changes in `.github/` and `scripts/` before approving.

## The docs site

`apps/docs` is a static site (React, pre-rendered pages, Caddy) that Coolify builds from `apps/docs/compose.yaml`: the Docker Compose build pack, Base Directory `/apps/docs`, Docker Compose Location `/compose.yaml`, a domain on the `docs` service. It needs `SITE_URL` as a build variable, an origin like `https://docs.example.com`, which gives the pages canonical links and the site a `sitemap.xml` (the build fails on anything but an origin). The Dockerfile copies only `apps/docs`, so it doesn't use the root lockfile.

Check a build before a release with `bun run --cwd apps/docs build`; it fails when a page is missing from the sidebar or a link names no page. To see the container as Coolify runs it: `cd apps/docs && docker compose run --build --rm -p 8080:80 docs`.

**Whether Coolify redeploys on a push to `master` is not recorded in the repository.** After a release, open the Coolify project and check that the deployment shows the release commit, or trigger it. If you can't see Coolify, tell the user the site needs redeploying instead of assuming it did.

## When it goes wrong

- **CI is red on a merge into `master`.** Nothing is released: the release needs a green run. Fix it through a pull request into `staging`, then into `master`; the fix is a merge that ships, so it releases (the next version, since nothing was published) when CI passes on it.
- **The release workflow fails before npm** (`plan` refusing a commit or missing notes, the image build, the pack smoke test, a missing `NPM_TOKEN`: the failing step says so). Nothing is on npm and there is no tag to delete. Fix the cause: if it is a repository secret, `gh run rerun <id> --failed` is enough; if it is a commit, merge the fix the same way and the release runs again on it. The image job runs first, so `:X.Y.Z` and `:latest` on GHCR may already hold a build of the broken commit until the next run overwrites them; check the digest afterwards (step 9).
- **It fails while publishing to npm.** Some packages may be live and npm refuses to publish a version twice. Re-run the failed jobs (`gh run rerun <id> --failed`, or `gh workflow run Release` on the same head of `master`): the packages npm already has are skipped and the rest are published from the same commit, then the tag is made. Do not finish by hand. If the commit has to change, release the next patch (`X.Y.Z+1`, all packages) and, if the incomplete version could mislead anyone, `npm deprecate` it with a message.
- **A bad release is out.** It can't be unpublished safely: deprecate the version and release a patch.

## Known gaps

- **The release workflow has run end to end only in parts.** Its planning step (`scripts/release-plan.ts`) and the release-notes extraction were run against the real npm registry and the docs, and the workflow passes `actionlint`, but a full release has not been made with it yet: watch the first one (step 8).
- **The docs site isn't published by a workflow** (above).
