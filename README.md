# archlast-forge

A Convex-style reactive backend on tRPC and Bun. You declare a schema and typed functions in `convex/`, and clients subscribe to queries that push new results when the data they read changes. It runs on bun:sqlite or Postgres, with an in-memory or Redis bus and cache, Better Auth for sign-in, and optional S3-compatible storage (RustFS, AWS S3).

## Quick start

Requires Bun 1.4.3 (`mise install` picks it up from `mise.toml`).

```bash
bun install
bun run dev        # demo backend on :3000 (+ dashboard at /_dashboard) and Vite on :5173
```

Open http://localhost:5173 in two tabs, create an account, and add todos. Changes in one tab appear in the other. The backend prints the dashboard's admin key on startup.

File attachments need storage. Run `bun run services:up`, then `cp apps/demo/convex/.env.example apps/demo/convex/.env`.

## Writing a backend

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@archlast-forge/runtime";

export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({ listId: v.id("lists"), title: v.string(), done: v.boolean(), ownerId: v.id("users") })
    .index("by_list", ["listId"]),
});
```

```ts
// convex/todos.ts
import { mutation, query, v } from "@archlast-forge/runtime";

export const listByList = query({
  args: { listId: v.id("lists") },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

export const add = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  handler: async (ctx, args) => {
    const identity = await ctx.auth.getUserIdentity();
    if (!identity) throw new Error("unauthenticated");
    return ctx.db.insert("todos", { ...args, done: false, ownerId: identity.userId });
  },
});
```

```tsx
// src/App.tsx: import only @archlast-forge/react and convex/_generated
const todos = useQuery(api.todos.listByList, { listId }); // Todo[] | undefined, live
const add = useMutation(api.todos.add);
```

- **query** reads from one snapshot and is reactive. **mutation** is one transaction, and its topics publish after commit. **action** does external I/O and reaches the database only through `ctx.runQuery` and `ctx.runMutation`.
- `ctx.storage` creates presigned upload and download URLs. `ctx.scheduler.runAfter/runAt` schedules mutations and actions. `convex/crons.ts` defines `cronJobs()` (UTC).
- `users`, `sessions`, `accounts` and `verifications` are built in, managed by Better Auth. To customize sign-in, add `convex/auth.ts` with `export default defineAuth({...})`.
- `archlast-forge codegen` writes `convex/_generated/`. Types come from your validators and handlers, so changing a validator breaks its call sites at compile time.

### Server dependencies

Add packages to `convex/package.json` (`bun add --cwd convex zod`). The browser bundle never sees them. `dev` and `codegen` reinstall when the manifest or lockfile changes, and `dev` restarts only the function runtime. Installs pass `--ignore-scripts`. If a package needs its install script, list it in `"trustedDependencies"` in `convex/package.json`, and Bun runs scripts for those packages only.

## CLI

| Command | What it does |
|---|---|
| `archlast-forge dev` | Codegen, install server deps, serve, and watch `convex/`. Restarts only the function runtime on changes. |
| `archlast-forge codegen` | Writes `convex/_generated/` and checks that `src/` imports only `convex/_generated`. |
| `archlast-forge migrate` | Syncs tables and indexes, and reports documents that don't match the schema. |
| `archlast-forge start` | Production server. Requires `BETTER_AUTH_SECRET`. |
| `archlast-forge dashboard` | Prints the dashboard URL. |

## Configuration

| Variable | Default | |
|---|---|---|
| `DATABASE_URL` | bun:sqlite at `DATA_DIR/app.db` | `postgres://…` for Postgres |
| `DATA_DIR` | `./data` | SQLite and dev secrets |
| `REDIS_URL` | in-memory bus and cache | Required when `REPLICAS > 1` |
| `REPLICAS` | `1` | Declares a multi-server deployment, checked at startup |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | storage off | RustFS or any S3-compatible service |
| `BETTER_AUTH_SECRET` | generated in dev | Required in production |
| `BETTER_AUTH_URL` | the server's URL | |
| `TRUSTED_ORIGINS` | none | Comma-separated browser origins, for CORS and Better Auth |
| `ADMIN_KEY` | generated in dev | Dashboard access. Without it, the dashboard is disabled. |
| `CACHE_TTL_MS` | `60000` (`0` in dev) | Query result cache |
| `PORT` | `3000` | |

## Repository

```
apps/demo/            React todo app (Vite), set up like a user project
apps/demo/convex/     its backend: schema, functions, crons, auth; own package.json
packages/runtime/     engine: validators, schema, functions, Db/Bus/Cache/Storage + adapters, server
packages/client/      framework-agnostic client: tRPC over HTTP + WebSocket, live queries, TanStack sync
packages/react/       ArchlastForgeProvider, useQuery, useMutation, useAction, useSession
packages/cli/         archlast-forge dev | codegen | migrate | start | dashboard
packages/dashboard/   admin UI served at /_dashboard
docs/decisions.md     design decisions and known shortcuts
```

## Testing

```bash
bun run test              # SQLite and in-memory adapters only
bun run services:up       # Postgres, Redis and RustFS in Docker
bun run test:all          # adds the Postgres, Redis, S3 and two-server tests
bun run typecheck         # includes the compile-time type tests
```
