# Deployment

## The stack

A project made with `archlast-forge init` carries its own deployment: `compose.yaml` runs your app and the services you chose (PostgreSQL, Redis, S3 storage, Caddy for HTTPS) as one stack.

```bash
archlast-forge up      # builds the image, starts everything, waits until the app is healthy
archlast-forge logs
archlast-forge down    # data stays in Docker volumes
```

`up` creates `.env` with fresh secrets the first time. Copy the project and `.env` to a server and run `archlast-forge up`, or `docker compose up -d --build` where the CLI isn't installed. [Backends](backend.html) covers the stack in detail: what each service does, HTTPS, backups and upgrades. For a full-stack app, the same image also carries the pages.

The rest of this page is what is underneath: the image on its own, and the settings you can change.

## Build and run

```bash
archlast-forge build --tag my-app:1.0
archlast-forge start --image my-app:1.0 --env-file .env.production --port 3000
```

The image is the engine plus your `forge/` code and its dependencies (installed for Linux). It's a normal container: run it with Docker Compose, Kubernetes, Fly, or anything else.

- The volume at `/data` holds SQLite and needs to persist.
- `GET /health` is liveness; `GET /ready` is readiness (503 while starting, or after a failed load).
- `SIGTERM` stops accepting work, drains in-flight requests, and closes WebSockets with code 1012, so clients reconnect elsewhere.

## Minimal production `.env`

```
BETTER_AUTH_SECRET=<openssl rand -hex 32>
BETTER_AUTH_URL=https://api.example.com
TRUSTED_ORIGINS=https://app.example.com
```

## Scaling out

One server with SQLite is a fine start. For several servers:

```
DATABASE_URL=postgres://…     # shared database
REDIS_URL=redis://…           # cross-server reactivity, cache, rate limits
REPLICAS=3                    # declares intent; startup fails if the above are missing
```

Put the servers behind a load balancer that supports WebSockets. Sticky sessions aren't needed. `RUNTIME_WORKERS` runs several function-runtime processes per server, for CPU-heavy functions.

## The local database

Without `DATABASE_URL` the engine stores data in a SQLite file (`bun:sqlite`, WAL mode) at `DATA_DIR/app.db`, on the volume at `/data`.

- **One server.** The file belongs to one engine; `REPLICAS > 1` and several servers need Postgres. `RUNTIME_WORKERS > 1` works, but the processes share one write lock, so it helps CPU-heavy functions more than write-heavy ones.
- **Backups:** `archlast-forge backup app.db` takes a consistent copy while the engine runs.
- **Capacity:** one core serves roughly 600 requests per second of the [$12 challenge](https://github.com/arjaythedev/twelve-dollar-server-challenge) mix, and held 2,000 simulated users with p95 between 50 and 400 ms across runs (this was measured on a shared VM; expect run-to-run swings). Past that, add runtime processes or move to Postgres.

## Serving the frontend

A full-stack app needs nothing here: the engine serves its pages. For a backend with a separate frontend, host the built frontend anywhere. Either put it on the same origin behind a reverse proxy that forwards `/rpc` (with WebSocket upgrades) and `/api` to the engine, or serve it from another origin listed in `TRUSTED_ORIGINS` and create the client with `{ url }`.
