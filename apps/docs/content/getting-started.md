# Getting started

You need [Bun](https://bun.sh) 1.4.3 or later, and Docker (optional, but the default).

```bash
bun create archlast-forge my-app
cd my-app
bun install
bun run dev
```

`bun run dev` runs `archlast-forge dev --run vite`:

1. Codegen writes `convex/_generated/` (your typed `api`).
2. The engine starts in a Docker container with `convex/` mounted. Edits restart only the function runtime, and open WebSockets stay connected.
3. Vite serves the React app on http://localhost:5173 and proxies `/trpc` and `/api` to the engine on port 3000.

The dashboard is at http://localhost:3000/_dashboard. The admin key is printed on startup.

No Docker? Run `bun run dev -- --no-docker` to run the engine inside the CLI process.

## Project layout

```
convex/
  schema.ts          tables, indexes and search indexes
  messages.ts        queries, mutations and actions
  crons.ts           optional: recurring jobs
  auth.ts            optional: Better Auth options
  package.json       server-only dependencies
  _generated/        written by codegen, don't edit
src/                 your frontend; imports only convex/_generated and @archlast-forge/react
```

Server-only packages go in `convex/package.json` (`bun add --cwd convex zod`). They never reach the browser bundle, and codegen fails if `src/` imports anything from `convex/` other than `_generated`.
