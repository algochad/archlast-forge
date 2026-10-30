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
bun scripts/update-shadcn.ts # refreshes the shadcn/ui starter's components and base colors from the shadcn registry
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

**Modes.** A project is a full-stack app or a backend (`archlast-forge.json`: `mode`, `services`; no file means a backend with no services). `packages/create-archlast-forge` holds the templates (`template/base` plus `framework` or `backend`, and for full-stack apps `template/shadcn`, an overlay that `src/shadcn.ts` copies over the plain pages, with the theme of the chosen base color; `bun scripts/update-shadcn.ts` refreshes its components and colors from the shadcn registry) and `src/stack.ts`, which renders `compose.yaml`, `Dockerfile`, `.env` and the Caddyfile and validates the config; the CLI imports it. Backend: `dev` runs the engine in Docker; `up`/`down` run `compose.yaml` (`packages/cli/src/stack.ts`).

**Full-stack apps.** `packages/framework` (on React Router's data router) scans `app/routes` into a route manifest (`routes.ts`), generates entry files into `<project>/.forge/gen` (`generate.ts`), and bundles for the browser and the server with `Bun.build` (`build.ts`; if the project has `bun-plugin-tailwind`, the browser build loads it from the project, which is how the shadcn/ui starter gets Tailwind v4). `server.tsx`'s `createApp` returns the `AppHost` that `startServer({ app })` calls for every request the engine doesn't own (`packages/runtime/src/server/server.ts`): it runs loaders with a per-request context, renders with `renderToReadableStream`, embeds `window.__FORGE__` (loader data, the TanStack query cache, the viewer, sanitized errors), and serves `/_app/*` and `public/`. `client.tsx` hydrates the document. Development is one process on the host with rebuild and live reload (`dev.ts`); the CLI loads the framework from the project at runtime (`packages/cli/src/app.ts`), and `engine prepare` builds the app inside the image while linking React from the engine so there is one copy. Convention docs: `apps/docs/content/framework.md`.

**Docs site.** `apps/docs` is a React single-page app: `bun run --cwd apps/docs build` bundles `index.html` (-> `src/main.tsx`) with `Bun.build` into `dist/` (`--serve` previews on :4000). Pages are `content/*.mdx`, loaded one chunk per page through `PAGES` in `src/nav.ts`, which also holds the sidebar `GROUPS` (a new page goes in both; the build fails if they disagree, or if a link to `x.html` names no page). `mdx.ts` is the Bun plugin that compiles them with `@mdx-js/mdx` and a remark plugin: heading ids (repeats get `-1`, `-2`), the outline (`headings` export) and `search.json`, links rewritten from `page.html#id` to routes, and fenced code highlighted at build time by `highlight.ts` (Shiki, both themes as CSS variables) into `<Code>`. Add components for pages in `components` in `src/Doc.tsx`. `src/Landing.tsx` is the landing page; its code samples come from `src/snippets.ts`, run as a Bun macro so Shiki never ships. Its motion (blur-in words, pointer grid and card spotlight, reveal on scroll, count-up, marquee) is CSS in `landing.css` plus small hooks, after ReactBits, and stops under `prefers-reduced-motion`. `style.css` and `landing.css` are the styles; Geist fonts come from `@fontsource-variable/*` and are inlined into the CSS by Bun. `static.tsx` then writes what readers without JavaScript need: `<page>/index.html` (the page's text rendered with `react-dom/server` into the built shell, replaced by the app on load, so no hydration), `<page>.md` (the source with page links pointing at `.md`), `llms.txt`, `llms-full.txt`, `robots.txt`, `404.html` and, with `SITE_URL` set at build time, `sitemap.xml` and canonical links; the build fails if a page lacks its text or a page is missing from `llms.txt`. Each page has a Copy page button (`CopyPage` in `src/Doc.tsx`). Routes are root-relative, so the host serves the site from its root and answers a missing path with `404.html` and status 404. `compose.yaml`, `Dockerfile` and `Caddyfile` in `apps/docs` build the site and serve `dist` with Caddy (the service only `expose`s port 80, for a proxy such as Coolify's to reach; run it locally with `docker compose run --build --rm -p 8080:80 docs`) (a page is a folder with an `index.html`, anything missing answers `404.html` with status 404, hashed `chunk-*` files are cached for a year; `SITE_URL` is a build argument); the Dockerfile copies only `apps/docs`, so it does not use the root lockfile. The intro page is `introduction`.

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
