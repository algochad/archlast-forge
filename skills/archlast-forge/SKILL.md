---
name: archlast-forge
description: Build applications with archlast-forge, a self-hosted reactive TypeScript backend on Bun (schema, queries, mutations, actions, live queries, Better Auth, NestJS services and controllers, Forge RPC). Use when a project has archlast-forge.json, a forge/ folder with schema.ts, or @archlast/forge-* dependencies, or when asked to create or extend a full-stack app, a backend, a monorepo or a microservices mesh with archlast-forge. Covers project modes, the forge/ folder layout (_modules, _services), service classes and Nest modules, Forge RPC between services, data and functions, auth, storage, scheduling, clients, tests, CLI and deployment.
---

# archlast-forge

archlast-forge is a Convex-style backend you self-host: you declare a schema and functions in `forge/`, clients call them with end-to-end types, and live queries push new results when the data they read changes. NestJS runs inside the engine for services, controllers, gateways and GraphQL. It runs on Bun with SQLite or Postgres.

This skill is the map. Read the reference file for the task before writing code; they hold the exact APIs and the mistakes to avoid. If a reference and the project's own code disagree, trust the code and tell the user.

## 1. Orient first (before writing anything)

1. Find the mode: `archlast-forge.json` (`"mode": "framework"` = full-stack app with `app/`, `"backend"` = no pages; no file = a backend with no services). `archlast-forge.workspace.json` at a root with `apps/` and `packages/` = monorepo (each app has its own `archlast-forge.json`; `main` names the main app).
2. Read `forge/schema.ts`, `forge/http.ts`, the list of `forge/*.ts`, and `forge/_modules/` if it exists. Match the conventions already there.
3. Read `archlast-forge.json`'s `services` (postgres, redis, s3, caddy) and `.env.example`: what exists in production decides what you may use (S3 storage, Redis cache).
4. Use the project's scripts: `bun run dev`, `codegen`, `typecheck`, `format`. Bun only (the repo pins its version in `package.json` `packageManager`).

Starting from nothing: `bun create archlast-forge my-app` (full-stack), `--mode backend`, `--monorepo`, `--microservices orders,billing`, `--yes` to skip questions. See [project modes](references/project-modes.md) to choose.

## 2. The model in six lines

- **Functions** are the API: `query` (read, reactive), `mutation` (write, one transaction), `action` (I/O: `fetch`, RPC, storage; at-most-once, no retries), plus `internalQuery`/`internalMutation`/`internalAction` that clients can never call. Arguments are validated with `v`.
- **Reactivity:** a query's reads become topics; a committed mutation publishes topics; subscribed queries re-run. So reads go through `ctx.db` in queries, and writes through mutations only.
- **Codegen** (`archlast-forge codegen`, run by `dev`, `typecheck`, `build`) writes `forge/_generated` (`api`, `internal`, `dataModel`, and `rpc` when there are Forge RPC routers). Commit it. Never edit it.
- **Frontend code (`app/` in a full-stack app, `src/` in a separate frontend) may import only from `forge/_generated`.** Anything else from `forge/` would put server code in the browser bundle; codegen fails on it.
- **Errors:** only `ForgeError` and argument-validation errors reach callers. Everything else becomes "Server error (request id)" outside dev. Throw `ForgeError` for errors a caller should handle.
- **Storage:** documents are JSON with an `_id` and `_creationTime`; schema changes need no table migration (data changes use `archlast-forge migrate`). `users` and Better Auth tables are built in.

## 3. Where code goes: the clean `forge/`

```
forge/
  schema.ts  auth.ts  crons.ts  http.ts   special modules (tables, Better Auth, cron jobs, nest() + http routes)
  <feature>.ts                            functions for api.<feature>.*  (thin: validate, inject a service, call it)
  <name>.router.ts                        Forge RPC routers (top level, never under an underscore folder)
  _modules/index.ts + _modules/<feature>/ Nest code: <feature>.module.ts, .service.ts, .controller.ts, .gateway.ts, .resolver.ts
  _lib/                                   plain helpers, no Nest
  _services.ts                            monorepo main app only: CLI-written list of remote services. Do not edit
  _generated/                             codegen output. Do not edit
```

Any file or folder name starting with `_` is ignored by the function scanner, codegen and the client router. Every other `.ts` file is a function module whose path becomes `api.<path>`, so Nest classes never live at the top level. Full rules and examples: [services, modules and controllers](references/nest-services.md).

## 4. Rules that are always true

1. Writes go through mutations (transactional, reactive). A controller, gateway or action gets an `ActionCtx` with no `db`: it calls `ctx.runQuery` / `ctx.runMutation`.
2. Queries and mutations do no I/O (no `fetch`, no RPC, no storage writes). A query must be a pure function of its arguments, the caller and the database: `Date.now()`, `Math.random()` and `process.env` are not tracked and results are cached, so pass time as a rounded argument. Do I/O in actions ([data and functions](references/data-and-functions.md)).
3. Services that need the call's `ctx` extend `ForgeService<QueryCtx | MutationCtx | ActionCtx>` and are fetched with `inject(ctx, Service)`; ctx-free helpers are singleton `@Injectable()` classes. Import service classes as values, not `import type`.
4. `nest()` is called once, in `forge/http.ts`. Nest imports come only from `@archlast/forge-runtime/nest` (and `/nest/websockets|graphql|microservices|rpc`); never install or import `@nestjs/*`.
5. Forge RPC is backend to backend only. Frontends call the main app; the main app calls services through one service class per service. `FORGE_RPC_TOKEN` never reaches a client.
6. Auth is Better Auth through `forge/auth.ts` and `ctx.auth`; check the caller inside every function that is not public. Use `internal*` for what clients must not call.
7. Validate every argument with `v` and give public functions a `returns` validator when other code depends on the shape.
8. After changing functions, schema, routers or `_modules`: run `bun run codegen`, then `bun run typecheck`. Run the tests. Run `bun run format` (projects use 4-space Prettier).
9. Prefer the CLI over hand edits for structure: `archlast-forge add service|app|mobile|desktop`, `remove`, `workspace sync`, `upgrade`. Do not hand-edit `_generated`, `_services.ts`, `packages/api`, `packages/contracts`, `.env` secrets.
10. Never commit `.env`. Never log or return secrets, the admin key or `FORGE_RPC_TOKEN`.

## 5. Task routing: read before you write

| Task                                                                                                                                                   | Read                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| Create a project; choose full-stack vs backend vs monorepo vs microservices; add/remove an app or service; workspace files                             | [project-modes.md](references/project-modes.md)                             |
| Which files `init` writes and what each is for (`compose.yaml`, `Dockerfile`, `.env`, stack services, shadcn, mobile, desktop); adding a stack service | [scaffolding.md](references/scaffolding.md)                                 |
| Any `archlast-forge` command: flags, defaults, what it writes, data commands (migrate, export, import, backup, restore, env, admin), upgrade           | [cli.md](references/cli.md)                                                 |
| Service classes, Nest modules, controllers, guards, gateways, GraphQL, folder layout of `forge/`                                                       | [nest-services.md](references/nest-services.md)                             |
| One backend calling another; microservice mesh; `@Router`; `packages/contracts`                                                                        | [forge-rpc.md](references/forge-rpc.md)                                     |
| Tables, validators, indexes, queries, mutations, actions, pagination, errors, migrations                                                               | [data-and-functions.md](references/data-and-functions.md)                   |
| Sign-in, roles, files and uploads, scheduler and crons, HTTP routes, OpenAPI, limits                                                                   | [server-features.md](references/server-features.md)                         |
| Pages, routes, loaders, live data in components, hydration, styling (full-stack app)                                                                   | [fullstack.md](references/fullstack.md)                                     |
| Calling the backend from a separate frontend, React/Vue/Svelte bindings, mobile, desktop                                                               | [clients.md](references/clients.md)                                         |
| Writing tests for functions and services                                                                                                               | [testing.md](references/testing.md)                                         |
| Environment variables and settings, Docker, deployment, scaling, backups, upgrades, troubleshooting                                                    | [operations.md](references/operations.md)                                   |
| The admin dashboard, accounts and roles, traces, issues, SLOs, alerts, custom spans and metrics, debugging a slow or failing function                  | [dashboard-and-observability.md](references/dashboard-and-observability.md) |

For anything not covered, the documentation site is the full reference: its `/llms.txt` lists every page and `/<page>.md` is each page as Markdown (the pages are also in `apps/docs/content` of the archlast-forge repository).

## Going deeper: the documentation

The references are the short version. The documentation is the full one, and each reference ends with a **Full documentation** table of the pages for its subject. Read the page instead of guessing when an option, flag or signature is not in the reference, when behavior surprises you, or when you need the cause of an error message.

Where to read a page (`<page>` is its name, such as `nest`):

1. **The docs site**, when the user or the project gives its address: `<site>/<page>.md` is the page as Markdown. `<site>/llms.txt` indexes every page with a line about each and a start-here list by task; `<site>/llms-full.txt` is everything, `<site>/llms-<section>.txt` one section; asking a page's own address with `Accept: text/markdown` also returns Markdown. Each Markdown page links to the previous and next page, so you can walk from one to the next.
2. **The repository**, always: `https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/<page>.mdx` (or `apps/docs/content/<page>.mdx` in a checkout of archlast-forge).

Page names: introduction, concepts, getting-started, tutorial, framework, backend, monorepo, schema, functions, queries, reactivity, caching, errors, migrations, auth, storage, scheduling, http, nest, forge-rpc, api-docs, clients, mobile, desktop, testing, recipes, agent-skill, cli, deployment, configuration, dashboard, backups, observability, limits, reference, troubleshooting, release-notes.

For an exact signature read `reference`; for a message or symptom read `troubleshooting`; for the engine's variables read `configuration`; for a command read `cli`.

## 6. Workflows

**New feature in any app** (a notes feature, say):

1. Table in `forge/schema.ts` with the indexes your queries need (`.index("by_author", ["authorId"])`).
2. `forge/_modules/notes/notes.service.ts`: `NotesReader extends ForgeService<QueryCtx>`, `NotesWriter extends ForgeService<MutationCtx>`; shared logic in singletons.
3. `forge/notes.ts`: `query`/`mutation` with `args` validators; each handler `inject(ctx, …)` and calls one method.
4. If outside clients need REST: `notes.controller.ts` calling `api.notes.*` through `ctx.runQuery/runMutation`, with `@Contract`; `notes.module.ts` listing the providers and controller; add the module to `_modules/index.ts`; `forge/http.ts` mounts `nest(http, { imports: appModules })`.
5. Codegen, typecheck, a test with `createTestBackend`, format.
6. Frontend: `useQuery(api.notes.recent)` (React) or the client's `subscribe`; see [fullstack.md](references/fullstack.md) or [clients.md](references/clients.md).

**New microservice in a monorepo:** `archlast-forge add service billing` (it writes the service app, the main app's `billing.service.ts`, controller and action, the contracts and the token). Then in `apps/billing/forge/`: tables, internal functions that own the data, procedures in `billing.router.ts` with `input`/`output` schemas, `ctx.runMutation(internal.…)` inside them. Codegen in both apps, `bun run typecheck` at the root. Add domain methods to the main app's `BillingService`. See [forge-rpc.md](references/forge-rpc.md).

**Turn an app into a monorepo:** `archlast-forge monorepo --microservices orders --yes` (in place; `--dry-run` first).

**Add a service-to-service call (mesh):** hand-wire a client class in the calling service as described in [forge-rpc.md](references/forge-rpc.md); keep the call graph acyclic and each service's data private.

## CLI cheat sheet (full reference: [cli.md](references/cli.md))

| Goal                          | Command                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New project (non-interactive) | `bun create archlast-forge <dir> [--mode framework\|backend] [--services …\|none] [--monorepo] [--microservices a,b] [--mobile] [--desktop full\|client] --yes` |
| Run in development            | `bun run dev` (`archlast-forge dev`; add `-- --no-docker` to run the engine in-process)                                                                         |
| Regenerate types              | `bun run codegen` (also run by `dev`, `typecheck`, `build`)                                                                                                     |
| Production stack              | `bun run up` / `down` / `logs` (Docker Compose)                                                                                                                 |
| Production without Docker     | `archlast-forge build --no-docker` then `start --no-docker`                                                                                                     |
| Add / remove stack services   | `archlast-forge stack add\|remove postgres,redis,s3,caddy`                                                                                                      |
| Monorepo changes              | `archlast-forge monorepo`, `add service\|app\|mobile\|desktop`, `remove <name>`, `workspace [sync]`                                                             |
| Data                          | `migrate`, `export`, `import`, `backup`, `restore`, `env`, `admin` (run inside the running server through `/_cli`, or open the database when no server runs)    |
| Move to a new release         | `archlast-forge upgrade [version]`                                                                                                                              |

Ask the user before destructive commands: `remove`, `restore`, `import` over existing data, `down --volumes`, `migrate --run`, `env set`, and anything that publishes or deploys.

## 7. Before you say it is done

- [ ] `bun run codegen` and `bun run typecheck` pass (at the root for a monorepo).
- [ ] Tests for new functions/services pass; new behavior has a test.
- [ ] No server-only import in `app/` or `src/`; no `_generated`, `_services.ts` or `.env` edits.
- [ ] Every new service, controller, gateway or module is registered (in a module in `_modules/index.ts`, or in `nest()`).
- [ ] Public functions check auth where they must; internal functions used for what clients must not call.
- [ ] Anything new that is configurable is in `.env.example` and, for deployment, in `compose.yaml`.
- [ ] You told the user what you could not verify (for example, behavior that needs Docker, Postgres or a browser).
