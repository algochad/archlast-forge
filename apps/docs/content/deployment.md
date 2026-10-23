# Deployment

## Build and run

```bash
archlast-forge build --tag my-app:1.0
archlast-forge start --image my-app:1.0 --env-file .env.production --port 3000
```

The image is the engine plus your `forge/` code and its dependencies (installed for Linux). It's a normal container: run it with Docker Compose, Kubernetes, Fly, or anything else.

- The volume at `/data` holds the local database and needs to persist.
- `GET /health` is liveness; `GET /ready` is readiness (503 while starting, or after a failed load).
- `SIGTERM` stops accepting work, drains in-flight requests, and closes WebSockets with code 1012, so clients reconnect elsewhere.

## Minimal production `.env`

```
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=https://api.example.com
TRUSTED_ORIGINS=https://app.example.com
```

## Scaling out

One server with the local database is a fine start. For several servers:

```
DATABASE_URL=postgres://…     # shared database
REDIS_URL=redis://…           # cross-server reactivity, cache, rate limits
REPLICAS=3                    # declares intent; startup fails if the above are missing
```

Put the servers behind a load balancer that supports WebSockets. Sticky sessions aren't needed. `RUNTIME_WORKERS` runs several function-runtime processes per server, for CPU-heavy functions.

## The local database

Without `DATABASE_URL` the engine stores data in a SQLite-compatible file at `DATA_DIR/app.db`, through [Turso's Rust engine](https://github.com/tursodatabase/turso) (`@tursodatabase/database`).

> **Turso's database package is alpha.** Don't keep data you can't lose in it until it's declared stable. Take regular `archlast-forge backup`s, or use Postgres.

What to know:

- **One process per database file.** The server's function-runtime process owns the file; a second process (a second `RUNTIME_WORKERS`, another server on the same volume) can't open it. `RUNTIME_WORKERS > 1` needs Postgres, and the CLI's data commands (`migrate`, `export`, `import`, `backup`, `env`, `admin`) talk to the running server over `/_cli` with `ADMIN_KEY` instead of opening the file.
- **Concurrent writers inside the process** use MVCC (`BEGIN CONCURRENT`). Two transactions writing the same row conflict; the engine retries the loser automatically, the way it does on Postgres.
- **The file format is Turso's.** Turso switches the file to MVCC the first time it opens it, and SQLite (including `SQLITE_DRIVER=bun`) can't read it afterwards. The engine refuses to open a file written by SQLite rather than risk corrupting it (Turso doesn't enforce primary keys or use expression indexes on tables SQLite created). To move an existing database over: `archlast-forge export`, switch, then `import` into the new file.
- **Full-text search** uses a token table instead of FTS5, which Turso doesn't have yet: every term must still match and the last one matches as a prefix, but ranking is by summed term frequency rather than BM25.
- **Going back:** `SQLITE_DRIVER=bun` runs `bun:sqlite` (WAL, one writer connection) on a database it created itself. Export from one, import into the other.
- Linux (x64, arm64), macOS (arm64) and Windows (x64) have native builds. The engine image is Debian-based, so it works; Alpine and Intel Macs don't have one yet.

## Serving the frontend

Host the built frontend anywhere. Either put it on the same origin behind a reverse proxy that forwards `/rpc` (with WebSocket upgrades) and `/api` to the engine, or serve it from another origin listed in `TRUSTED_ORIGINS` and create the client with `{ url }`.
