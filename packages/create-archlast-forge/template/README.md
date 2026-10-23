# __NAME__

A realtime chat on [archlast-forge](https://github.com/algochad/archlast-forge).

```bash
bun install
bun run dev          # backend in Docker + Vite on http://localhost:5173
bun run dev -- --no-docker   # without Docker
```

- `forge/` is the backend: schema, queries and mutations. Server-only packages go in `forge/package.json`.
- `src/` is the React app; it imports only `@archlast-forge/react` and `forge/_generated`.
- The admin dashboard is at http://localhost:3000/_dashboard (the key is printed on startup).
