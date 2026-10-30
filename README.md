# archlast-forge

A self-hosted reactive backend for TypeScript apps, in the style of Convex, on Bun. You declare a schema and functions in `forge/`. Clients call them with end-to-end types, and live queries push new results whenever the data they read changes. The engine runs as a Docker container that the CLI starts and controls.

- **Data:** SQLite (bun:sqlite) or Postgres. Index and range queries, keyset pagination, full-text search, data migrations, export, import and backup.
- **Functions:** queries, mutations and actions; internal functions; `returns` validators; timeouts and size limits; `ForgeError` for caller-facing errors.
- **Batteries:** Better Auth sign-in, file storage on S3 or RustFS through presigned URLs, scheduled functions and crons.
- **Scale:** Redis for cross-server reactivity, caching and rate limits; a pool of function-runtime processes.
- **Operations:** admin dashboard with accounts, roles and an audit log; Prometheus metrics; structured logs; `/health` and `/ready`; graceful shutdown.
- **Clients:** React (with TanStack Query), Vue and Svelte. A testing library for your functions.
- **Two ways to start:** a **full-stack app** (server-rendered React with file routes, loaders and live queries, served by the engine itself), or a **backend** (the engine with PostgreSQL, Redis and S3 storage as one container stack, for any frontend).

## Quick start

```bash
bun create archlast-forge my-app      # asks: full-stack app or backend? which services?
cd my-app && bun install
bun run dev                           # http://localhost:3000, reloading as you edit
bun run up                            # the production stack: builds the image, starts it with its services
```

Full documentation is in [`apps/docs`](apps/docs/content). Build it with `bun run --cwd apps/docs build`, or preview it with `bun run --cwd apps/docs dev` on http://localhost:4000. Start with [Getting started](apps/docs/content/getting-started.mdx), then [Full-stack apps](apps/docs/content/framework.mdx) or [Backends](apps/docs/content/backend.mdx).

## This repository

```
apps/demo/                       todo app: a backend with a separate Vite + React frontend
apps/demo/forge/                its backend: schema, functions, crons, auth; own package.json
apps/docs/                       documentation site (MDX, a React single-page app built with Bun)
packages/runtime/                engine: validators, schema, functions, document store, adapters, server, testing
packages/client/                 framework-agnostic client: JSON over HTTP + WebSocket, live queries
packages/react|vue|svelte/       framework bindings
packages/framework/              full-stack mode: file routes, server rendering, build, dev server (on React Router)
packages/cli/                    archlast-forge: dev, build, start, migrate, export, env, admin, engine
packages/dashboard/              admin UI served at /_dashboard
packages/create-archlast-forge/  project starter: templates for both modes, the stack files (compose.yaml, Dockerfile, .env)
docker/engine.Dockerfile         the engine image
docs/                            decisions.md (design decisions), roadmap.md (production readiness)
scripts/                         pack.ts (tarballs + smoke test), version.ts (lockstep versions)
```

Work on the demo with `bun run dev` from the root. It runs the demo's backend with `archlast-forge dev` and Vite through Turborepo.

## Testing

```bash
bun run test              # SQLite and in-memory adapters
bun run services:up       # Postgres, Redis and RustFS in Docker
bun run test:all          # adds Postgres, Redis, S3 and two-server tests
bun run typecheck         # includes compile-time type tests
bun run pack:smoke        # pack every package; scaffold a full-stack app and a backend from the tarballs, build and serve both
bun run e2e               # the same projects in Docker: `up`, `dev` with services, uploads, restarts, `down`
```

The browser tests (`packages/framework`) drive Chromium. Install one with `cd packages/framework && bunx playwright-core install chromium` (or set `CHROMIUM_PATH`); without a browser they skip.

CI runs all of these on every push and pull request (`.github/workflows/ci.yml`). Releases are tag-driven (`release.yml`): they publish to npm, which needs an `NPM_TOKEN` secret, and push the engine image to GHCR.
