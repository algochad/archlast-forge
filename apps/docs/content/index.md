# archlast-forge

archlast-forge is a self-hosted reactive backend for TypeScript apps, in the style of Convex. You declare a schema and functions in a `forge/` folder. Clients call those functions with end-to-end types, and live queries push new results whenever the data they read changes.

- **One engine, your infrastructure.** The engine runs as a Docker container that the CLI starts and controls. It stores data in a local Turso (SQLite-compatible) file or Postgres. Add Redis for multi-server deployments and any S3-compatible service (RustFS, AWS S3) for files.
- **Typed from schema to UI.** Validators define your data and arguments. Codegen derives a typed `api` object from your functions, so changing a validator breaks every call site at compile time.
- **Reactive by default.** A query's subscription re-runs only when a write touches a table, index range or document the query read.
- **Batteries included.** Better Auth sign-in, file uploads with presigned URLs, scheduled functions and crons, full-text search, pagination, data migrations, an admin dashboard, metrics and structured logs.

## How it fits together

```
your app (React / Vue / Svelte)  ── HTTP + WebSocket ──▶  engine container
                                                           ├─ server: routing, subscriptions, bus, cache, dashboard
forge/  (schema + functions)  ── mounted or baked in ──▶  └─ function runtime: your code, database, auth, scheduler
```

Start with [Getting started](getting-started.html).
