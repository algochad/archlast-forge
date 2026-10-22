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
- **SQLite**: WAL mode, one write connection (serialized in-process), and four `query_only` reader connections.

## Reactivity and caching

- **Topic granularity**: the table (for full scans and writes), `table:index:[values]` for each index-key prefix, and `table:by_id:[id]` for `db.get`. A write publishes the old and new values of every index prefix.
- **Publish after commit only.** A failed mutation publishes nothing.
- **Redis bus**: one pub/sub channel carries all topics, and each server filters locally (`shortcut:` comment in `bus.ts`).
- **Query cache**: off in dev. Elsewhere it's keyed by (function, args), only for queries that didn't read `ctx.auth`. It's skipped when any invalidation arrives during the run (`shortcut:` comment in `subscriptions.ts`). Each server evicts on bus events, and reads wait for pending evictions.

## Functions

- **Actions are at-most-once with no retries** (user decision). Scheduled mutations are exactly-once: the job row is claimed inside the mutation's own transaction. A scheduled action is claimed as `running` first. If the process crashes mid-action, the job stays `running` (`shortcut:` comment in `scheduler.ts`).
- **Crons** live in `convex/crons.ts` and are evaluated in UTC. Every server computes the same job ID for each run (`cron:<name>:<time>`), so each run is inserted once.
- **Function runtime** is a child process, not a Bun Worker, because Bun documents Worker termination as experimental. It owns the `convex/` modules, the database, Better Auth and the scheduler. The server process owns HTTP/WS, the bus, the cache and subscriptions.
- **Code or dependency changes restart only the function runtime** (user decision). HTTP and WebSocket stay up. The tRPC router sits behind a stable handle, so open sockets see the new procedures, and every subscription re-runs.
- **One tRPC procedure per function** (`todos.add`), plus `_sub.todos.listByList` for each query's subscription. Arguments are validated in the function runtime.

## Auth

- **Better Auth by default** (user decision), through an adapter over the document store. `users`, `sessions`, `accounts` and `verifications` are added to every schema and visible in the dashboard. Writes to them publish topics like any other write. They aren't validated against the schema, so Better Auth plugins can add fields.
- `convex/auth.ts` (optional) default-exports `defineAuth(options)`. Without it, email and password sign-in is on.
- **Identity** is resolved once per request from the `cookie`/`authorization` headers, before the function's transaction starts.
- WebSockets carry cookies only on the handshake, so the client reconnects when the session changes.
- In dev, `BETTER_AUTH_SECRET` and `ADMIN_KEY` are generated once and kept in `DATA_DIR/.dev-secrets.json`. Outside dev, `BETTER_AUTH_SECRET` is required.

## Server-side dependencies

- `convex/` has its own `package.json`. In this monorepo it is a workspace member (`apps/*/convex`).
- `codegen` and `dev` run `bun install` when that manifest or the nearest `bun.lock` changes. They pass `--ignore-scripts` unless the manifest lists `trustedDependencies`, in which case Bun runs scripts for those packages only.
- A missing package fails at load with the `bun add` command to fix it.
- Codegen fails if `src/` imports anything from `convex/` other than `convex/_generated`.

## Config

- Startup fails fast on: a non-postgres `DATABASE_URL`, `REPLICAS > 1` without `REDIS_URL` or Postgres, an unreachable Redis, only one of `S3_ENDPOINT`/`S3_BUCKET` set, and a missing `BETTER_AUTH_SECRET` outside dev.
