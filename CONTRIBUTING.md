# Contributing

`master` is protected: nothing is pushed to it directly, by anyone. Every change is a pull request.

1. Branch from `master` (or fork the repository) and make the change, with its tests and, where it changes behavior, its docs (`apps/docs/content`) and the agent skill (`skills/archlast-forge`; see CLAUDE.md).
2. Open a pull request. The `test` and `engine-image` checks of `.github/workflows/ci.yml` must pass; run what you can first (`bun run typecheck`, `bun run test`, `bun run skill:check`, `bun run --cwd apps/docs build`).
3. The owner reviews it (`.github/CODEOWNERS`) and merges it. Force pushes to `master` and deleting it are blocked.

Report a security problem privately, as [SECURITY.md](SECURITY.md) says, not in a public issue or pull request.

## How `master` is protected

A repository ruleset, "Protect master", requires a pull request with one approving review (from a code owner), the `test` and `engine-image` checks, and blocks force pushes and deletion. The repository owner can bypass it, but only through a pull request: not with a direct push. Releases use that path too (see [docs/releasing.md](docs/releasing.md)). Settings > Rules > Rulesets shows it; `gh api repos/algochad/archlast-forge/rulesets` lists it.
