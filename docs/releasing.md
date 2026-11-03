# Releasing

How a release reaches every place people get archlast-forge from. Releases are lockstep: one version for all nine packages, the engine image, and the version strings in the docs' samples. 0.6.1 and 0.7.0 were released with exactly these steps.

## Branches

Two branches are protected by rulesets (Settings > Rules): nothing is pushed to either, everything is a pull request.

| Branch | What it is | Takes pull requests from | Must pass |
| ------ | ---------- | ------------------------ | --------- |
| `staging` | where changes land and are reviewed; the default target for contributors | contributors' branches and forks, and the owner's `release/X.Y.Z` | the `test` job, and the owner's review |
| `master` | what is released from; the engine image is built when it is updated | `staging` only | the `test`, `source-branch` and (on a version change) `release-notes` jobs |

- **Contributors** branch from `staging` and open their pull request into `staging`. The owner reviews it there (see [Reviewing a pull request](#reviewing-a-pull-request)). Pull requests into `master` from anywhere but `staging` fail the `source-branch` check.
- **Nothing publishes from `staging`.** The `engine-image` job of `ci.yml` runs only when `master` is updated (a push to `master`, which is a merge from `staging`), and it only builds the image and runs it. The image and the packages are published by `release.yml`, which starts by itself when CI passes on a merge into `master` that sets a version npm doesn't have (see [The release](#the-release)). Pull requests and `staging` can't overwrite the production image: they never push one.
- **The release notes** are a commit on `staging` before it is merged into `master`: they move from "Unreleased" to the new version in `apps/docs/content/release-notes.mdx`, so the docs site that is built from `master` has them.
- The owner can bypass either ruleset, but only through a pull request.

## The publishing points

| Point | What | How it is published | Needs |
| ----- | ---- | ------------------- | ----- |
| git | `master` (by pull request: it is protected), and the tag `vX.Y.Z` | a merged PR; the tag is made by the release workflow, after the packages are published | the owner's account |
| npm | `@archlast/forge-runtime`, `-client`, `-react`, `-vue`, `-svelte`, `-framework`, `-dashboard`, `-cli`, and `create-archlast-forge` | the **publish** job of `.github/workflows/release.yml`, which starts by itself when CI passes on a merge into `master` whose version npm doesn't have | the `NPM_TOKEN` repository secret (a granular token with read and write on all packages, new names included) |
| GHCR | `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` and `:latest` | the **engine-image** job of the same workflow (`latest` moves only for a real release, not a pre-release); it runs first, because a new project's `archlast-forge up` pulls the image the moment the packages exist | `GITHUB_TOKEN` (automatic) |
| Docs site | `apps/docs`, built and served by Caddy | **not in any workflow**: Coolify builds it (see [the docs site](#the-docs-site)) | the Coolify project |

The CLI pulls the engine image whose tag equals its own version, so the packages and the image must always be released together. Inside this repo the CLI builds the image itself if it is missing, which is why nothing breaks locally when they are out of step.

## Rules

- **Publishing can't be taken back, and merging starts it.** npm never lets a version be reused, and people may already have pulled an image tag. A merge into `master` that sets a version npm doesn't have is a release: it starts by itself when CI passes. So the merge of a version bump is the decision to release: do it only when the user asks for a release, with the release notes and the version already reviewed on `staging`. A request to commit or push is not one.
- **A release is only ever made from a commit of `master` with green CI.** The release workflow's first job, `plan`, refuses a commit that isn't reachable from `master` or has no successful CI run, and the notes (`## X.Y.Z` in the release notes page) must exist, before anything is pushed. Every package already having the version on npm (any merge that isn't a release) ends the run there. Pull requests (and so the `engine-image` job in `ci.yml`) only build the image; they never push it or publish a package.
- **Nobody tags by hand.** The workflow makes the tag `vX.Y.Z` and the GitHub release (from the release notes) after the packages are published, so a tag exists only for a release that happened.
- **Bun 1.4.4.** Check `bun --version` (mise installs it; see `mise.toml`). If `bun` on the PATH is older, call the mise binary: `~/.local/share/mise/installs/bun/1.4.4/bin/bun`.
- **The version.** A patch for fixes, a minor for new public API or behavior (0.7.0 added the `access` option), a pre-release such as `0.8.0-rc.1` only when the user asks: it publishes under `next`, moves no `latest` (npm or image) and makes a pre-release on GitHub.

## The release

Merging `staging` into `master` with a version that npm doesn't have yet releases it, with no tag to push: `release.yml` runs after CI succeeds on the merge commit, publishes the image and the packages, then tags the commit and writes the GitHub release. A merge that doesn't change the version (every package already has it on npm) does nothing there. The steps below are what you do before and around it.

## Steps

Run from the repository root, on `staging` (up to date), with a clean working tree. `X.Y.Z` is the new version.

1. **Land the change first**, through a pull request into `staging` (reviewed as below), in its own commit(s), with its tests and docs: a message that says what changed and why, and numbers where there are any. The version commit comes after it, so the history reads change, then release.
2. **Set the version**: `bun scripts/version.ts X.Y.Z`. It sets `version` in every `packages/*/package.json` and nothing else.
3. **Update the version strings it doesn't touch**, all under `apps/docs/content`:
   - the banner in sample output, `archlast-forge X.Y.Z  ·` (`backend`, `cli`, `framework`, `getting-started`, `tutorial`);
   - the engine image tag, `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` (`backend`, `troubleshooting`, `cli`);
   - the example range `"@archlast/forge-runtime": "^X.Y.Z"` (`functions`);
   - the header of `reference`, "Signatures are copied from the source of version X.Y.Z".

   Find every one with `grep -rn "<previous version>" apps docs packages --include=*.mdx --include=*.md --include=*.json --include=*.ts --include=*.tsx | grep -v node_modules`. What is left should be a deliberate baseline, such as a benchmark README that says which version it measured.
   If the public API changed, make sure `reference.mdx` shows it: its signatures are copied from the source.
4. **Write the release notes**: in `apps/docs/content/release-notes.mdx`, rename "Unreleased" to `## X.Y.Z` and open a new empty "Unreleased" above it (Changed, Added, Fixed). Say what a user must do to upgrade, and what moved. The `release-notes` check fails the pull request into `master` if the version changed and this heading is missing; `bun scripts/check-release-notes.ts origin/master` runs it here.
5. **Refresh and check**: `bun install` (updates the workspace versions in `bun.lock`), then `bun install --frozen-lockfile` and `bun run --cwd apps/docs build` must both pass, as CI will run them.
6. **Commit** the release notes, then the version, as `Version X.Y.Z`, on a branch from `staging` (`git switch -c release/X.Y.Z`): both branches are protected, so a direct push is refused. The body says what the release contains (see `git log --grep '^Version'`).
7. **Merge the release into `staging`, then `staging` into `master`**, and wait for CI on `master`:
   ```bash
   git push -u origin release/X.Y.Z
   gh pr create --fill --base staging && gh pr checks --watch   # `test` is required
   gh pr merge --merge --delete-branch                          # the owner may merge without a second reviewer
   git switch staging && git pull --ff-only
   gh pr create --base master --head staging --title "Release X.Y.Z" --fill
   gh pr checks --watch                                         # `test`, `source-branch` and `release-notes`
   gh pr merge --merge                                          # a merge commit; keep staging
   git switch master && git pull --ff-only && sleep 8           # let the run for the merge commit register
   id=$(gh run list --branch master --limit 1 --json databaseId -q '.[0].databaseId')
   until [ "$(gh run view $id --json status -q .status)" = completed ]; do sleep 20; done
   gh run view $id --json conclusion,jobs -q '"conclusion: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
   ```
   Use merge commits (not squash or rebase) so the commit that was checked is the one that is released, and `staging` stays an ancestor of `master`. **This merge is the release** if it sets a new version: the next step starts by itself. The `test` job typechecks and builds, runs the tests against SQLite, Postgres, Redis and S3, packs the tarballs and serves a full-stack app and a backend from them, then runs the Docker end-to-end scripts. On `master`, `engine-image` builds the image (it doesn't run for pull requests or `staging`). Both must be `success`.
8. **Watch the release**, which starts by itself when CI succeeds on the merge commit of `master`:
   ```bash
   sleep 20                                                  # the Release run starts when the CI run finishes
   id=$(gh run list --workflow Release --limit 1 --json databaseId -q '.[0].databaseId')
   until [ "$(gh run view $id --json status -q .status)" = completed ]; do sleep 20; done
   gh run view $id --json conclusion,jobs -q '"conclusion: \(.conclusion)", (.jobs[] | "  \(.name): \(.conclusion)")'
   ```
   `plan` checks the commit is on `master` with green CI and which packages npm lacks; `engine-image` builds and pushes `:X.Y.Z` (and `:latest` for a real release); `publish` runs `bun scripts/pack.ts --smoke` and publishes each tarball in `.pack/` with `npm publish --access public`, under `latest` (under `next` when the version contains a `-`), skipping a package npm already has; `tag` makes `vX.Y.Z` on the commit and the GitHub release from the release notes. `git pull --tags` brings the tag.
9. **Verify the registries.** A green workflow is not proof: npm can take a few minutes to show a version, so look with `--prefer-online` and retry.
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
10. **Redeploy the docs site**, so its samples, pages, release notes and `llms.txt` match the release (below). Then report what was published, with the commit, the tag and the image digest.

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

- **CI is red on a merge into `master`.** Nothing is released: the release needs a green run. Fix it through a pull request into `staging`, then into `master`; the version is still unpublished, so the release starts when CI passes on the fix.
- **The release workflow fails before npm** (`plan` refusing a commit or missing notes, the image build, the pack smoke test, a missing `NPM_TOKEN`: the failing step says so). Nothing is on npm and there is no tag to delete. Fix the cause: if it is a repository secret, `gh run rerun <id> --failed` is enough; if it is a commit, merge the fix the same way and the release runs again on it. The image job runs first, so `:X.Y.Z` and `:latest` on GHCR may already hold a build of the broken commit until the next run overwrites them; check the digest afterwards (step 9).
- **It fails while publishing to npm.** Some packages may be live and npm refuses to publish a version twice. Re-run the failed jobs (`gh run rerun <id> --failed`, or `gh workflow run Release` on the same head of `master`): the packages npm already has are skipped and the rest are published from the same commit, then the tag is made. Do not finish by hand. If the commit has to change, release the next patch (`X.Y.Z+1`, all packages) and, if the incomplete version could mislead anyone, `npm deprecate` it with a message.
- **A bad release is out.** It can't be unpublished safely: deprecate the version and release a patch.

## Known gaps

- **The release workflow has run end to end only in parts.** Its planning step (`scripts/release-plan.ts`) and the release-notes extraction were run against the real npm registry and the docs, and the workflow passes `actionlint`, but a full release has not been made with it yet: watch the first one (step 8).
- **The docs site isn't published by a workflow** (above).
