# Roadmap to production

What remains before archlast-forge is ready for production use. This was assessed against the code as of the Zod validation merge (PR #1). Items are in priority order within each tier.

## Scope: a self-hosted framework

archlast-forge is a **self-hosted framework**, like self-hosted Convex: one deployment per app, run by the team that owns the app.

A **hosted multi-tenant platform** (like Convex Cloud or Supabase) is out of scope for now. It would need tenant isolation (separate databases or schemas, and sandboxed function runtimes), project and team management, a pipeline that uploads `convex/` code, usage metering and billing, and a control-plane UI. Nothing below should block that later, but nothing below works toward it either.

## Target architecture: the engine as a Docker container, controlled by the CLI

Today, `archlast-forge dev` and `start` run the engine in the CLI's own process, on the host's Bun. The plan is to ship the engine as a Docker image instead, with the CLI as its controller:

```
host                                   container: archlast-forge engine
────                                   ────────────────────────────────
archlast-forge CLI ── Docker API ───▶  server (HTTP/WS, bus, cache, subscriptions)
  codegen (host: editor types)           └─ function runtime (convex/ code, DB, auth, scheduler)
  dev / start / stop / logs / status     dashboard at /_dashboard
convex/ ─────────── mount or image ──▶  /app/convex
                                        volume: /data (SQLite, dev secrets)
optional sibling containers: Postgres, Redis, RustFS (CLI-managed)
```

What stays the same:
- The server and function-runtime split already exists, and restarting only the function runtime keeps working inside the container.
- Codegen stays on the host, because the editor needs `convex/_generated` types locally.

Open questions to settle before building it:

1. **Getting code into the container.** Bind-mount `convex/` in dev for live reload? For production, build an app image (`FROM archlast-forge/engine` + `COPY convex/`), or mount code into a stock image?
2. **Server dependencies.** Run `bun install` for `convex/package.json` inside the container? That gives Linux-native binaries matching the runtime, but needs a cached volume for `node_modules`. Install on the host and mount instead?
3. **Docker API access.** Shell out to the `docker` CLI, or talk to the Docker socket directly? Should Podman be supported?
4. **Service containers.** Should `dev` start Postgres, Redis and RustFS when configured, or only the engine? Who owns their volumes and lifecycle (`archlast-forge stop --all`)?
5. **Versioning.** Pin the engine image tag to the CLI version (`archlast-forge@x.y.z` → `engine:x.y.z`)? How are upgrades and rollbacks handled?
6. **Without Docker.** Keep the current in-process mode as a fallback (CI, machines without Docker), or require Docker?
7. **Networking.** Port mapping and the `TRUSTED_ORIGINS` defaults. How does the container reach host services, and how do proxies like code-server's port forwarding reach the container?
8. **CLI surface.** `dev`, `start`, `stop`, `logs`, `status`, `migrate` (run inside the container), `dashboard`.

## P0: safety, before any real users

| # | Item | Why |
|---|---|---|
| 1 | **Internal functions**: `internalQuery`, `internalMutation`, `internalAction`, callable only from other functions, the scheduler and crons | Every exported function is public today. In the demo, anyone can call `todos:markReminded` or `todos:purgeDone`. |
| 2 | **Function timeouts and limits**: a per-call time limit, and caps on result size and document size; possibly a pool of runtime processes | One runtime process serves all calls, and handlers have no time limit. One infinite loop or huge `collect()` stalls the server. |
| 3 | **Request and abuse limits**: rate limiting, a request body cap, a cap on subscriptions per socket; Better Auth's rate limiter on a Redis-backed store | None exist today. Without a shared store, each server counts separately. |
| 4 | **Error hygiene**: a user-facing error class (like `ConvexError`); every other error becomes "Server error" plus a request ID | Internal messages, including SQL errors, reach clients verbatim. |
| 5 | **Admin security**: per-person admin accounts, roles and an audit log; dashboard off by default in production | One shared `ADMIN_KEY`; the function runner bypasses user auth. |
| 6 | **TLS correctness**: fail startup outside dev unless `BETTER_AUTH_URL` is `https://` | Behind a TLS proxy, the default `http://` URL produces session cookies that aren't marked `Secure`. |

## P1: data

| # | Item | Notes |
|---|---|---|
| 7 | **Pagination and richer index queries**: `gt`/`gte`/`lt`/`lte`, descending order, cursor pagination, `usePaginatedQuery` | Only `q.eq` exists. |
| 8 | **Real migrations**: backfill and rename scripts; deploys blocked on documents that don't match the schema; Postgres `CREATE INDEX CONCURRENTLY` outside a transaction | `migrate` only reports today. Index builds inside a transaction lock writes on large tables. |
| 9 | **Backup, export and import**: snapshot export/import, SQLite backup command | Postgres can use `pg_dump`. |
| 10 | **Known shortcuts** (marked `shortcut:` in code) | - A scheduled action interrupted by a crash stays `running`; needs a lease and timeout sweep (`scheduler.ts`)<br>- One Redis channel carries every topic (`bus.ts`)<br>- Query caching is skipped when any write lands during the run (`subscriptions.ts`)<br>- No backpressure for slow WebSocket clients |
| 11 | **Full-text search** | Optional, but most apps of this kind end up needing it. |

## P1: operations

| # | Item | Notes |
|---|---|---|
| 12 | **CI**: GitHub Actions running `turbo typecheck test` with Postgres, Redis and RustFS as services | There's no CI today. PR #1 merged with no checks. |
| 13 | **Deployment**: the engine Docker image (see the target architecture above), graceful shutdown that drains connections on SIGTERM, separate readiness and liveness endpoints | |
| 14 | **Observability**: structured JSON logs, `/metrics` (Prometheus), request IDs, optional tracing | Logs are an in-memory buffer of 2,000 entries per server and are lost on restart. |
| 15 | **Packaging**: built `dist` with type declarations, versioning, npm publishing, `create-archlast-forge` | Packages currently ship TypeScript source and are private. |

## P2: developer experience

- **React hooks:** a `"skip"` option for `useQuery`, optimistic updates, and a file-upload hook.
- **Testing library for user code**, like `convex-test`: run functions against an in-memory database in one line.
- **`archlast-forge env`:** manage environment variables for `convex/` code.
- **A docs site.**
- **Clients for other frameworks** (Vue, Svelte, React Native), if wanted.

## Dashboard

| Area | Today | Needed |
|---|---|---|
| Access | Shared key | Per-user admin login, roles, audit trail |
| Data | Newest 100 documents, read-only | Pagination, filter by index, sort, edit/insert/delete, JSON detail view |
| Functions | Raw JSON args | Arg form generated from validators, run as a specific user, result history |
| Logs | Polled every 2 s, one server | Live streaming, filters (function, level, time range), persistence across servers |
| Metrics | Calls/errors/average table | Charts for latency p50/p95, error rate, throughput, subscription counts |
| Scheduled | Read-only list | Cancel/retry jobs, next cron run times |
| Storage | None | File browser with sizes and delete |
| Auth | Only via the `users` table | User and session management (revoke, ban), Better Auth settings |
| General | Basic | Toasts, loading/error states, keyboard navigation, light/dark toggle, responsive tables, accessibility pass |

## Suggested order

1. P0 items 1–4 (internal functions, timeouts, request limits, error hygiene)
2. CI (12)
3. Pagination and range queries (7)
4. Settle the open questions above, then build the Docker engine and CLI controller (13)
5. Everything else, highest tier first
