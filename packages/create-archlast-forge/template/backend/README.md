# __NAME__

A backend on [archlast-forge](https://github.com/algochad/archlast-forge): your schema and functions in `forge/`, running in a container next to its database, cache and storage.

```bash
bun install
bun run dev      # the engine in Docker, reloading as you edit forge/
bun run up       # the production stack from compose.yaml
```

## Develop

`bun run dev` starts the engine with `forge/` mounted, and the services listed in `archlast-forge.json`. Edits restart only your functions; open connections stay up.

- Dashboard: http://localhost:3000/_dashboard (the admin key is printed on start)
- Try the example function: `curl localhost:3000/http/hello`

Your frontend, whatever it is, talks to this server:

```ts
import { ArchlastForgeClient } from "@archlast-forge/client";
import { api } from "./forge/_generated/api";

const client = new ArchlastForgeClient({ url: "http://localhost:3000" });
const page = await client.query(api.messages.list, { paginationOpts: { numItems: 20, cursor: null } });
client.watch(api.messages.list, { paginationOpts: { numItems: 20, cursor: null } }, (update) => console.log(update)); // live
```

React, Vue and Svelte bindings are `@archlast-forge/react`, `@archlast-forge/vue` and `@archlast-forge/svelte`. Add your frontend's origin to `TRUSTED_ORIGINS` so its cookies and requests are accepted.

## Deploy

```bash
bun run up       # builds the image, starts everything, waits until it is healthy
bun run logs
bun run down     # stops it; data stays in Docker volumes
```

`compose.yaml` is the stack. It is yours to edit. Secrets live in `.env`, which `up` creates and git ignores; `.env.example` lists the keys. To put it on a server, copy the project there and run `bun run up` (or `docker compose up -d --build`).
