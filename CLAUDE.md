# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

Bun 1.4.3 (pinned in `mise.toml` and `packageManager`). Run everything from the repo root unless noted.

```bash
bun install
bun run dev                  # demo: engine in Docker + Vite (add -- --no-docker to run the engine in-process)
bun run build                # turbo build (libraries emit dist/, the demo builds)
bun run typecheck            # runs `bun check` per package; depends on codegen
bun run codegen              # regenerates forge/_generated in apps/demo
bun run format               # prettier over ts/tsx/md

bun run test                 # SQLite and in-memory adapters only
bun run services:up          # Postgres, Redis, RustFS in Docker
bun run test:all             # everything, one package at a time, with TEST_* env set
bun run pack:smoke           # pack all packages; scaffold a full-stack app and a backend from the tarballs; build and serve both
bun run e2e                  # the same in Docker (needs Docker): `up`, `dev` with services, uploads, restarts, `down`
bun scripts/e2e-docker.ts caddy   # HTTPS behind Caddy; needs ports 80 and 443
```

Single test file or test name, from the package directory:

```bash
cd packages/runtime && bun test test/values.test.ts
cd packages/runtime && bun test -t "name fragment"
```

The browser tests in `packages/framework` drive Chromium through `playwright-core`; they skip when no browser can be launched (`CHROMIUM_PATH`, or `bunx playwright-core install chromium`). `turbo.json` passes `CHROMIUM_PATH`, `LD_LIBRARY_PATH`, `FONTCONFIG_FILE` and `SCREENSHOTS` through to tests; `SCREENSHOTS=<dir>` makes the template test save images of its pages. The `e2e` scripts need `bun scripts/pack.ts` first and the engine image (`bun packages/cli/src/index.ts engine build`, which they do not rebuild: rebuild it after changing `packages/cli/src/engine.ts` or anything else that runs inside the container).

Postgres, Redis or S3 tests run only when their `TEST_*` variable is set (`TEST_POSTGRES_URL`, `TEST_REDIS_URL`, `TEST_S3_ENDPOINT`); `test:all` sets them, matching `services:up`. Type-level tests live in `packages/runtime/test-types` and run with `bun check -p test-types`.

## Turborepo

`AGENTS.md` says this Turborepo version may differ from what you remember. Before changing `turbo.json` or turbo commands, read the bundled docs from the installed package (`node -p "require.resolve('turbo/package.json')"`, then its `docs/README.md`).

## Architecture

**Forge code and generated types.** An app declares its backend in `forge/` (schema, functions, crons, auth). `archlast-forge codegen` writes `forge/_generated` (`api`, `internal`, `dataModel`), which is committed. `src/` may import only from `forge/_generated`; codegen fails on anything else. Internal functions are left out of `api` and the client router, so their names never reach a client.

**Two processes, one protocol.** The server (`packages/runtime/src/server/server.ts`, `rpc.ts`, `subscriptions.ts`, `bus.ts`, `cache.ts`) owns HTTP, WebSockets, the cache, rate limits and live-query subscriptions. The function runtime (`runtime-core.ts`) owns the `forge/` modules, the database, Better Auth and the scheduler. `runtime.ts` decides how to run it. In dev, and when `RUNTIME_WORKERS > 1`, it is a child process (`child.ts`) that can be restarted alone when code changes. Otherwise it runs inline in the server, which is the production single-worker default. `config.ts` decides, and it refuses `inline` in dev. Both modes share `runtime-core.ts`, so behavior changes belong there, not in either wrapper.

**Calls and reactivity.** A query, mutation or action goes through the server to the runtime, which runs it in a transaction. Writes publish topics only after commit: the table, `table:index:[values]` for each index prefix, and `table:by_id:[id]`. Subscriptions re-run queries whose topics changed. Between servers, the Redis bus carries topics and each server filters locally. The query cache is keyed by function and args, and by caller for queries that read `ctx.auth`.

**Storage.** `server/db/` holds the dialect layer (`sqlite.ts`, `postgres.ts`). Each table is `(_id, _creationTime, doc)` with the document stored as JSON, so schema changes don't migrate data. Writes are validated by Zod against the schema through `values.ts`. The SQLite path uses `bun:sqlite` in WAL mode, one serialized writer with group commit, and reader connections. `read-cache.ts` is an exact per-statement read cache that is only enabled when this process is the only writer.

**Validators and types.** `packages/runtime/src/values.ts` (`v`) defines validators as plain data, so they can cross into the dashboard and the runtime process. `schema.ts`, `functions.ts` and `relations.ts` build on them, and the client types are derived from `api`.

**Clients.** `packages/client` speaks the wire protocol directly: JSON over HTTP at `POST /rpc/<name>`, and a WebSocket at `/rpc` for live queries. The React, Vue and Svelte packages wrap it. The dashboard is served at `/_dashboard`, with its API at `/_admin/<op>`.

**Modes.** A project is a full-stack app or a backend (`archlast-forge.json`: `mode`, `services`; no file means a backend with no services). `packages/create-archlast-forge` holds the templates (`template/base` plus `framework` or `backend`) and `src/stack.ts`, which renders `compose.yaml`, `Dockerfile`, `.env` and the Caddyfile and validates the config; the CLI imports it. Backend: `dev` runs the engine in Docker; `up`/`down` run `compose.yaml` (`packages/cli/src/stack.ts`).

**Full-stack apps.** `packages/framework` (on React Router's data router) scans `app/routes` into a route manifest (`routes.ts`), generates entry files into `<project>/.forge/gen` (`generate.ts`), and bundles for the browser and the server with `Bun.build` (`build.ts`). `server.tsx`'s `createApp` returns the `AppHost` that `startServer({ app })` calls for every request the engine doesn't own (`packages/runtime/src/server/server.ts`): it runs loaders with a per-request context, renders with `renderToReadableStream`, embeds `window.__FORGE__` (loader data, the TanStack query cache, the viewer, sanitized errors), and serves `/_app/*` and `public/`. `client.tsx` hydrates the document. Development is one process on the host with rebuild and live reload (`dev.ts`); the CLI loads the framework from the project at runtime (`packages/cli/src/app.ts`), and `engine prepare` builds the app inside the image while linking React from the engine so there is one copy. Convention docs: `apps/docs/content/framework.md`.

**Docs site.** `apps/docs` builds `content/*.md` into static HTML with `bun run --cwd apps/docs build` (`--serve` previews on :4000). `build.ts` renders Markdown with `Bun.markdown`, `highlight.ts` highlights code at build time with Shiki (both themes as CSS variables), `landing.ts` (with `landing.css`, `landing.js`) is the hand-written landing page, `layout.ts` the shared top bar, `site.js` the client behavior (theme, copy, search over `search.json`, mobile menu), `style.css` the styles. Fonts (Geist, Geist Mono) come from `@fontsource-variable/*` and are copied into `dist/fonts`. A new page goes in `ORDER` and `GROUPS` in `build.ts`; the build fails if they disagree. The intro page is `introduction`; `index.html` is the landing page.

**HTTP endpoints.** `forge/http.ts` (like `crons.ts` and `auth.ts`, a special module that `listModules` skips) exports `httpRouter()`. The server forwards `/http/*` to the function runtime as an `{ t: "http" }` message (like `/api/auth`), which matches the route and runs the handler as an action. Routing is in `server/http.ts`.

**CLI.** `packages/cli` is `archlast-forge`. `dev`, `build`, `start` and `engine` drive the engine container (`docker.ts`, `engine.ts`, image from `docker/engine.Dockerfile`), or run it in-process with `--no-docker`. Data commands (`migrate`, `export`, `import`, `backup`, `env`, `admin`) run inside the running server through `POST /_cli` (`cli-ops.ts`), so an import reaches subscribers. Without a server they open the database themselves.

**Packaging.** Internal packages point `exports` at `src/*.ts` and ship source. Bun and Vite run them directly. Only the libraries (runtime, client, react, vue, svelte) build `dist/`. The runtime build must keep `child.ts` as its own entry, because the runtime spawns `child.js` next to its module. Versions move in lockstep (`scripts/version.ts`).

## Decisions to keep

`docs/decisions.md` records the settled choices and the reasons. Check it before changing any of these:

- SQLite is `bun:sqlite` only. Turso was tried and removed. Postgres is the other supported engine.
- tRPC was removed. The protocol is the plain JSON/WebSocket one above.
- Actions are at-most-once with no retries. Scheduled mutations are exactly-once.
- Only `ForgeError` and argument validation errors reach callers. Other errors become "Server error (request id)" outside dev.
- This is a self-hosted framework: one deployment per app. Multi-tenant hosting is out of scope.
