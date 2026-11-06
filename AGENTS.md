<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": true` in the root `turbo.json` or `turbo.jsonc` to opt in; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# Release notes

`apps/docs/content/release-notes.mdx`: every version, and "Unreleased", is a one-line summary of the release, then these `###` sections in this order, each only when it has an item:

- **Security**: a vulnerability fixed, or hardening that changes what an attacker can do, including a safer default (headers, CORS, a non-root image, pinned images).
- **Added**: what users can now do that they couldn't: a new API, option, command, page or built-in.
- **Changed**: existing behavior that now works differently: a default, a layout or output, a removal, performance. Anything a user must act on gets an indented `- **Upgrading:** …` item under its note.
- **Fixed**: a bug in a released version: what was wrong and what happens now. No "Fixed:" prefix; the heading says it.
- **Documentation**: docs pages and the agent skill.

One item per change, its lead in bold when a reader should notice it, with a link to its docs page. A pull request adds its item under the right heading, creating the heading in this order when it is missing, never a second heading of the same name. A fix to something that hasn't been released yet isn't "Fixed": it changes that feature's own item. `scripts/release-stamp.ts` moves the section as it is, so it must already read as the release's notes.

# Publishing a release

Full runbook: `docs/releasing.md`. Read it before releasing; this is the short version.

Publishing points: **npm** (nine packages, lockstep version), the **engine image** on GHCR (`ghcr.io/algochad/archlast-forge-engine:<version>` and `:latest`), and the **docs site** (Coolify, not in a workflow). `.github/workflows/release.yml` starts by itself when CI passes on a merge into `master` that ships something: it picks the version, pushes the image, publishes to npm (`NPM_TOKEN` secret), then tags the commit and writes the GitHub release.

- Publishing can't be taken back (npm never reuses a version). Release only when the user asks for it; a request to commit or push is not one.
- Merging into `master` IS the release when the merge ships something (it starts by itself once CI passes, with the next version), so merge only when the user asks for a release. Nobody tags or bumps by hand: the workflow does, after publishing.
- `master` and `staging` are protected: never push to either. Work on a branch from `staging` and open a pull request into `staging` (`CONTRIBUTING.md`); only `staging` is merged into `master`, and the engine image is built only when `master` is updated.

1. Land the change on `staging` by pull request (code, tests, docs, and a line under "Unreleased" in `apps/docs/content/release-notes.mdx` for what users notice, under its heading: "Release notes" above). `staging` and `master` are protected (rulesets: pull requests only, `test` must pass, no force pushes; `master` takes only `staging`).
2. `gh pr create --base master --head staging`, merge it with a merge commit (`gh pr merge --merge`; the owner can merge without a second reviewer). **That merge is the release**, if it ships something: when CI passes, `release.yml` picks the version from what changed since the last release (`scripts/release-plan.ts`, rules in `scripts/release-bump.ts`: a patch, or the next minor for a new export, CLI flag, engine setting or scaffolded file, or a `feat:`/breaking commit; none for docs-, workflow-, script- or test-only merges; the markers `[skip release]` and `[minor]` count only at the end of a commit's first line or on a line of their own), stamps it into the packages and the image **without committing it**, publishes the image and the nine packages, then makes the tag `vX.Y.Z` and the GitHub release. Nobody tags or bumps by hand: watch the Release run (`gh run list --workflow Release`). The repository's `package.json` keeps the line; the last release is the highest `v*` tag.
3. To choose the version yourself (a new minor by choice, 1.0.0, a pre-release): `bun scripts/version.ts X.Y.Z`, update the docs' version strings (grep the old one), `bun install`, rename "Unreleased" to `## X.Y.Z` in the release notes page, commit `Version X.Y.Z` with what the release contains in the body, and merge as above; a version above the last release goes out as it is (`docs/releasing.md`).
4. Verify, don't trust the green check: `npm view --prefer-online <package> version` for all nine (npm lags a few minutes), and the GHCR manifests for `X.Y.Z` and `latest` (same digest).
5. Redeploy the docs site in Coolify (the repo doesn't record whether it deploys on push: check, or tell the user).

A pre-release version (`-rc.1`) publishes under `next`, moves no `latest` (npm or image) and is a GitHub pre-release.

