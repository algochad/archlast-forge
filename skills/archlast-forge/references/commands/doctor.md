# Command: `doctor [symptom]`

Diagnoses a project that doesn't work: it checks the tools, the project's shape, the dependencies, codegen, the types and the running engine in order, stops at the first real problem, and names the fix. Give the symptom if there is one (`/archlast-forge doctor "dev says Unknown function"`, `/archlast-forge doctor "the stack didn't become healthy"`).

## 1. If there is a symptom

Look it up first in [operations.md](../operations.md) "Troubleshooting digest" and its "Startup checks" table, and in the `troubleshooting` docs page. A message that matches names its cause and fix: confirm the cause with one command (below), then go to section 3. No match, or the fix didn't hold: run every step of section 2.

## 2. The checks, in order

Stop at the first failure and diagnose it before going on: later checks often fail only because of it.

| # | Check | Command | Healthy |
| - | ----- | ------- | ------- |
| 1 | Bun | `bun --version` | 1.4.4 or newer |
| 2 | Docker (only if the project uses it: services in `archlast-forge.json`, or `dev` without `--no-docker` on a backend) | `docker info --format '{{.ServerVersion}}'` | a version, no error |
| 3 | The project | `cat archlast-forge.json` (and `archlast-forge.workspace.json` at a monorepo root) | valid JSON, `mode` and `services` as the reference says |
| 4 | One version everywhere | `grep -rhoE "@archlast/forge-[a-z]+\": \"[^\"]+\"" package.json forge/package.json; grep -hoE "archlast-forge-engine:[^\" }]+" Dockerfile compose.yaml` | every package and the engine image on the same version |
| 5 | Dependencies | `bun install` at the root, then `bun install --cwd forge` | no error; `forge/node_modules` exists |
| 6 | Codegen | `bun run codegen` | `✓ wrote forge/_generated`; an error names the file that failed to load |
| 7 | Types | `bun run typecheck` | no error |
| 8 | The engine starts | `bun run dev` (or `archlast-forge logs app` for a stack) and read the first 30 lines | `✓ archlast-forge …`, no `✗` line |
| 9 | It serves | `curl -s localhost:<port>/ready` | `{"ready":true}`; otherwise its `error` is the load failure |
| 10 | Environment | compare `.env` with `.env.example` and with the `:?missing` variables in `compose.yaml` (names only, never print values) | nothing required is missing |

For a stack: `archlast-forge status` (which containers run), `archlast-forge logs app` (the first `✗`), and for a dependency container `archlast-forge logs postgres` (or the service). Postgres connection trouble: the `Postgres connections:` line at start. A client error `Server error (request <id>)`: search the logs for that id.

## 3. Fix

- Name the cause in one sentence and the fix as a command or an edit.
- Apply fixes that are local and safe (install, codegen, a missing `.env` key in development, a code error) and re-run the failed check, then the rest.
- **Ask first** for anything that touches data, deployed systems or secrets: `down --volumes`, `restore`, `migrate --run`, `SCHEMA_CHECK=off`, changing `BETTER_AUTH_SECRET` (signs everyone out), editing production `.env`.

## 4. Report

```
Doctor: <symptom or "full check">
| # | Check | Result |
| 1 | Bun 1.4.4 | ok |
| 6 | Codegen | ✗ forge/invoices.ts imports "stripe", which is not installed |
Cause: stripe is in the root package.json, not forge/package.json
Fixed: bun add --cwd forge stripe → codegen ok → typecheck ok → dev starts
Left for you: … (needs a decision or access you didn't give)
```

## Full documentation

| Page                                                                                                                  | Read it for                                     |
| --------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [troubleshooting](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/troubleshooting.mdx) | every message and symptom, with its fix     |
| [configuration](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/configuration.mdx)     | what each variable does and its default     |
| [cli](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/cli.mdx)                         | each command's messages and exit codes      |
