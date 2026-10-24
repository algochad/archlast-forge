# Decisions

Answers to questions the build prompt and architecture doc left open, and the choices made while building. Newest last.

## Scope and tooling

- **Everything in one pass.** No milestones: dashboard, Postgres, Redis, storage, scheduler and crons are all in.
- **Bun 1.4.3**, installed with mise and pinned in `mise.toml` and `packageManager`. **bun** is the package manager.
- **Internal packages ship TypeScript source** (Turborepo's just-in-time packages). Bun runs them and Vite bundles them. Only the demo has a build step. The dashboard is a Bun HTML import, bundled by the server.
- **Typecheck with `bun check`.** The root `turbo.json` also makes `typecheck` depend on the same package's `codegen`, so codegen runs before the demo typechecks.

## Data

- **Documents are stored as JSON** (user decision). Each table is `(_id, _creationTime, doc)`, with `doc` stored as TEXT (SQLite) or JSONB (Postgres). Writes are validated against the schema. There are no per-field columns, so a schema change never migrates data.
- **Migrations** create tables and sync expression indexes. Index names hash their definition, so changing an index's fields drops and recreates it. Dropped tables keep their data. `archlast-forge migrate` applies migrations and reports stored documents that no longer match the schema.
- **IDs** are `<table>:<32 hex>`, so `db.get(id)` knows which table to read and `v.id("lists")` rejects IDs from other tables.
- **Index queries support `q.eq` only**, on a prefix of the index fields, as in the architecture doc. Results are ordered by the remaining index fields, then `_creationTime`.
- **Postgres**: writes run SERIALIZABLE and retry serialization conflicts with jittered backoff, which is safe because mutations are deterministic. Queries run REPEATABLE READ READ ONLY. JSON parameters are bound as `?::text::jsonb`, because Bun JSON-encodes a string bound directly to jsonb a second time.
- **SQLite**: `bun:sqlite` in WAL mode, one write connection (serialized in-process), and four `query_only` reader connections. **Turso (`@tursodatabase/database`) was tried and dropped** (user decision, Oct 2026; the adapter is in commit 5527bb2). At 2,000 users it used about 1.7x the runtime CPU of `bun:sqlite`, had a worse latency tail, hung the process when write transactions overlapped on separate connections (worked around by running them one at a time), builds an index over a loaded 2.5M-row table in over 2.5 GB, allows one process per file, and has no FTS5. Numbers: `benchmarks/twelve-dollar/README.md`.

## Reactivity and caching

- **Topic granularity**: the table (for full scans and writes), `table:index:[values]` for each index-key prefix, and `table:by_id:[id]` for `db.get`. A write publishes the old and new values of every index prefix.
- **Publish after commit only.** A failed mutation publishes nothing.
- **Redis bus**: one pub/sub channel carries all topics, and each server filters locally (`shortcut:` comment in `bus.ts`).
- **Query cache**: off in dev. Elsewhere it's keyed by (function, args), only for queries that didn't read `ctx.auth`. It's skipped when any invalidation arrives during the run (`shortcut:` comment in `subscriptions.ts`). Each server evicts on bus events, and reads wait for pending evictions.

## Functions

- **Actions are at-most-once with no retries** (user decision). Scheduled mutations are exactly-once: the job row is claimed inside the mutation's own transaction. A scheduled action is claimed as `running` first. If the process crashes mid-action, the job stays `running` (`shortcut:` comment in `scheduler.ts`).
- **Crons** live in `forge/crons.ts` and are evaluated in UTC. Every server computes the same job ID for each run (`cron:<name>:<time>`), so each run is inserted once.
- **Function runtime** is a child process, not a Bun Worker, because Bun documents Worker termination as experimental. It owns the `forge/` modules, the database, Better Auth and the scheduler. The server process owns HTTP/WS, the bus, the cache and subscriptions.
- **Code or dependency changes restart only the function runtime** (user decision). HTTP and WebSocket stay up. The RPC handler is rebuilt after each load and sockets use whichever is current, so they see the new functions, and every subscription re-runs.
- **No RPC framework** (user decision; tRPC was removed). Each public function is `POST /rpc/<name>` (`/rpc/todos:add`, JSON arguments in the body, `{ result }` or `{ error: { message, code, data?, requestId } }` back with the matching HTTP status); queries also answer `GET /rpc/<name>?args=<json>`. POST requires `content-type: application/json`, which a cross-site form can't send without a preflight. Live queries use one WebSocket at `/rpc` with `{ type: "subscribe", id, name, args }` and `{ type: "unsubscribe", id }`; the server answers `{ type: "data", id, data }` (the first message is the current result) or `{ type: "error", id, error }`. The client reconnects with jittered exponential backoff and subscribes again, so a reconnect refetches. Arguments are validated in the function runtime. The dashboard API is plain JSON too: `GET /_admin/<op>?input=<json>` and `POST /_admin/<op>`. Not carried over from tRPC: request batching (each call is its own HTTP request).

## HTTP endpoints

- **`forge/http.ts`** default-exports `httpRouter()`, as `crons.ts` does with `cronJobs()`. `http.route({ method, path | pathPrefix, handler: httpAction(...) })` mirrors Convex.
- **Served under `/http`**, on the same origin as everything else (`path: "/hello"` answers at `/http/hello`, and the handler sees `/hello`). Convex uses a separate domain; a single server has no such thing, and a fixed prefix can't shadow `/rpc`, `/api/auth`, `/_admin` or `/_dashboard`.
- **A handler is an action** with a `Request` and a `Response`: the action context, the action timeout, and no database handle of its own (it calls mutations). It runs in the function runtime like auth requests do, so `forge/` code reloads and the single-process inline mode work unchanged.
- **Bodies are bytes both ways.** The IPC channel uses structured clone, so `ArrayBuffer`s cross as they are. Bodies are buffered, not streamed.
- **No CORS, no request id from the handler.** Routes answer their own `OPTIONS`. The server adds only `x-request-id`.
- **Errors** use the same rules as function calls (`toPublicError`): `ForgeError` and validation errors reach the caller, anything else is a 500 "Server error (request id)".
- Not done: streaming bodies, `HEAD` routes, tracing spans for HTTP calls (they are logged and counted in metrics like function calls), a route list in the dashboard, and support in `createTestBackend`.

## Auth

- **Better Auth by default** (user decision), through an adapter over the document store. `users`, `sessions`, `accounts` and `verifications` are added to every schema and visible in the dashboard. Writes to them publish topics like any other write. They aren't validated against the schema, so Better Auth plugins can add fields.
- `forge/auth.ts` (optional) default-exports `defineAuth(options)`. Without it, email and password sign-in is on.
- **Identity** is resolved once per request from the `cookie`/`authorization` headers, before the function's transaction starts.
- WebSockets carry cookies only on the handshake, so the client reconnects when the session changes.
- In dev, `BETTER_AUTH_SECRET` and `ADMIN_KEY` are generated once and kept in `DATA_DIR/.dev-secrets.json`. Outside dev, `BETTER_AUTH_SECRET` is required.

## Server-side dependencies

- `forge/` has its own `package.json`. In this monorepo it is a workspace member (`apps/*/forge`).
- `codegen` and `dev` run `bun install` when that manifest or the nearest `bun.lock` changes. They pass `--ignore-scripts` unless the manifest lists `trustedDependencies`, in which case Bun runs scripts for those packages only.
- A missing package fails at load with the `bun add` command to fix it.
- Codegen fails if `src/` imports anything from `forge/` other than `forge/_generated`.

## Config

- Startup fails fast on: a non-postgres `DATABASE_URL`, `REPLICAS > 1` without `REDIS_URL` or Postgres, an unreachable Redis, only one of `S3_ENDPOINT`/`S3_BUCKET` set, and a missing `BETTER_AUTH_SECRET` outside dev.

## Validation

- **Zod runs validation; `v` stays the public API.** Validators remain plain data, so they can still cross into the dashboard and the function runtime. Each one compiles once to a Zod schema, cached per validator object. Args, documents and return values are all checked by Zod. Error messages keep the `args.title must be a string` form.
- **`returns` validators** (`query({ returns: v.string(), ... })`): when given, the validator is the function's return type, and the handler is type-checked against it. At runtime a mismatch fails the call. A mutation checks its return value inside its own transaction, so a mismatch rolls the mutation back. A handler that returns nothing counts as `null`, so it pairs with `v.null()`. A mismatch is reported as an internal error, not a bad request, because it's a server bug.
- Added `v.null()` and `v.union(...)` so that common return types such as `Doc | null` can be expressed.
- Known gap: TypeScript allows extra properties on a returned object, but the runtime object check is strict, so the extra fields fail at runtime.
- Like Convex, a handler that calls `api.<same module>.*` needs an explicit return type annotation to break the inference cycle.

## Scope

- **Self-hosted framework, not a multi-tenant platform** (user decision). One deployment per app. Hosting many customers' projects (tenant isolation, metering, a control plane) is out of scope for now.
- **Planned: the engine runs as a Docker container, started and controlled by the CLI** (user direction). The design and its open questions are in [roadmap.md](roadmap.md#target-architecture-the-engine-as-a-docker-container-controlled-by-the-cli). Until it's built, the CLI runs the engine in its own process.

## Production readiness (self-hosted)

Decided without asking, as directed, while implementing [roadmap.md](roadmap.md).

- **Internal functions.** `internalQuery`/`internalMutation`/`internalAction` are left out of the client router and `api`, and codegen puts them in `internal`. Calling one returns "Unknown function", so their names don't leak. The dashboard, the scheduler, crons, migrations and `ctx.run*` may call them.
- **Timeouts.**
  - *Soft timeout, in the function runtime:* queries and mutations get `FUNCTION_TIMEOUT_MS` (10 s), actions `ACTION_TIMEOUT_MS` (10 min). Transaction handles refuse use after the call ends, so a timed-out handler can't write afterwards.
  - *Hard deadline, in the server:* the timeout plus 5 s. A process that misses it is presumed stuck in synchronous code, so it's killed and respawned. Requests go only to processes that have reported ready.
- **Runtime pool.** `RUNTIME_WORKERS` processes per server, round-robin. Only the first runs the scheduler, migrations and the schema check.
- **Request limits.** Fixed-window rate limiting per client IP (memory, or Redis when configured) on HTTP calls, auth and WebSocket messages. There are also caps on body and message size and on subscriptions per connection. Bun's WebSocket backpressure limit (4 MiB) drops slow clients, which then reconnect and refetch. Better Auth's limiter uses the same Redis counter through `customStorage.consume`.
- **Errors.** `ForgeError` (message and data) and argument validation errors reach callers. Everything else is "Server error (request id)" outside dev, logged with that request id. Return-value mismatches count as internal.
- **Admin.** Accounts live in `_admins` (Argon2 hashes from `Bun.password`), with 12-hour sessions in `_admin_sessions` (stored as token hashes) and roles owner, admin and viewer. Access uses an HttpOnly SameSite=Strict cookie plus an `x-forge-admin` header on writes (CSRF). `ADMIN_KEY` acts as an owner. Every write is recorded in `_audit`. The dashboard is off outside dev unless `DASHBOARD=on`.
- **TLS.** Outside dev, startup fails unless `BETTER_AUTH_URL` is https (`ALLOW_INSECURE_HTTP=1` overrides).
- **Queries.**
  - *Ranges:* bounds on the next index field after the equality prefix.
  - *Order and pagination:* `order()`, plus keyset `paginate()` with base64url cursors over (remaining index fields, `_creationTime`, `_id`). Documents with a missing optional field in the index can be skipped by range and paging comparisons.
  - *Reactivity:* ranges and pages are tracked at the equality prefix.
  - *Built-in index:* `by_creation_time` is available on every table.
- **Search.** `searchIndex(name, { searchField, filterFields })`. SQLite uses an FTS5 table kept in sync by the document store and tracked in `_search_indexes`. Postgres uses a GIN index over `to_tsvector('simple', …)`. Every term must match, the last as a prefix, and search reads depend on the whole table.
- **Migrations.**
  - *Postgres indexes:* built `CONCURRENTLY` outside transactions, under a session advisory lock; invalid leftovers are rebuilt.
  - *Data migrations:* `migration({ table, migrateOne })` registers an internal mutation that processes one page per transaction. Progress lives in `_migrations`, and runs resume.
  - *Schema check:* outside dev, startup refuses when stored documents don't match the schema (`SCHEMA_CHECK=off` skips it).
- **Overload.** The function runtime is single-threaded, so past its capacity calls queue. A call is only presumed stuck, and its process killed, when the process has answered nothing since the call went in (a synchronous loop); one that is merely behind keeps its other calls. More than `MAX_PENDING_CALLS` (1000) waiting calls per runtime process are refused at once with 503 and `Retry-After: 1`. Before this, a queue over the 15 s hard timeout killed the runtime and failed every call in flight, again and again.
- **Hot path.** A cached query result keeps its serialized JSON with the entry (`Result.json`), so a hit does no JSON work, and cache invalidation in this process is synchronous. IPC messages sent in one turn of the event loop travel as one `batch` in both directions (a write's publish, log and result are three). Signed-in calls resolve the caller from the signed session cookie and a direct read of the session when nothing could change what a session means (no plugins, no secondary storage, no secret rotation); the signature check is remembered per cookie value, the session is read on every call so a revoked one stops working at once; anything else goes through Better Auth. Rate limiting off means the client address is never looked up.
- **Throughput on one core.** Production runs functions in the server process (`RUNTIME_MODE=inline`); dev keeps the child process for hot reload. SQLite writes use group commit: write transactions that queue up while one runs share one SQLite transaction, each in its own savepoint (it sees the ones before it, fails alone, and resolves only after the shared COMMIT). WAL checkpoints run on a background thread with its own connection once the WAL passes 32 MiB, never on the thread that serves requests. Inside the runtime, an exact read cache (`read-cache.ts`) keeps document reads by statement, tagged with the same topics the query cache uses; it is only on when this process is the database's only writer, never serves a table with uncommitted writes, and a read-only query that used cached rows re-runs rather than read a newer snapshot after a commit. Like counts in `include` are one covering `COUNT(*)` per parent, cached per parent. Call logs are written once a second in 250-row statements with time-ordered ids.
- **CLI data commands** (`migrate`, `export`, `import`, `backup`, `env`, `admin`) run inside the running server when one answers: `POST /_cli` with `{ cmd, args }` and the admin key, executed in the function runtime, so an import reaches subscribers and nothing contends with the server for the write lock. With no server running they open the database themselves. Values and passwords are never written to the audit log.
- **Data portability.** Export and import use JSON Lines, preserving ids and validating on import. Import refuses non-empty tables unless `--replace`. Backups use SQLite `VACUUM INTO`; for Postgres, use `pg_dump`.
- **Environment variables.** Stored in `_env` and loaded into the function runtime before user code; the process environment wins. `env set` reloads a running engine (SIGHUP for a container, the admin reload endpoint otherwise).
- **Shortcuts closed.**
  - *Lease sweep:* actions stuck in `running` fail after the action timeout plus 60 s.
  - *Redis bus:* now one channel per topic, plus an all-topics channel published only when the query cache is on.
  - *Cache invalidation:* tracked per topic, with a bounded history.
- **Observability.**
  - *Logs:* JSON server logs in production. Function logs are batched into `_logs`, with `LOG_RETENTION_DAYS` retention.
  - *Metrics:* Prometheus `/metrics` behind `METRICS_TOKEN` or `ADMIN_KEY`; subscription and connection samples go into `_metrics` every 30 s for the dashboard.
  - *Tracing:* `x-request-id` is accepted, generated and echoed. With `OTEL_EXPORTER_OTLP_ENDPOINT` set, each function call is a span exported over OTLP/HTTP JSON (no SDK dependency), continuing an incoming W3C `traceparent`. Spans cover the server side of a call; there are no child spans inside the function runtime.
- **Health and shutdown.** `/health` reports liveness and `/ready` readiness. SIGTERM marks the server not ready, closes WebSockets with 1012, drains HTTP for up to 10 s, then stops the runtime.

## Docker engine (the open questions from the roadmap)

1. **Code delivery.** In dev, `forge/` is mounted read-only at `/src/forge` and the engine syncs it into its own filesystem (`/app/forge`), so the host's `node_modules` never shadows the container's. In production, `archlast-forge build` creates an app image `FROM` the engine with the code and dependencies baked in (`engine prepare`).
2. **Server dependencies.** Installed inside the container, from `forge/package.json` minus `@archlast-forge/*` and `workspace:` entries; `@archlast-forge/runtime` is linked to the engine's copy. `node_modules` sits on a named volume. The host also installs, but only for editor types.
3. **Docker access.** The CLI shells out to `docker`; `DOCKER=podman` switches binaries.
4. **Services.** The engine only, by default. `--with postgres,redis,s3` starts sibling containers on a per-project network and wires their URLs in.
5. **Versioning.** The engine image is `ghcr.io/algochad/archlast-forge-engine:<cli version>` (`ARCHLAST_ENGINE_IMAGE` overrides). Inside this repo the CLI builds it if it's missing; a published CLI pulls it.
6. **Without Docker.** `--no-docker` (or `ARCHLAST_NO_DOCKER=1`) keeps the in-process mode, and the CLI falls back to it with a notice when Docker is unavailable. Tests use it.
7. **Networking.** The container's port 3000 is published on `--port`, and `host.docker.internal` reaches host services. Dev and production containers have different names, so one never replaces the other.
8. **CLI surface.** `dev`, `build`, `start`, `stop`, `logs`, `status`, `engine build`. Data and config commands run inside a running engine through `docker exec`.

## Modes: full-stack apps and backends

Decided together, as directed ("a framework mode on React with a lightweight bundle, like Next.js or React Router; a backend mode hosted as a container with the services it needs; the CLI supports both; init lets you choose").

- **A project has a mode** (`archlast-forge.json`: `mode` and `services`), chosen by `init` / `bun create archlast-forge`. A project without the file is a backend with no services, so nothing from before changes.
- **Full-stack apps run inside the engine process.** `startServer({ app })` takes a host that is called for every request the engine has no route for (`/rpc`, `/api/auth`, `/http`, `/_admin`, `/_dashboard`, `/_cli`, `/health`, `/ready`, `/metrics` stay the engine's). The host can call public functions in-process as the visitor (queries through the query cache, as a private copy), ask who the visitor is, check the rate limit, and opt a response out of the idle timeout. The runtime package knows nothing about React.
- **The router is React Router's data router (8.5, pinned), not our own.** File routes, the build, server rendering, the live cache and the viewer are ours; matching, nested layouts, loaders, redirects, error boundaries, scroll and history are React Router's, which has the edge cases covered. `@archlast-forge/framework` re-exports a curated part of it.
- **File routes** (`app/routes`): `index.tsx`, `[param]`, `[...splat]`, `_layout.tsx`, `(group)/`, and `_`-prefixed names are private. Two files for one URL, or a parameter mixed with text, fail the build with the file names. `app/root.tsx` exports `Layout` (the `<html>` document, also around error pages), a default component and optionally `ErrorBoundary`. There is no `<title>` convention: React 19 hoists `<title>` and `<meta>` into `<head>`.
- **Loaders are isomorphic.** `loader({ request, params, ctx })` runs on the server for the first request and in the browser afterwards. `ctx.query` fetches and puts the result in the TanStack cache under the key `useQuery` uses, so the page renders with data on the server, the cache is embedded (`dehydrate`) and restored in the browser (`hydrate`), and the live subscription replaces it with the same value. `ctx.viewer()` is memoized per request on the server and asks Better Auth (`disableCookieCache`) in the browser, because the session store lags a sign-in by a moment and a loader that redirects anonymous visitors would otherwise bounce a user who just signed in.
- **The viewer is part of the page.** `window.__FORGE__` carries `{ dev, viewer, queries, hydration }`. `useViewer()` renders on the server, and follows sign-in and sign-out through `ArchlastForgeClient.onSessionChange`, which fires only once something uses `auth`, so a page that never signs in makes no session request. `useSession()` got a server snapshot (pending), because `useSyncExternalStore` throws without one.
- **Errors are sanitized before they are rendered.** The server renders with the same errors it embeds for the browser: `ForgeError` messages and call failures (which already carry public messages) pass; any other error becomes `Server error (request <id>)` outside dev, and is logged in full. Rendering the original error leaked a loader bug's message into the HTML.
- **Server rendering** uses `renderToReadableStream` and waits for `allReady`, so the status code and headers are right and there are no half pages. No streaming, no static generation, no route actions (a server-handled POST on a page URL would need CSRF protection; mutations are called from the browser).
- **Build** (`Bun.build`, twice): the browser bundle (split per route, hashed, minified, with gzip and brotli copies stored next to it) and the server bundle (one file, packages external, CSS ignored). The metafile maps each route to its chunk and shared imports, which become `modulepreload` links; all CSS is linked in `<head>`, because Bun merges the CSS of lazily loaded routes into the entry's stylesheet. Output goes to `.forge/build/<version>`; dev keeps the previous version for pages already open. `metafile` paths are relative to the working directory, not to `root`.
- **Development** is one process on the host: the engine and the app, rebuilding in about 0.2 s, reloading browsers over server-sent events, with build errors shown over the page. Docker runs only the services (PostgreSQL, Redis, RustFS), on 127.0.0.1 with free ports, and `dev` stops the ones it started when it ends; data stays in named volumes.
- **Production in a container**: `engine prepare` copies `app/`, installs the app's own dependencies, **links** React and the `@archlast-forge/*` packages from the engine image (two copies of React break hooks), generates the types and builds. `engine serve` then serves the build. A stale host lockfile that names local tarballs no longer breaks the server-dependency install: it is retried without the lockfile.
- **Backends are a stack.** `init` writes `compose.yaml` (the app and the chosen services, wired with health checks and `depends_on`), a `Dockerfile` (`FROM ${ENGINE_IMAGE}`, `COPY . /src`, `engine prepare`), `.dockerignore`, `.env` (secrets generated once, mode 0600, never overwritten) and `.env.example`; with Caddy, a `Caddyfile`. The compose file is the user's afterwards. PostgreSQL and Redis are not published; RustFS publishes one port, because browsers use presigned URLs; with Caddy only 80 and 443 are. The dashboard is on in the stack. `up` builds with a spinner, waits for the engine image's health check, and prints the addresses; on failure it shows the end of the build output or the app's last log lines.
- **Services in `dev` follow where the engine runs.** For an engine on the host they publish ports on localhost; for an engine in Docker they share a network and use container names. `dev` waits for PostgreSQL and Redis to accept connections before starting the engine.
- **Packaging**: `@archlast-forge/framework` is a library (`dist/` with code splitting, so one copy of the router context); the CLI loads it from the project at runtime, so a backend never installs React. `create-archlast-forge` ships source with `@clack/prompts`; the CLI depends on it for `init`.
- **Not done**: streaming and static generation, route actions, per-route CSS on demand, hot module replacement (a save reloads the page), tracing spans for page renders, a route list in the dashboard, `createTestBackend` support for pages, and Caddy is tested end to end only for `localhost` (its own certificate authority); issuing real certificates needs a public domain and is not tested.

## Packaging

- Libraries (runtime, client, react, vue, svelte) publish `dist/`: bundled ESM (each entry separately, because the runtime spawns `child.js` next to its own module) plus `.d.ts` from `tsc --emitDeclarationOnly`. Bun-run packages (cli, dashboard, create-archlast-forge) publish source.
- Releases are lockstep (`scripts/version.ts`). `scripts/pack.ts` stages the packages, pins `workspace:` dependencies and packs tarballs; `--smoke` proves them in a fresh project. A tag runs the release workflow, which publishes to npm (needs `NPM_TOKEN`) and pushes the engine image to GHCR.
- No license is declared yet: that's the owner's choice to make before publishing.
