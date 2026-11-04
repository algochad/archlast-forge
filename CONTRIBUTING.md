# Contributing

`master` and `staging` are protected: nothing is pushed to either, by anyone, except the release bot's commits of the release notes after a release ([docs/releasing.md](docs/releasing.md#the-release-bot)). Every change is a pull request, and **contributors open theirs into `staging`**.

1. Branch from `staging` (or fork the repository) and make the change, with its tests and, where it changes behavior, its docs (`apps/docs/content`), the agent skill (`skills/archlast-forge`; see CLAUDE.md) and a line under "Unreleased" in `apps/docs/content/release-notes.mdx`.
2. Open a pull request **into `staging`**. The `test` check of `.github/workflows/ci.yml` must pass; run what you can first (`bun run typecheck`, `bun run test`, `bun run skill:check`, `bun run --cwd apps/docs build`).
3. The owner reviews it (`.github/CODEOWNERS`): security, tests for the change, docs, fit with `docs/decisions.md` (the checklist is in [docs/releasing.md](docs/releasing.md#reviewing-a-pull-request)), and merges it into `staging`.
4. To release, the owner merges `staging` into `master`. That is when the engine image is built; if the merge ships something (not only docs, workflows, scripts or tests), the release then runs by itself after CI passes: the version is chosen from what changed (a patch, or a minor for a new export, flag or setting), and the image, the packages, the tag and the GitHub release follow. After publishing, the release moves the "Unreleased" notes under the new version on `master` and `staging` and redeploys the docs; nobody edits them by hand. `[skip release]` in a commit message skips it. Pull requests and `staging` never publish anything.

A pull request into `master` that isn't from this repository's `staging` fails the `source-branch` check. Force pushes to either branch and deleting them are blocked.

Report a security problem privately, as [SECURITY.md](SECURITY.md) says, not in a public issue or pull request.

## How the branches are protected

Two repository rulesets ("Protect master" and "Protect staging", under Settings > Rules) require a pull request with one approving review (from a code owner) and the checks above, and block force pushes and deletion. The repository owner can bypass them, but only through a pull request: not with a direct push. Releases use that path too (see [docs/releasing.md](docs/releasing.md)). `gh api repos/algochad/archlast-forge/rulesets` lists them.
