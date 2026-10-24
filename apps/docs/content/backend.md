# Backends

A backend is `forge/` plus a stack of containers: the engine, and the database, cache and storage it uses. You write your schema and functions; any frontend (React, Vue, Svelte, mobile, a script) talks to it.

```bash
bun create archlast-forge api --mode backend
cd api && bun install && bun run dev
```

## Develop

`bun run dev` starts the engine in Docker with `forge/` mounted and the services listed in `archlast-forge.json`. Saving a file restarts your functions; open WebSockets stay connected. Ctrl-C stops the engine and the services; their data stays in Docker volumes.

- API and WebSocket: http://localhost:3000
- Dashboard: http://localhost:3000/_dashboard (the admin key is printed)

Call it from a frontend:

```ts
import { ArchlastForgeClient } from "@archlast/forge-client";
import { api } from "./forge/_generated/api";

const client = new ArchlastForgeClient({ url: "http://localhost:3000" });
const messages = await client.query(api.messages.list, { paginationOpts: { numItems: 20, cursor: null } });
const stop = client.watch(api.messages.list, { paginationOpts: { numItems: 20, cursor: null } }, (update) => console.log(update)); // live
```

Add your frontend's origin to `TRUSTED_ORIGINS` so its cookies and requests are accepted. Plain HTTP routes (webhooks, a public API) go in `forge/http.ts` and are served under `/http`; see [HTTP endpoints](http.html).

## The stack

`archlast-forge init` writes the files that run it:

| File | |
|---|---|
| `archlast-forge.json` | `{ "mode": "backend", "services": ["postgres", "redis", "s3"] }`: what `dev` starts |
| `compose.yaml` | the production stack: your app and the services, wired together |
| `Dockerfile` | your `forge/` on the engine image |
| `.env` | secrets, generated for you; ignored by git. `.env.example` lists the keys |
| `Caddyfile` | with Caddy: the HTTPS proxy's configuration |

`compose.yaml` is yours to edit; archlast-forge only runs it.

| Service | What it is for | How the app finds it |
|---|---|---|
| PostgreSQL 17 | the database, instead of a SQLite file | `DATABASE_URL` |
| Redis 7 | reactivity across servers, the query cache, rate limits | `REDIS_URL` |
| RustFS | S3-compatible file storage, with an `forge` bucket | `S3_ENDPOINT`, `S3_PUBLIC_ENDPOINT`, `S3_BUCKET`, keys |
| Caddy 2 | HTTPS with certificates that renew themselves, and compression | in front of the app |

The dashboard is on in the stack, behind the admin key and a login limit; set `DASHBOARD=off` in `.env` to hide it. The database and Redis are not published to the network; only the app (or Caddy) is. Storage publishes one port, because browsers upload and download through presigned URLs. Choosing storage adds `forge/files.ts` with `generateUploadUrl` and `url` to build on.

## Run it

```bash
archlast-forge up              # builds the image, starts everything, waits until the app is healthy
archlast-forge status          # what is running
archlast-forge logs [service]  # follow the logs
archlast-forge down            # stop; data stays in volumes
archlast-forge down --volumes  # stop and delete the data
```

`up` creates `.env` with fresh secrets the first time, and never overwrites it. It starts the app on http://localhost:3000. `docker compose up -d --build` does the same job on a server that does not have the CLI.

## On a server

1. Copy the project to the server, with `.env` (not through git).
2. Choose Caddy when you create the project, or add it to `compose.yaml`. In `.env`, set `DOMAIN` and point the DNS records for `DOMAIN` and `s3.DOMAIN` at the server. `BETTER_AUTH_URL` becomes `https://DOMAIN`.
3. `archlast-forge up` (or `docker compose up -d --build`).

Without Caddy, put your own HTTPS proxy in front: outside development the engine refuses to start unless `BETTER_AUTH_URL` is `https://`. `.env` sets `ALLOW_INSECURE_HTTP=1` so a local `up` works; remove it once the address is https. Behind a proxy, set `TRUST_PROXY=1` so rate limits use the visitor's address (the Caddy setup does).

## Backups and upgrades

- PostgreSQL: `docker compose exec -T postgres pg_dump -U forge forge > backup.sql`
- Without PostgreSQL, SQLite: `archlast-forge backup app.db` takes a consistent copy while the stack runs.
- Upgrade archlast-forge by updating the `@archlast/forge-*` packages and running `up` again: the image builds on the engine image of the CLI's version. To build on another engine image, set `ARCHLAST_ENGINE_IMAGE` for the CLI, or `ENGINE_IMAGE` in `.env` for plain `docker compose`.
- Storage and Postgres images are named in `compose.yaml`; pin the versions you have tested.

## Without Docker

`archlast-forge dev --no-docker` runs the engine in your terminal, on SQLite or on the services you point it at with `DATABASE_URL`, `REDIS_URL` and the `S3_*` variables. `archlast-forge start --no-docker` is the production equivalent.
