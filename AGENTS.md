<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Publishing a release

Full runbook: `docs/releasing.md`. Read it before releasing; this is the short version.

Publishing points: **npm** (nine packages, lockstep version), the **engine image** on GHCR (`ghcr.io/algochad/archlast-forge-engine:<version>` and `:latest`), and the **docs site** (Coolify, not in a workflow). A `v*` tag runs `.github/workflows/release.yml`, which pushes the image and then publishes to npm (`NPM_TOKEN` secret).

- Publishing can't be taken back (npm never reuses a version). Release only when the user asks for it; a request to commit or push is not one.
- Never tag before CI is green on the commit that gets the tag.
- `master` and `staging` are protected: never push to either. Work on a branch from `staging` and open a pull request into `staging` (`CONTRIBUTING.md`); only `staging` is merged into `master`, and the engine image is built only when `master` is updated.

1. Commit the change itself first (code, tests, docs).
2. `bun scripts/version.ts X.Y.Z` (use Bun 1.4.4; a patch for fixes, a minor for new public API). It only sets `packages/*/package.json`: also update the version in the docs' sample output, image tags, the `^X.Y.Z` example and the `reference.mdx` header (grep for the old version), and the API in `reference.mdx` if it changed.
3. `bun install`, then `bun install --frozen-lockfile` and `bun run --cwd apps/docs build` must pass. Commit as `Version X.Y.Z`, with what the release contains in the body.
4. `staging` and `master` are protected (rulesets: pull requests only, `test` must pass, no force pushes; `master` takes only `staging`). Put the release notes in `apps/docs/content/release-notes.mdx` ("Unreleased" becomes `## X.Y.Z`), commit them and `Version X.Y.Z` on `release/X.Y.Z`, `gh pr create --base staging`, `gh pr merge --merge --delete-branch` (the owner can merge without a second reviewer), then `gh pr create --base master --head staging`, merge it with a merge commit, `git switch master && git pull --ff-only`, wait for CI on that commit (`gh run view`; the `engine-image` build runs only here), then `git tag -a vX.Y.Z -m "Version X.Y.Z" && git push origin vX.Y.Z` and wait for the Release run.
5. Verify, don't trust the green check: `npm view --prefer-online <package> version` for all nine (npm lags a few minutes), and the GHCR manifests for `X.Y.Z` and `latest` (same digest).
6. Redeploy the docs site in Coolify (the repo doesn't record whether it deploys on push: check, or tell the user).

Known gap: a pre-release tag (`-rc.1`) publishes to npm under `next`, but the image job still moves GHCR `latest`. Don't cut one without changing the workflow.

