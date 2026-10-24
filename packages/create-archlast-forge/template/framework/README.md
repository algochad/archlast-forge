# __NAME__

A full-stack app on [archlast-forge](https://github.com/algochad/archlast-forge): server-rendered React pages, a typed backend and live queries, served by one container.

```bash
bun install
bun run dev      # http://localhost:3000, reloading as you edit
```

## Where things are

```
app/
  root.tsx           the HTML document, header and footer around every page
  routes/            one file per page: index.tsx is /, chat.tsx is /chat, [id].tsx is /:id
  styles.css
forge/               your backend: schema.ts and functions
public/              served as they are: /favicon.svg, /robots.txt
```

- A route's `loader` runs on the server for the first load and in the browser after that. `ctx.query(api.x.y, args)` fetches data and keeps it live for `useQuery`.
- `useViewer()` is the signed-in user, already right in the server-rendered HTML.
- Server-only packages go in `forge/package.json`; pages may import only `forge/_generated`.
- The admin dashboard is at http://localhost:3000/_dashboard (the key is printed on start).

## Deploy

```bash
bun run up       # builds the image, starts the stack from compose.yaml, waits until it is healthy
bun run down
```

`bun run build && bun run start` runs the production bundles on this machine without Docker. `compose.yaml` is yours to edit; secrets are in `.env`, which `up` creates and git ignores.
