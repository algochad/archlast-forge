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

Read [the release runbook](docs/releasing.md) when the user explicitly asks to publish Forge. Follow it through GitHub CI, publication, and registry verification.

- Land the requested changes together on `staging` by PR, then promote the reviewed `staging` SHA to `master` in one merge commit. Push only feature branches. Match the verified head SHA at merge time.
- Wait for GitHub CI on both PRs and for push CI after the merges. Use `--admin` only with the user's authorization and green required checks. Diagnose failures and retry transient jobs on the same SHA.
- Put `[release]` on the authorized promotion merge to override the previous release bot's inherited `[skip release]`. GitHub Actions chooses the version, publishes GHCR and all nine npm packages, creates the tag and release, and stamps the notes.
- Watch the Release run for the specific `master` merge SHA until it finishes. Independently verify the GitHub tag, all nine npm versions, and the matching stable GHCR digests. Let configured Coolify deployment run on merges, and respect the user's deployment scope.
