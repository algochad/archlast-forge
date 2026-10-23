# Deployment

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

## Serving the frontend

Host the built frontend anywhere. Either put it on the same origin behind a reverse proxy that forwards `/trpc` (with WebSocket upgrades) and `/api` to the engine, or serve it from another origin listed in `TRUSTED_ORIGINS` and create the client with `{ url }`.
