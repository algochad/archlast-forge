# Project modes: full-stack, backend, monorepo, microservices

Read this when you create a project, decide what shape an app should have, add a service/app/mobile/desktop to a monorepo, or must know which files a mode owns. Details per area: [fullstack.md](fullstack.md), [nest-services.md](nest-services.md), [forge-rpc.md](forge-rpc.md), [operations.md](operations.md).

Every project is described by `archlast-forge.json` (`{ "mode": "framework" | "backend", "services": [...] }`; no file = a backend with no services). A monorepo adds `archlast-forge.workspace.json` at its root. Detect the mode first: look for `archlast-forge.json`, an `app/` folder (full-stack), `apps/` + `archlast-forge.workspace.json` (monorepo).

## Choosing

| Situation                                                                                   | Mode                         | Create with                                                |
| ------------------------------------------------------------------------------------------- | ---------------------------- | ---------------------------------------------------------- |
| One web app, server-rendered React, file routes, loaders, live queries; one deployable      | **Full-stack** (`framework`) | `bun create archlast-forge my-app` (or `--mode framework`) |
| API for any frontend (React/Vue/Svelte SPA, mobile, scripts), REST/GraphQL/sockets via Nest | **Backend**                  | `bun create archlast-forge api --mode backend`             |
| Several deployables (web + admin + services), shared typed API, one dashboard               | **Monorepo**                 | `--monorepo`                                               |
| Domain services owned separately, called by the main app                                    | **Monorepo + microservices** | `--microservices orders,billing` (implies `--monorepo`)    |
| Phone app / desktop app on the same backend                                                 | add **mobile** / **desktop** | `--mobile`, `--desktop full                                | client` |

Defaults: full-stack gets `postgres,redis,s3,caddy`; backend `postgres,redis,s3`; `--services none` = engine alone on SQLite; any mix of `postgres`, `redis`, `s3`, `caddy`. Other `init` flags: `--shadcn|--no-shadcn`, `--base-color <neutral|stone|zinc|mauve|olive|mist|taupe>` (cannot change later), `--transport forge-rpc|tcp|redis|nats` (default `forge-rpc`), `--yes`, `--install|--no-install`, `--git|--no-git`. Use `--yes` in non-interactive shells or the folder is required and nothing else is asked. The target folder must be empty or absent.

Start from the smallest shape that fits. A project becomes a monorepo later in place (`archlast-forge monorepo`), so do not create a monorepo "just in case". Never create two backends in one TypeScript project.

## Full-stack app

```
my-app/
  app/                 routes (app/routes), root.tsx, components, styles: the frontend, server-rendered
  forge/               schema.ts, functions, http.ts (+ NestJS), auth.ts, crons.ts, package.json, tsconfig.json
  public/              static files
  archlast-forge.json  compose.yaml  Dockerfile  .env  Caddyfile(optional)  package.json  tsconfig.json
```

One container serves pages, the API (`/rpc`), auth (`/api/auth`), the dashboard (`/_dashboard`) and `/http`. `bun run dev` runs on the host with live reload (port 3000). Frontend code in `app/` may import **only** from `forge/_generated`. Read [fullstack.md](fullstack.md) before touching `app/`.

## Backend

```
api/
  forge/               schema.ts, messages.ts (starter), http.ts, files.ts (with s3), package.json, tsconfig.json
  archlast-forge.json  compose.yaml  Dockerfile  .env  .env.example  Caddyfile(optional)  package.json
```

No pages. Frontends live elsewhere (their own repo or `apps/*`), talk to it with `@archlast/forge-client` or the React/Vue/Svelte bindings, and import types from `forge/_generated` (see [clients.md](clients.md)). `bun run dev` runs the engine in Docker with `forge/` mounted; saving a file restarts only your functions. Use Nest for REST/WebSocket/GraphQL surfaces ([nest-services.md](nest-services.md)); set `cors` and `TRUSTED_ORIGINS` for browsers on other origins.

Typical backend feature, in order: table in `forge/schema.ts` → `forge/_modules/<feature>/<feature>.service.ts` (reader/writer classes) → `forge/<feature>.ts` (queries/mutations using `inject`) → optional `<feature>.controller.ts`, then `<feature>.module.ts` in the same folder, listed in `forge/_modules/index.ts` → `forge/http.ts` mounts `nest(http, { imports: appModules })` → `bun run codegen` → tests ([testing.md](testing.md)).

**`forge/` has the same shape in every app of every mode** (function modules at the top, Nest code in `_modules/<feature>/`, routers at the top, `_lib/`, generated files untouched): see "Folder layout of a clean forge/" in [nest-services.md](nest-services.md).

## Monorepo

```
acme/
  package.json                 workspaces apps/* and packages/*; scripts dev, build, typecheck (turbo), format
  turbo.json
  archlast-forge.workspace.json   { main, scope?, transport, apps: { <name>: { kind, port, rpcPort? } }, mobile? }
  apps/
    web/        main app (full-stack, or apps/api for a backend). Has _services.ts + <svc>.service/.controller/.ts per service
    orders/     a service: a backend serving a Forge RPC router
    billing/
    admin/      (optional) another full app
    mobile/ desktop/   (optional) clients of the main app
  packages/
    api/        @acme/api: the MAIN app's `api` object and data-model types (re-exports of its forge/_generated)
    contracts/  @acme/contracts: each service's Forge RPC types (re-exports of apps/<svc>/forge/_generated/rpc.ts)
```

- **Every app is a whole archlast-forge project**: its own `forge/`, `.env`, `compose.yaml`, `Dockerfile`, deployed on its own, with its own database.
- Ports in dev (`bun run dev` at the root, all apps with `--no-docker`): main 3000, services 3001, 3002, …; RPC 4001, 4002, ….
- **Type sharing rules:** `packages/api` has the main app's types only (`import { webApi, type Web } from "@acme/api"`); another app's types are in `@acme/api/<app>`. Services are not in `@acme/api`. A TypeScript project imports the types of **one** backend (two backends' generated types collide with `TS2717`). Mobile and desktop import `@acme/api`, never a service.
- A backend main app's package is `@acme/backend` because `@acme/api` is `packages/api`.
- **Apps may share one Redis** (and one Postgres server, each with its own database): the engine keeps its cache, topics and rate limits under a prefix from the app's `OTEL_SERVICE_NAME` (`archlast-forge:orders:`). The CLI gives every app its own name (`init`, `add app|service`, `workspace sync`), so services stay apart, and every server of one service has the same name, so scaled instances share their keys. Never give two apps one name, and make sure `OTEL_SERVICE_NAME` reaches the engine (the generated `compose.yaml` passes it from `.env`; an older or hand-written one lists only what it passes); `REDIS_PREFIX` overrides.
- **One dashboard:** services send telemetry to the main app (`DASHBOARD_URL`, shared `DASHBOARD_TOKEN`, `OTEL_SERVICE_NAME` in each service; `MICROSERVICES=orders=http://…,billing=http://…` in the main app). The commands keep these `.env` values in step; in production set them to the real addresses.

### Commands that change the layout (run from anywhere in the monorepo)

```bash
archlast-forge monorepo [--microservices orders --transport forge-rpc --mobile --desktop client --dry-run --yes]  # in-place conversion
archlast-forge add service billing         # apps/billing + the main app's billing.service/controller/action + _services.ts + contracts + ports + token
archlast-forge add app admin [--mode backend] [--services …]
archlast-forge add mobile                  # Expo app, client of the main app
archlast-forge add desktop <full|client>   # Tauri (full only for a full-stack main app)
archlast-forge remove billing              # deletes folder, data, .env, and the main app's calls to it (asks first; --yes)
archlast-forge workspace                   # list apps and ports
archlast-forge workspace sync              # regenerate packages/api, packages/contracts, _services.ts after hand changes
```

- Names: lowercase letters, digits and `-`; `web`, `api`, `mobile`, `desktop` are reserved.
- Prefer these commands over copying folders: they allocate ports, write the token and dashboard variables, and regenerate shared packages. After hand changes (an app folder added or deleted) run `workspace sync`.
- `add` refuses to overwrite files in the main app. If `forge/http.ts` has your own `nest()` call (not the scaffold's), the command tells you which two lists to add to.
- A monorepo made by hand joins with `{ "main": "ward", "scope": "hospital", "transport": "forge-rpc", "apps": {} }` saved as `archlast-forge.workspace.json`, then `archlast-forge workspace sync`.

### What a service looks like

Service (`apps/orders/forge/`): `schema.ts` (its own tables), `orders.ts` / `calls.ts`-style files with the internal functions that own the data, `_modules/orders/` for any services/modules its router uses, `orders.router.ts` at the top level (`@Router`; routers must not be under `_`), `http.ts` (`nest()` + `ForgeRpcServer`). Main app (`apps/web/forge/`): scaffolded per remote service `orders.service.ts` (client holder), `orders.controller.ts`, `orders.ts` (action) and the generated `_services.ts`, all left where the CLI wrote them; the app's own features go in `_modules/<feature>/`, and `http.ts` becomes `nest(http, { imports: appModules, controllers: serviceControllers, providers: serviceProviders })`. Full code and rules in [forge-rpc.md](forge-rpc.md). With `--transport tcp|redis|nats` the service instead listens with that Nest transport and answers `@MessagePattern("orders.hello")` in a controller; the main app's service sends through a `ClientProxy`.

Which transport: **forge-rpc** unless you need to talk to non-forge services (use `tcp`/`redis`/`nats`) or need events/fan-out (Nest `@EventPattern` on Redis/NATS; Forge RPC is request-response only).

### Monorepo rules of thumb

- Split into a service when a domain has its own data, scaling or ownership. Do not split by technical layer.
- The main app is the only edge: it owns auth, sessions and everything clients call. Services trust the shared token and receive explicit user ids.
- One client class per service in the caller; callers depend on its methods, never on the raw client or the service's address.
- Share types through `packages/api` (clients) and `packages/contracts` (backends) only.
- Roll out changes to a router backwards-compatibly (add fields/procedures first, remove after callers move) because services deploy separately.

## Upgrading

`archlast-forge upgrade [version]` moves `@archlast/forge-*` versions in `package.json` and `forge/package.json` and the engine image tag in `Dockerfile` and `compose.yaml`, adds missing Prettier setup, installs and reruns codegen; in a monorepo it does every app. Run it instead of editing versions by hand.

## Common mistakes

- Creating a monorepo or microservices for a single app.
- Copying an app folder in `apps/` by hand, then forgetting `workspace sync` (shared packages and ports stale).
- Importing `@acme/contracts` or a service's types into the main app's `app/`, mobile or desktop code.
- Importing two backends' `_generated` types into one TypeScript project.
- Editing `forge/_services.ts`, `packages/api` or `packages/contracts` instead of regenerating them.
- Giving two apps the same port or database; each app is its own stack.
- Forgetting `--yes` in scripts (commands that move files refuse without a terminal).
- Using `src/` for a full-stack app's frontend (it is `app/`); `src/` is for a backend's separate frontend with its own bundler.
