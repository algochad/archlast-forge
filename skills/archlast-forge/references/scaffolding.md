# What the scaffolder writes, file by file

Read this when you create a project, must know what a generated file is for and whether you may edit it, or must add a stack service, mobile or desktop app. It is the real output of `create-archlast-forge` (0.16). For the commands see [cli.md](cli.md); for choosing a mode see [project-modes.md](project-modes.md).

`bun create archlast-forge <dir>` = `bunx create-archlast-forge <dir>` = `archlast-forge init <dir>`. It asks questions only on a TTY with `CI` unset and no `--yes`; otherwise it takes defaults and the folder is required. It then formats every file with Prettier (4-space), so generated projects are 4-space; the templates in the archlast-forge repo are 2-space, and your own code should follow the project's `.prettierrc`.

## Files every project gets

| File                             | Role                                                                                                                                                                                         | May you edit it?                                             |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `archlast-forge.json`            | `{ "mode": "framework" \| "backend", "services": ["postgres","redis","s3","caddy"] }`; validated on every CLI load. `dev` starts the listed services; `up` runs whatever `compose.yaml` says | change `services` through `archlast-forge stack add\|remove` |
| `package.json`                   | scripts `dev`, `codegen`, `typecheck`, `up`, `down`, `format` (+ `build`, `start` in full-stack; `logs` in backend); `@archlast/forge-cli`, `typescript`, `prettier`                         | yes (add dependencies); keep scripts                         |
| `forge/schema.ts`                | tables (`defineSchema`, `defineTable`); `users` and Better Auth tables are built in                                                                                                          | yes                                                          |
| `forge/messages.ts`              | starter: paginated `list`, `search` (search index), `send` (auth + validation with `ForgeError`)                                                                                             | replace with your features                                   |
| `forge/files.ts`                 | upload-URL and URL functions (only with `s3`)                                                                                                                                                | yes                                                          |
| `forge/http.ts`                  | `httpRouter()` with `GET /hello` (backend); mount `nest()` here                                                                                                                              | yes                                                          |
| `forge/package.json`             | server-side dependencies (`@archlast/forge-runtime`, `@types/bun`); installed for Linux inside the engine                                                                                    | yes (server-only dependencies go here, not the root)         |
| `forge/tsconfig.json`            | strict, bundler resolution, `types: ["bun"]`, `experimentalDecorators` + `emitDecoratorMetadata` (Nest), `include **/*.ts`                                                                   | rarely                                                       |
| `forge/_generated/`              | `api`, `internal`, `dataModel` (+ `rpc` with routers) written by codegen, committed (only `_generated/.depshash` is gitignored)                                                              | **never**                                                    |
| `compose.yaml`                   | the production stack; yours after `init`                                                                                                                                                     | yes                                                          |
| `Dockerfile`                     | `FROM ${ENGINE_IMAGE}` (the engine image at the CLI's version), `COPY . /src`, `RUN … engine prepare`, `ENV NODE_ENV=production`                                                             | rarely                                                       |
| `.dockerignore`                  | keeps `.env*` (except `.env.example`), `data`, `node_modules`, `.git` out of the image                                                                                                       | rarely                                                       |
| `.env`                           | generated secrets, mode 0600, git-ignored, never overwritten by `up`                                                                                                                         | values only; never commit                                    |
| `.env.example`                   | the same keys, empty                                                                                                                                                                         | keep in step with `.env` when you add a variable             |
| `.gitignore`                     | `node_modules dist .forge .env forge/data data forge/_generated/.depshash`                                                                                                                   | yes                                                          |
| `.prettierrc`, `.prettierignore` | 4-space Prettier; `.prettierignore` skips `forge/_generated`                                                                                                                                 | no                                                           |
| `Caddyfile`                      | only with `caddy`                                                                                                                                                                            | yes                                                          |
| `README.md`                      | project-specific commands                                                                                                                                                                    | yes                                                          |

Config files you must not hand-write: `forge/_generated/*`. Secrets in `.env` (`BETTER_AUTH_SECRET`, `ADMIN_KEY`, `POSTGRES_PASSWORD`, `S3_*`, `FORGE_RPC_TOKEN`) are generated: do not invent values.

## Full-stack app (`--mode framework`)

Adds to the common files:

```
app/
  root.tsx             Layout (the <html> document, also for error pages), Chrome (header, nav, viewer, sign-out), default Outlet, ErrorBoundary
  routes/index.tsx     home page (uses useViewer)
  routes/sign-in.tsx   sign in / sign up with Better Auth (useAuth from @archlast/forge-react)
  routes/chat.tsx      loader (redirect when signed out + ctx.query prefetch) and a live usePaginatedQuery chat
  styles.css           plain stylesheet (or Tailwind + shadcn theme variables with shadcn)
  env.d.ts             module declarations for css/svg/png imports
public/                static files (favicon.svg), served as-is
tsconfig.json          jsx react-jsx, strict, verbatimModuleSyntax, experimentalDecorators, paths "@/*" -> app/* (shadcn only), include ["app"]
package.json           + @archlast/forge-framework, @archlast/forge-react, react, react-dom (+ shadcn/Tailwind packages with shadcn)
```

- `forge/` stays the backend; `app/` is the browser/SSR code and may import only `forge/_generated` (types and `api`).
- **With shadcn (default):** adds `components.json`, `app/components/ui/*` (shadcn components built on Base UI), `app/components/theme-toggle.tsx`, `app/lib/utils.ts` (`cn`), `app/styles.css` with Tailwind v4 and the theme of the chosen base color (`neutral` default; `stone zinc mauve olive mist taupe`; fixed at creation). Dependencies: `tailwindcss`, `tw-animate-css`, `class-variance-authority`, `cn`, `lucide-react`, `@base-ui/react`, `shadcn`, `@fontsource-variable/geist`; dev: `bun-plugin-tailwind` (the framework's browser build loads it from the project). Add components with `bunx shadcn@latest add <component>`. Dark mode follows the system until the header toggle sets `class="dark"` on `<html>`.
- **`--no-shadcn`:** plain `styles.css` (classes like `container`, `btn`, `card`), no Tailwind.
- Default services: `postgres,redis,s3,caddy`. With `--services none` the stack is the engine alone on SQLite with one `app-data` volume (compose has only `app`).
- `bun run dev` = one process on the host (engine and framework dev server) with rebuild and live reload on :3000; `bun run build`/`start` = `--no-docker` production build/serve; `bun run up` = Docker stack. Routes and conventions: [fullstack.md](fullstack.md).

## Backend (`--mode backend`)

No `app/`, no `tsconfig.json` at the root, no `build`/`start` scripts. `typecheck` is `archlast-forge codegen && tsc -p forge --noEmit`. `forge/http.ts` is the only route file. Frontends are separate (see [clients.md](clients.md)): in a monorepo under `apps/`, or elsewhere importing `forge/_generated`. `dev` runs the engine in Docker with `forge/` mounted read-only and the listed services.

## The stack (`compose.yaml`, `.env`) by service

| Service (`archlast-forge.json`) | Adds to `compose.yaml`                                                                                                                                                                                                                                   | Adds to `.env`                                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| (always) `app`                  | engine built from `Dockerfile`; port `${PORT:-3000}:3000`; `BETTER_AUTH_SECRET`, `ADMIN_KEY`, `BETTER_AUTH_URL`, `ALLOW_INSECURE_HTTP`, `DASHBOARD` (default `on`); volume `app-data:/data` (SQLite and local files)                                     | `BETTER_AUTH_SECRET`, `ADMIN_KEY`, `BETTER_AUTH_URL`, `ALLOW_INSECURE_HTTP=1`, `PORT`              |
| `postgres`                      | `postgres:17-alpine` with healthcheck and volume; `DATABASE_URL=postgres://forge:${POSTGRES_PASSWORD}@postgres:5432/forge` on `app`                                                                                                                      | `POSTGRES_PASSWORD`                                                                                |
| `redis`                         | `redis:7-alpine` (append-only, healthcheck); `REDIS_URL=redis://redis:6379` on `app` (cross-server reactivity, cache, rate limits; keys sit under a prefix from `OTEL_SERVICE_NAME`, which the monorepo commands set per app, so apps may share a Redis) | none                                                                                               |
| `s3`                            | `rustfs/rustfs` (S3-compatible, port `${S3_PORT:-9000}`) and a one-shot `rustfs-init` that creates bucket `forge`; `S3_*` variables on `app`                                                                                                             | `S3_ACCESS_KEY`, `S3_SECRET_KEY`, `S3_PUBLIC_ENDPOINT` (where browsers upload/download), `S3_PORT` |
| `caddy`                         | `caddy:2-alpine` on 80, 443 and 443/udp with `Caddyfile` mounted (`{$DOMAIN:localhost}` → `app:3000`, `s3.{$DOMAIN}` → `rustfs:9000`) and cert volumes                                                                                                   | `DOMAIN`; `BETTER_AUTH_URL=https://${DOMAIN}`; `S3_PUBLIC_ENDPOINT=https://s3.${DOMAIN}`           |

- Change services after `init` with `archlast-forge stack add|remove <list>`: it rewrites `archlast-forge.json`, and `compose.yaml`/`.env.example`/`Caddyfile` only if they are still what the old services produced (otherwise it writes `compose.new.yaml` to merge). It adds missing `.env` keys with fresh secrets. It cannot move data between SQLite and Postgres (`export` first, `import` after).
- `compose.yaml` is hand-editable and wins: `up` runs what is written there. To pass another engine setting, add it to `app.environment` and to `.env.example`. All settings: [operations.md](operations.md).
- Production minimum: https `BETTER_AUTH_URL`, remove `ALLOW_INSECURE_HTTP`, set `TRUSTED_ORIGINS` for other-origin frontends, `TRUST_PROXY=1` behind a proxy, `DASHBOARD=off` unless used (checklist in [operations.md](operations.md)).

## Monorepo (`--monorepo`, `--microservices`, `--mobile`, `--desktop`)

Root files: `package.json` (workspaces `apps/*`, `packages/*`; scripts `dev|build|typecheck` via `turbo run`, `format`), `turbo.json` (`dev` persistent/no cache, `build` after `^build` with outputs `.forge/build/**`, `typecheck` after `^typecheck`), `archlast-forge.workspace.json`, `.gitignore`, `.prettierrc`, `.prettierignore`, `README.md`. Each `apps/<name>/` is a full project as above. `packages/api` (`@<name>/api`: `export { api as webApi } from "../../apps/web/forge/_generated/api"; export type * as Web from ".../dataModel"`; the export is `<mainFolder>Api` — `webApi`, `apiApi` for a backend main app) and `packages/contracts` (only with `forge-rpc`: `export type { Rpc as OrdersRpc } from "../../apps/orders/forge/_generated/rpc"`). Names in scaffolded code derive from the project and service names: `OrdersService`, `OrdersRpc`, `ORDERS_RPC_URL`.

Per added service (`--microservices orders` or `archlast-forge add service orders`): `apps/orders` (a backend with `forge/orders.router.ts`, `forge/calls.ts`, `forge/http.ts` with `ForgeRpcServer`, `.env` with `FORGE_RPC_TOKEN`, `OTEL_SERVICE_NAME`, `DASHBOARD_URL`, `DASHBOARD_TOKEN`), and in the main app `forge/orders.service.ts`, `orders.controller.ts`, `orders.ts` (action), `_services.ts` (written/rewritten), `.env` (`MICROSERVICES=…`, shared tokens). Details: [forge-rpc.md](forge-rpc.md).

## Mobile (`--mobile`, `add mobile`): `apps/mobile` (Expo)

```
apps/mobile/  app.json  App.tsx  index.ts  metro.config.js  package.json  tsconfig.json  .env(.example)  README.md
  src/client.ts       ArchlastForgeClient + Better Auth Expo client; `api` typed from @<name>/api (a type-only import)
```

- Client of the **main app** only; imports `@<name>/api` (type-only: `export const api = anyApi as unknown as typeof webApi`), never a service.
- `EXPO_PUBLIC_API_URL` (in `.env`) is the backend address: on a physical phone use the computer's LAN address, not `localhost`; for builds set it where the app is built (EAS: `eas env`).
- Session is kept in secure storage (Keychain/Keystore), sent as a `cookie` header by the client's `headers` option and `authPlugins: [expoClient({ scheme, storagePrefix, storage: SecureStore })]`. `AppState` "active" calls `client.reconnect()`.
- A backend main app gets `forge/auth.ts`: `defineAuth({ emailAndPassword: { enabled: true }, plugins: [expo()], trustedOrigins: ["<name>://"] })`. A main app with its own `auth.ts` keeps it and is told what to add.
- Scripts: `dev` (`expo start`), `android`, `ios`, `typecheck`. Details: [clients.md](clients.md).

## Desktop (`--desktop full|client`, `add desktop <full|client>`): `apps/desktop` (Tauri)

```
apps/desktop/  package.json  README.md  .gitignore  src-tauri/ (Cargo.toml build.rs tauri.conf.json capabilities/default.json icons/ src/main.rs)
  full:    engine/desktop-engine.ts   Bun sidecar that starts the engine (below)
           scripts/bundle-engine.ts   builds apps/web and copies the Bun binary into src-tauri before dev/build
           loading/index.html         splash shown until the engine answers
  client:  index.html  config.js  tsconfig.json  scripts/build-client.ts
           src/main.tsx               React page: ArchlastForgeClient + usePaginatedQuery(api.messages.list), typed from @<name>/api
```

- **full** (only with a full-stack main app): Tauri ships Bun as a sidecar; `desktop-engine.ts` runs `archlast-forge start --no-docker` in production mode on `127.0.0.1` with its data and a generated `secret` in the app's data folder (`DATA_DIR`), `ALLOW_INSECURE_HTTP=1` on loopback only. One user = one local SQLite database. `beforeDevCommand`/`beforeBuildCommand` run `bun scripts/bundle-engine.ts`.
- **client:** a page for a backend elsewhere. The backend address is `FORGE_URL` in `config.js` (default `http://localhost:3000`). Dependencies `@<name>/api`, `@archlast/forge-react`, `react`; `bun run dev:page` serves the page alone on :5174 for browser testing; `tauri dev`/`tauri build` wrap it.
- Needs Rust and the platform webview libraries; icons are placeholders (`bunx tauri icon your-icon.png`). Details: [clients.md](clients.md).

## What to do with it as an agent

- New feature → edit `forge/` and `app/` (or the client app); do not touch `compose.yaml` or the Dockerfile unless the feature needs a new service or variable.
- New environment variable → read it in code through `process.env`, add it to `.env.example`, to `compose.yaml` `app.environment`, and tell the user to set it in `.env` and the production host. Engine settings have a fixed list: see [operations.md](operations.md).
- New server-only dependency → `forge/package.json`. New browser dependency → root `package.json`. Then `bun install` (the engine reinstalls `forge/` dependencies for Linux itself).
- New stack service → `archlast-forge stack add <service>`.
- Do not delete `.env`; never print it.

## Common mistakes

- Putting server-only dependencies in the root `package.json`, or browser dependencies in `forge/package.json`.
- Editing `forge/_generated`, `.env` secrets, `_services.ts`, `packages/api` or `packages/contracts` by hand.
- Creating `src/` in a full-stack app (frontend code is `app/`).
- Running `init` in a non-empty folder, or without `--yes` in a script (asks questions / needs a folder).
- Choosing `--no-shadcn` and then importing shadcn components (or the reverse); base color cannot be changed later.
- `full` desktop with a backend main app (only `client` is valid there), or a mobile app pointing at `localhost` on a real device.
- Adding Postgres/Redis/S3 by editing `compose.yaml` only: use `archlast-forge stack add` so `archlast-forge.json`, `.env` and `dev` agree.
