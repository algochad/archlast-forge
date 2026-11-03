# archlast-forge

A self-hosted reactive backend for TypeScript apps, in the style of Convex, on Bun. You declare a schema and functions in `forge/`. Clients call them with end-to-end types, and live queries push new results whenever the data they read changes. The engine runs as a Docker container that the CLI starts and controls.

- **Data:** SQLite (bun:sqlite) or Postgres. Index and range queries, keyset pagination, full-text search, data migrations, export, import and backup.
- **Functions:** queries, mutations and actions; internal functions; `returns` validators; timeouts and size limits; `ForgeError` for caller-facing errors.
- **Batteries:** Better Auth sign-in, file storage on S3 or RustFS through presigned URLs, scheduled functions and crons.
- **Scale:** Redis for cross-server reactivity, caching and rate limits; a pool of function-runtime processes.
- **Observability, built in:** every request traced (functions, database statements, outbound calls, NestJS classes), errors grouped into issues, logs tied to their trace, latency and Apdex per operation, users, jobs, hotspots, a service map, runtime health, release comparisons, SLOs and alerts, on the dashboard. Other services report to it over OpenTelemetry (OTLP).
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

Full documentation is in [`apps/docs`](apps/docs/content). Preview it with `bun run --cwd apps/docs dev` on http://localhost:4000, or build it with `bun run --cwd apps/docs build` (output in `apps/docs/dist`). To serve it from a container, run `docker compose run --build --rm -p 8080:80 docs` in `apps/docs` and open http://localhost:8080. That folder builds on its own, so it can be deployed without the rest of the repo; on Coolify, use the Docker Compose build pack with Base Directory `/apps/docs` and Docker Compose Location `/compose.yaml`, then give the `docs` service a domain (and set `SITE_URL`, such as `https://docs.example.com`, as a build variable for canonical links and `sitemap.xml`). The site is readable without JavaScript: every page is also Markdown at `/<page>.md`, and `/llms.txt` and `/llms-full.txt` list and contain the documentation for AI tools. Start with [Getting started](apps/docs/content/getting-started.mdx), then [Full-stack apps](apps/docs/content/framework.mdx) or [Backends](apps/docs/content/backend.mdx).

## Agent skill

Coding agents (Claude Code, Codex, Cursor and the others that read the [Agent Skills](https://github.com/vercel-labs/skills) format) can learn how to build on archlast-forge: project modes and the files the scaffolder writes, the `forge/` layout, service classes and Nest modules, Forge RPC between services, data and functions, clients, the CLI, deployment and observability.

```bash
npx skills add algochad/archlast-forge
```

The skill is in [`skills/archlast-forge`](skills/archlast-forge/SKILL.md); `bun run skill:check` validates it. See [Agent skill](apps/docs/content/agent-skill.mdx).

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
skills/archlast-forge/           the agent skill (`npx skills add algochad/archlast-forge`): SKILL.md and references/
scripts/                         pack.ts (tarballs + smoke test), version.ts (lockstep versions), check-skill.ts
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

CI runs all of these on every push and pull request (`.github/workflows/ci.yml`). Releases are tag-driven (`release.yml`): they publish to npm, which needs an `NPM_TOKEN` secret, and push the engine image to GHCR. The steps, checks and what to do when one fails are in [docs/releasing.md](docs/releasing.md).

## License

MIT: see [LICENSE](LICENSE). Code ported from or copied out of other MIT projects keeps their notices: [packages/runtime/THIRD_PARTY_NOTICES.md](packages/runtime/THIRD_PARTY_NOTICES.md) (Traceway) and [packages/create-archlast-forge/THIRD_PARTY_NOTICES.md](packages/create-archlast-forge/THIRD_PARTY_NOTICES.md) (shadcn/ui), and the Scalar explorer the dashboard vendors carries its own license in `packages/dashboard/vendor/scalar`. Report security problems as [SECURITY.md](SECURITY.md) says.
