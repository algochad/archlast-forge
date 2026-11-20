# Releasing

Forge releases nine npm packages and the GHCR engine image at one version. GitHub Actions publishes the artifacts, tags the commit, creates the GitHub release, and updates the release notes and sample versions.

## Branches

Two branches are protected by rulesets (Settings > Rules): nothing is pushed to either, everything is a pull request.

| Branch | What it is | Takes pull requests from | Must pass |
| ------ | ---------- | ------------------------ | --------- |
| `staging` | where changes land and are reviewed; the default target for contributors | contributors' branches and forks, and the owner's `release/X.Y.Z` | the `test` job, and the owner's review |
| `master` | what is released from; the engine image is built when it is updated | `staging` only | the `test`, `source-branch` and (on a version change) `release-notes` jobs |

- **Contributors** branch from `staging` and open their pull request into `staging`. The owner reviews it there (see [Reviewing a pull request](#reviewing-a-pull-request)). Pull requests into `master` from anywhere but `staging` fail the `source-branch` check. (Until the `staging` branch exists the check passes, only for the pull request that introduces it; it needs GitHub to answer "no such branch" exactly, and fails on any other answer.)
- **Nothing publishes from `staging`.** The `engine-image` job of `ci.yml` runs only when `master` is updated (a push to `master`, which is a merge from `staging`), and it only builds the image and runs it. The image and the packages are published by `release.yml`, which starts by itself when CI passes on a merge into `master` that ships something (see [The release](#the-release)). Pull requests and `staging` can't overwrite the production image: they never push one.
- **The release notes move by themselves.** After publishing, the release workflow's `docs` job moves what was under "Unreleased" in `apps/docs/content/release-notes.mdx` under the new version and updates the version strings of the docs' samples, on `master` and on `staging`, and can call a deploy webhook ([the release bot](#the-release-bot)). Its pushes are the only ones either branch takes.
- The owner can bypass either ruleset, but only through a pull request.

## The publishing points

| Point | What | How it is published | Needs |
| ----- | ---- | ------------------- | ----- |
| git | `master` (by pull request: it is protected), and the tag `vX.Y.Z` | a merged PR; the tag is made by the release workflow, after the packages are published | the owner's account |
| npm | `@archlast/forge-runtime`, `-client`, `-react`, `-vue`, `-svelte`, `-framework`, `-dashboard`, `-cli`, and `create-archlast-forge` | the **publish** job of `.github/workflows/release.yml`, which starts by itself when CI passes on a merge into `master` that ships something | the `NPM_TOKEN` repository secret (a granular token with read and write on all packages, new names included) |
| GHCR | `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` and `:latest` | the **engine-image** job of the same workflow (`latest` moves only for a real release, not a pre-release); it runs first, because a new project's `archlast-forge up` pulls the image the moment the packages exist | `GITHUB_TOKEN` (automatic) |
| Docs site | `apps/docs`, built and served by Caddy | Coolify builds it on merges when configured (see [the docs site](#the-docs-site)). The **docs** job can also call a deploy webhook after a release | a Coolify build trigger, or `DOCS_DEPLOY_WEBHOOK` (and `DOCS_DEPLOY_TOKEN`) in the `release` environment |

The CLI pulls the engine image whose tag equals its own version, so the packages and the image must always be released together. Inside this repo the CLI builds the image itself if it is missing, which is why nothing breaks locally when they are out of step.

## Rules

- **Publishing can't be taken back, and merging starts it.** npm never lets a version be reused, and people may already have pulled an image tag. Every merge into `master` that ships something is a release, once CI passes. So merge into `master` only when the user asks for it, with the change reviewed on `staging`. A request to commit or push is not one. See [version selection and release markers](#the-release).
- **A release is only ever made from a commit of `master` with green CI.** The release workflow's first job, `plan`, refuses a commit that isn't reachable from `master` or has no successful CI run before anything is pushed. It also ends there for a merge that ships nothing (see below) and for a commit that was released already.
- **Nobody tags by hand, nobody bumps the version by hand for an ordinary release, and nobody moves the release notes.** The workflow picks the version, stamps it into the packages and the image, publishes, and only then makes the tag `vX.Y.Z` and the GitHub release, so a tag exists only for a release that happened. Then it moves the notes and the docs' version strings for a stable release.
- **Bun 1.4.4.** Check `bun --version` (mise installs it; see `mise.toml`). If `bun` on the PATH is older, call the mise binary: `~/.local/share/mise/installs/bun/1.4.4/bin/bun`.

## The release

`release.yml` evaluates the merge commit after its push CI on `master` succeeds. `scripts/release-plan.ts` inspects the diff and commit messages since the latest release tag reachable from that commit. `scripts/release-bump.ts` defines the rules below, and CI runs `scripts/release-bump.test.ts`.

| What changed since the last release | Release |
| ----------------------------------- | ------- |
| nothing a package or the engine image ships: only `apps/docs`, `docs`, `skills`, `.github`, `scripts`, tests, `bun.lock` | **none**: the run ends at `plan` |
| `[skip release]` in the commit range, unless the range also contains `[release]` | **none** |
| a fix, an internal change, a dependency: anything that ships and adds nothing to what users see | **patch**: `0.17.0` becomes `0.17.1` |
| a new or removed public export (the entry files of the packages, the top level of `packages/runtime/src`), a new CLI flag, a new engine setting, a new scaffolded file or package, a commit whose first line starts `feat:` or `type!:` (or has a `BREAKING CHANGE:` footer), or the marker `[minor]` | **minor**: `0.17.4` becomes `0.18.0` |
| the marker `[release]` | at least a patch, even if nothing shipped |
| `packages/*/package.json` above the last release (someone ran `scripts/version.ts`) | **that version**, as it is: for 0.18.0 by choice, or 1.0.0 |

- **Markers** (`[skip release]`, `[release]`, `[minor]`) count at the end of a commit's first line (`Fix a thing [skip release]`, which is what a squash or the PR title gives) or on a line of their own. Written mid-sentence or in `code`, as in this page, they do nothing, so a message can explain them without acting on them. `feat:` counts only at the start of a first line.
- **The version is not committed.** The repository's `package.json` keeps the line (`0.17.0`), the workflow works out `0.17.3` from the tags, stamps it into the packages and the image, and the tag `v0.17.3` records it. So the version in the repository can be behind the published one: the last release is the highest `v*` tag (`git tag --list 'v*'`) or `npm view @archlast/forge-runtime version`.
- **A retry before tagging uses the same commit and version.** The workflow skips npm versions it already published and can rebuild the image from the same commit.
- **The notes:** the GitHub release gets the `## X.Y.Z` section of the release notes page when a person wrote one (a release whose version they set), else what is under "Unreleased" in the released commit, else (nothing was noted) the subjects of the commits since the last release; each with a link to the comparison (`scripts/release-notes-section.ts`). Write the lines under "Unreleased" as each change lands; the release files them under its version.
- A pre-release (`0.18.0-rc.1`, set with `scripts/version.ts`) publishes under `next`, moves no `latest` (npm or image) and is a GitHub pre-release.

## Steps

Merge into `master` only when the user explicitly asks to release Forge, and limit the promotion to the authorized change set. Use a single `staging` → `master` PR when the user asks for one release covering several changes.

### 1. Prepare and land the complete change set

Run the commands from the Forge checkout. Check the current branch, local changes, remote refs, release tags, GitHub authentication, and Bun version. Reuse an existing PR when it already carries the right changes. Work on a branch based on current `origin/staging` and preserve unrelated local work, using a separate worktree when needed.

```bash
git status --short --branch
git remote get-url origin
git fetch origin master staging --tags
gh auth status
gh repo view --json nameWithOwner,viewerPermission
gh pr list --base staging
gh pr list --base master --head staging
bun --version
```

Review the commits, tests, docs, and the one-line summary and entries under **Unreleased**. Use [the review checklist](#reviewing-a-pull-request). Push the feature branch and open or update its PR into `staging`. If the changes are already on `staging`, confirm their presence there and proceed to the promotion PR.

For each feature PR, save its number and head SHA from GitHub. Wait for its GitHub `test` check to pass before merging. Inspect the per-check results if the PR has results from multiple events. Match the verified head SHA when merging so an edit after CI cannot enter the release.

```bash
# Set feature_pr to the feature PR number.
feature_head=$(gh pr view "$feature_pr" --json headRefOid --jq .headRefOid)
gh pr checks "$feature_pr" --watch --interval 20
gh pr checks "$feature_pr" --json name,bucket,event,link
```

After the PR's `test` check passes for that head, merge it.

```bash
gh pr merge "$feature_pr" --merge --match-head-commit "$feature_head"
```

If the user authorized owner bypass and review requirements still block the merge, add `--admin` after the required CI checks pass. A failed required check blocks the merge even when the owner can bypass it. Keep both protected branches. The release bot handles their post-release docs pushes.

### 2. Promote the verified staging commit

Fetch both branches again. Review `origin/master..origin/staging` and the combined diff to confirm the promotion contains the requested fixes and features together. Account for the previous release bot's docs commit. Resolve any unexpected shipped changes with the user before promoting them. Capture the `staging` SHA and follow its push CI by commit. Open the single release PR while that run is in progress. Prepare `release_pr_body` as a Markdown file listing the included changes, or reuse the existing promotion PR and its number.

```bash
git fetch origin master staging --tags
git log --oneline origin/master..origin/staging
git diff origin/master...origin/staging
staging_head=$(git rev-parse origin/staging)
reviewed_master=$(git rev-parse origin/master)
gh run list --workflow ci.yml --event push --commit "$staging_head" \
  --json databaseId,headSha,status,conclusion,url
gh pr create --base master --head staging --title "Release Forge" --body-file "$release_pr_body"
```

Confirm the promotion PR's head matches the reviewed `staging_head`. Wait for the `staging` push CI and the release PR's `test`, `source-branch`, and `release-notes` checks to pass.

The planner inspects every commit message since the preceding tag. The previous release bot's docs commit contains `[skip release]`, which can suppress the new release even when this merge ships code. Use `[release]` at the end of the authorized promotion merge's subject or on its own line in the merge body. It overrides the inherited marker while leaving the version choice to the planner. Apply it only when the user has authorized publication. An ordinary docs-only merge needs no marker.

```bash
# Set staging_run and release_pr from the GitHub results above.
gh run watch "$staging_run" --exit-status --interval 20
gh pr checks "$release_pr" --watch --interval 20
gh pr checks "$release_pr" --json name,bucket,event,link
gh pr view "$release_pr" --json baseRefOid,headRefOid
```

Once both runs pass, compare the current base and head SHAs with `reviewed_master` and `staging_head`. If either changed, review the diff and checks again before merging. Add `--admin` only under the same owner authorization and green-CI rule as above.

```bash
gh pr merge "$release_pr" --merge --match-head-commit "$staging_head" --subject 'Release Forge [release]'
```

If asked to preview the version, run `bun scripts/release-plan.ts` in a checkout of the intended release tree. A skip result on raw `staging` can reflect that inherited marker. To preview the effect of the promotion before merging, use a local merge object with the marker and pass its SHA to the same script. This creates no branch or tag.

```bash
release_tree=$(git merge-tree --write-tree origin/master "$staging_head")
preview_sha=$(git commit-tree "$release_tree" -p origin/master -p "$staging_head" -m 'Preview Forge release [release]')
bun scripts/release-plan.ts --sha "$preview_sha"
```

### 3. Watch master CI and the Release workflow

Get the merge commit from the release PR after it shows **Merged**. Use the merge SHA for every lookup to avoid picking a previous release, a PR test merge, or the later docs bot commit.

```bash
master_sha=$(gh pr view "$release_pr" --json mergeCommit --jq .mergeCommit.oid)
gh run list --workflow ci.yml --event push --commit "$master_sha" \
  --json databaseId,headSha,status,conclusion,url
# Set master_run to the matching push CI run once it appears.
gh run watch "$master_run" --exit-status --interval 20
gh run list --workflow release.yml --commit "$master_sha" \
  --json databaseId,headSha,status,conclusion,url
# Set release_run to the new Release run for this commit.
gh run watch "$release_run" --exit-status --interval 20
gh run view "$release_run" --json status,conclusion,jobs \
  --jq '.jobs[] | [.name, .conclusion] | @tsv'
```

Wait for each run to appear and reach a terminal state. In an agent session, poll at short intervals so user messages can steer the task. A green PR does not replace the push CI on `master`. A failed push CI can create a skipped Release run. After a successful retry, watch the new Release run. If a fresh Release run for that SHA is still missing after a brief delay, confirm `master` still points to the verified merge SHA and use `gh workflow run release.yml --ref master`. Keep following the same release candidate.

The jobs run in order. `plan` establishes the commit and version. `engine-image` publishes GHCR. `publish` packs, smoke-tests, and publishes to npm. `tag` creates the Git tag and GitHub release. For a stable release, `docs` stamps the notes and examples on both branches and may call the Coolify webhook. Inspect individual jobs if the overall Release run fails. A docs webhook failure after successful publishing and tagging does not require another package release. See [When it goes wrong](#when-it-goes-wrong).

### 4. Verify the published artifacts

Use the workflow's actual version. Fetch the tag and confirm it resolves to `master_sha` and contains every requested commit. Check the GitHub release's tag, notes, and pre-release setting.

```bash
# Set version to the workflow's version and master_sha from the merged PR.
git fetch origin --tags
test "$(git rev-parse "v${version}^{commit}")" = "$master_sha"
gh release view "v$version" --json tagName,url,isDraft,isPrerelease,body
```

Check all nine names in [the publishing table](#the-publishing-points). The publish job can succeed several minutes before npm's public reads return the same version for every package. Retry `npm view --prefer-online` for packages still showing the previous version or a temporary 404.

```bash
channel=latest # Set next for a pre-release.
packages=(
  @archlast/forge-runtime @archlast/forge-client @archlast/forge-react
  @archlast/forge-vue @archlast/forge-svelte @archlast/forge-framework
  @archlast/forge-dashboard @archlast/forge-cli create-archlast-forge
)
ready=true
for package in "${packages[@]}"; do
  actual=$(npm view --prefer-online --loglevel=error --registry https://registry.npmjs.org "$package@$channel" version) || actual=unavailable
  printf '%s %s\n' "$package" "$actual"
  if [ "$actual" != "$version" ]; then ready=false; fi
done
"$ready"
```

Check GHCR's version tag and record its digest. Stable releases must also have that same digest under `latest`. For a pre-release, check the version tag and the previous stable `latest` if captured before publication. Keep the short-lived pull token out of output.

```bash
image=algochad/archlast-forge-engine
ghcr_token=$(curl -fsS "https://ghcr.io/token?service=ghcr.io&scope=repository:$image:pull" |
  bun -e 'console.log(JSON.parse(await Bun.stdin.text()).token)')
manifest_digest() {
  curl -fsSI -H "Authorization: Bearer $ghcr_token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "https://ghcr.io/v2/$image/manifests/$1" |
    awk 'tolower($1) == "docker-content-digest:" {gsub(/\r/, "", $2); print $2}'
}
version_digest=$(manifest_digest "$version")
printf '%s %s\n' "$version" "$version_digest"
test -n "$version_digest" && {
  if [ "$channel" = latest ]; then
    latest_digest=$(manifest_digest latest)
    printf 'latest %s\n' "$latest_digest"
    test "$version_digest" = "$latest_digest"
  fi
}
```

### 5. Finish and report

Verify the release bot's notes commit on both branches for a stable release. Handle the live site as described in [The docs site](#the-docs-site). When Coolify deploys on merges or the user excludes that step, leave the deployment to the existing trigger.

Report the included changes, the GitHub release and PR links, the tagged commit, the npm version verified for all nine packages, and the GHCR digest. Flag any job or artifact that is still pending. Keep the release together through retries by staying on the same commit until a code fix genuinely requires a new one.

### Choosing the version yourself

For a new minor line by choice (0.18.0), 1.0.0 or a pre-release, set the version in a pull request, and that exact version is released:

1. **Set the version**: `bun scripts/version.ts X.Y.Z`. It sets `version` in every `packages/*/package.json` and nothing else.
2. **Update the version strings it doesn't touch**, all under `apps/docs/content`:
   - the banner in sample output, `archlast-forge X.Y.Z  ·` (`backend`, `cli`, `framework`, `getting-started`, `tutorial`);
   - the engine image tag, `ghcr.io/algochad/archlast-forge-engine:X.Y.Z` (`backend`, `troubleshooting`, `cli`);
   - the example range `"@archlast/forge-runtime": "^X.Y.Z"` (`functions`);
   - the header of `reference`, "Signatures are copied from the source of version X.Y.Z".

   Find every one with `grep -rn "<previous version>" apps docs packages --include=*.mdx --include=*.md --include=*.json --include=*.ts --include=*.tsx | grep -v node_modules`. What is left should be a deliberate baseline, such as a benchmark README that says which version it measured. If the public API changed, make sure `reference.mdx` shows it: its signatures are copied from the source.
   `bun scripts/release-stamp.ts X.Y.Z --since v<last release>` moves the four of them, and does step 3's renaming.
3. **Write the release notes**: in `apps/docs/content/release-notes.mdx`, rename "Unreleased" to `## X.Y.Z` and open a new empty "Unreleased" above it (`release-stamp.ts` does this; the release would do it afterwards too, but a version set by hand is checked for its heading before it merges). Say what a user must do to upgrade, and what moved. The `release-notes` check fails the pull request into `master` if the version changed and this heading is missing; `bun scripts/check-release-notes.ts origin/master` runs it here.
4. **Refresh and check**: `bun install` (updates the workspace versions in `bun.lock`), then `bun install --frozen-lockfile` and `bun run --cwd apps/docs build` must both pass, as CI will run them. `bun scripts/release-plan.ts` shows what the workflow will do with it.
5. **Commit** as `Version X.Y.Z` (the body says what the release contains), on a branch from `staging` (`git switch -c release/X.Y.Z`), `gh pr create --base staging`, merge it, then merge `staging` into `master` as in the steps above.

## The release bot

The `docs` job of `release.yml` pushes to the protected `master` and `staging` with an SSH deploy key, which both rulesets let through (deploy keys are a bypass actor). The private key is `RELEASE_BOT_KEY` in the `release` environment, which only runs on `master` may use: a pull request's workflow, from a fork or from a branch here, can't read it. Without it the job warns and the notes stay under "Unreleased".

- **Set it up once** as the owner, with `gh` signed in: `bun scripts/setup-release-bot.ts` (a new key, the deploy key with write access, the environment and its secret, the rulesets' bypass). Add `--docs-webhook <url> [--docs-token <token>]` for Coolify's deploy webhook (the docs resource's Webhooks tab, and an API token), so the release redeploys the docs site too. Running it again replaces the key.
- **What it writes:** on `master`, `bun scripts/release-stamp.ts X.Y.Z --since vA.B.C --released <the page in the released commit>` (the notes under "Unreleased" move under `## X.Y.Z`, the samples' version strings move), committed and pushed. On `staging`, a merge of that commit whose files are `staging`'s (`git merge -s ours`), stamped the same way: only the lines that were released move, so notes that landed after the release stay under "Unreleased", and the next merge of `staging` into `master` has nothing to conflict on. This relies on `master` only ever having `staging`'s changes and these commits, which the `source-branch` check keeps true.
- **A page that already has `## X.Y.Z`** (a version a person set) keeps its notes; only the version strings move. Running the job again changes nothing.
- Any other deploy key with write access could push to the two branches too: the repository has none, and should keep it that way.

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

Coolify can deploy on pushes to `master`. The release workflow can also request a deployment through `DOCS_DEPLOY_WEBHOOK`. Use the merge-driven deployment when configured. If live verification is in scope, check the site or the Coolify deployment for the stamped docs commit. Trigger a manual deployment only if it is needed for the requested release and the target project is known. If the user excludes the docs deployment, report the package release independently.

## When it goes wrong

- **PR CI or push CI fails.** Use `gh run view RUN_ID --log-failed` and inspect the failing job, keeping credentials out of logs and replies. Retry a transient failure with `gh run rerun RUN_ID --failed` on the same commit, then wait for the new attempt. Fix a reproducible failure on a branch and go through the normal PRs again. Keep the version and change set together. A failed push CI on `master` cannot publish.
- **Release stops at `plan`.** Inspect the job log for the evaluated SHA, version, and skip reason. When CI failed, recover CI first. When the intended promotion was skipped because of an inherited marker, use an authorized promotion with `[release]` through the normal branch flow.
- **The image build or npm publish job fails.** Inspect the first failing step and check what reached GHCR and npm. Retry a recoverable failure through GitHub Actions on the same commit. Before a tag exists, a retry of the Release workflow skips npm versions it already published. Avoid publishing individual packages by hand. If code must change after a partial npm publish, coordinate the next lockstep version because npm will refuse to reuse a published version.
- **npm still reports an old version after publishing.** Check the publish job's per-package receipts and retry the public registry reads. A lagging read alone is insufficient reason to publish a new version. Report any persistent mismatch with the affected package and the verified artifacts.
- **Only the docs job fails.** Check whether release notes stamping or the Coolify webhook failed. If only the webhook failed, verify npm, GHCR, and the GitHub tag normally. Follow the user's deployment scope. A missing release bot key requires owner setup if notes stamping is required.
- **A bad release is already live.** Coordinate a patch release. Deprecating an npm version is a separate action for the owner when necessary.
