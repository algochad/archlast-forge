# Command: `upgrade [version]`

Moves a project to another archlast-forge release, reading what changed in between and applying it: the versions with `archlast-forge upgrade`, then the code changes the release notes call for, then the checks. Without a version, the latest. Example: `/archlast-forge upgrade 0.20.0`.

## 1. Before you change anything

1. The current version: `@archlast/forge-cli` in `package.json` (the monorepo root's apps all share it). The target: the argument, or `npm view @archlast/forge-cli version`.
2. **Read the release notes** for every version after the current one up to the target: the docs site's `release-notes` page (`https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/release-notes.mdx`). List each entry that touches this project: a changed default, a renamed option, a new required setting, a behavior a feature relies on, an engine image change (a project `Dockerfile` that adds to the image), a new built-in that replaces code the project wrote.
3. A clean tree (`git status`), and for a deployed app, a backup first (`archlast-forge backup before-upgrade.tar.gz`; ask before running it against production).

## 2. Steps

1. `archlast-forge upgrade <version>` at the project root (a monorepo: its root; every app moves together). It rewrites the versions in `package.json` and `forge/package.json`, the engine image tag in `Dockerfile` and `compose.yaml`, installs, and reruns codegen. Projects on 0.9.0 or older: `bunx --package @archlast/forge-cli@latest archlast-forge upgrade`. If `bun install` fails, the files are already changed: fix the install and rerun `bun install`.
2. Apply each release-note entry from step 1.2 that needs a change here, one at a time, by the house rules (a new built-in replaces homemade code only if the user agrees).
3. `bun run codegen && bun run typecheck && bun test`; in a full-stack app `archlast-forge build --no-docker` too.
4. Run [review.md](review.md) on what changed if the upgrade touched code.
5. Commit, `forge/_generated` included. Deploying is [deploy.md](deploy.md) (the image is rebuilt on the new engine by `up`).

## 3. Verify

- `git diff` shows every `@archlast/forge-*` dependency and the engine image tag at the same new version (they move in lockstep; a mismatch is a bug to fix).
- Typecheck, tests and the build pass; `bun run dev` starts without a new `✗` or warning in its first lines.
- Each release-note entry from step 1.2 is applied or explained.

## 4. Report

```
Upgrade: <from> → <to>
Release notes read: <versions>
  applied: … · not relevant here: … · needs a decision: …
Files: package.json, forge/package.json, Dockerfile, compose.yaml (+ code: …)
Checks: codegen · typecheck · tests · build · dev starts
Deploy with: `deploy` (backup first)
```

## 5. Stop and ask when

- a release note changes behavior users see (security headers, the docs page, a default turned on);
- a schema or data change is needed (plan it in steps: [operations.md](../operations.md) "Upgrades and deploying changes");
- the target is a downgrade, or a pre-release (`-rc`).

## Full documentation

| Page                                                                                                            | Read it for                                                    |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| [release-notes](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/release-notes.mdx) | what each version changed                                 |
| [cli](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/cli.mdx)               | `upgrade`: what it rewrites and how it fails                   |
| [migrations](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/migrations.mdx) | data changes a release or your schema needs                    |
