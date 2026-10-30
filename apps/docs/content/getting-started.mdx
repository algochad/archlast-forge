# Getting started

This page takes you from nothing to a running project, a first change, the dashboard and a production build. It covers both project modes. If you would rather build something real straight away, go to the [tutorial](tutorial.html).

## Prerequisites

- **[Bun](https://bun.sh) 1.4.3 or later.** Check with `bun --version`. The project pins 1.4.3 in `mise.toml`; if you use [mise](https://mise.jdx.dev), `mise use bun@1.4.3` installs it. Node.js is not needed: the engine uses Bun's SQLite, HTTP server and Redis and S3 clients.
- **Docker, sometimes.** You do not need it to develop a full-stack app on SQLite. You need it to run services (PostgreSQL, Redis, storage) during development, to develop in backend mode (the engine runs in a container, unless you pass `--no-docker`), and to deploy with `bun run up`. `DOCKER=podman` switches the binary.
- A modern browser for the app and the dashboard.

## Create a project

```bash
bun create archlast-forge my-app
```

`bun create archlast-forge` and `bunx create-archlast-forge` and `archlast-forge init` are the same program. It only writes into an empty or new folder, and refuses a folder that already has files in it.

### The prompts

When run in a terminal, it asks up to five questions, skipping any you answered with a flag:

| Prompt | Choices | Notes |
|---|---|---|
| Where should we create your project? | a folder name (default `my-app`) | The folder name also becomes the package name and the Docker Compose project name, lowercased and with other characters turned into `-`. |
| What are you building? | **Full-stack app** or **Backend only** | Full-stack: React pages rendered on the server, file routes and your backend, all in one container. Backend: the engine and its services, for any frontend or none. See [Full-stack apps](framework.html) and [Backends](backend.html). |
| Add services to the stack? (backend: Which services should run with it?) | PostgreSQL, Redis, S3 storage (RustFS), Caddy | PostgreSQL replaces the SQLite file with a shared database. Redis carries reactivity between several servers, and holds the cache and rate limits. S3 storage is for file uploads. Caddy puts HTTPS with automatic certificates in front of the app. A full-stack app starts with none, because SQLite needs nothing. A backend starts with PostgreSQL, Redis and S3 storage. |
| Install dependencies with bun? | yes or no | Runs `bun install` in the new folder. |
| Start a git repository? | yes or no | Runs `git init`. |

You can change the mode's services later by editing `archlast-forge.json` (what `dev` starts) and `compose.yaml` (what `up` runs).

### Flags

Flags skip the questions. `--yes` takes the default for everything you did not give and asks nothing; it needs a folder name. Without a terminal, or when `CI` is set, it behaves as if you had passed `--yes`.

| Flag | Meaning |
|---|---|
| `--mode framework\|backend` (`-m`) | the project mode. The default with `--yes` is `framework`. |
| `--services postgres,redis,s3,caddy` (`-s`) | a comma-separated list, or `none`. The default is none for `framework` and `postgres,redis,s3` for `backend`. |
| `--install` / `--no-install` | run `bun install` afterwards, or not. With `--yes` the default is not. |
| `--git` / `--no-git` | start a git repository, or not. With `--yes` the default is not. |
| `-y`, `--yes` | ask nothing |
| `-h`, `--help` | print usage |

```bash
bun create archlast-forge my-app --mode framework
bun create archlast-forge api --mode backend --services postgres,redis,s3 --yes
bun create archlast-forge site --mode framework --services caddy --install --git
```

This is the output of the non-interactive form:

```
$ bunx create-archlast-forge my-app --mode framework --yes --no-install --no-git
│
◆  Created my-app (full-stack app)
│
◇  Next ───────────────────────────────────────────────────────────────╮
│                                                                      │
│  cd my-app                                                           │
│  bun install                                                         │
│  bun run dev                                                         │
│                                                                      │
│  Your app: http://localhost:3000                                     │
│  Dashboard: http://localhost:3000/_dashboard                         │
│                                                                      │
│  To deploy: bun run up   (builds the image and starts the stack in   │
│  compose.yaml)                                                       │
│                                                                      │
├──────────────────────────────────────────────────────────────────────╯
│
└  Happy building.
```

For a backend with services the first line reads `Created api (backend only, with PostgreSQL, Redis, S3 storage (RustFS))`.

## Run it

```bash
cd my-app
bun install
bun run dev
```

### A full-stack app

```
✓ codegen: 1 modules
✓ app built in 162 ms

  archlast-forge 0.1.0  ·  full-stack app  · ready in 737 ms

  ➜  App        http://localhost:3000
  ➜  Dashboard  http://localhost:3000/_dashboard
  ➜  Admin key  <48 hex characters>

  Save a file and the page reloads. Ctrl-C stops everything.
```

The timings vary. Everything runs in this one process on your machine: the engine, your functions (in a child process that restarts alone when `forge/` changes) and the app, which rebuilds in a fraction of a second and reloads the browser when you save. Services you chose run in Docker with their ports on localhost, and stop when you press Ctrl-C; their data is kept in named volumes. Use `--port 3100` if 3000 is taken.

Open http://localhost:3000. The starter is a small chat: create an account on the Sign in page, then open the chat in two windows and watch both update.

### A backend

In backend mode `bun run dev` starts the engine in a Docker container with `forge/` mounted, and the services listed in `archlast-forge.json` next to it. Edits to `forge/` restart only the function runtime; open connections stay up. The server answers at http://localhost:3000.

If you have no Docker handy, run the engine in your own process instead. It uses SQLite and ignores the services:

```
$ bunx archlast-forge dev --no-docker
! Not starting postgres, redis, s3 without Docker; using SQLite. Set DATABASE_URL, REDIS_URL or S3_* yourself to use others.

  archlast-forge 0.1.0  ·  backend  · in this process

  ➜  API        http://localhost:3000
  ➜  Dashboard  http://localhost:3000/_dashboard
  ➜  Admin key  <48 hex characters>
```

The starter has an HTTP route you can call at once:

```bash
curl localhost:3000/http/hello
# {"message":"Hello from api"}
```

## What was generated

### A full-stack app

```
my-app/
  archlast-forge.json   { "mode": "framework", "services": [] }
  package.json          scripts: dev, build, start, codegen, typecheck, up, down
  tsconfig.json         for app/ (strict, React JSX)
  app/
    root.tsx            the HTML document, the header and footer around every page, the error page
    styles.css          the starter's styles; imported from root.tsx
    env.d.ts            declares the file types you may import (.css, .svg, .png)
    routes/
      index.tsx         /
      chat.tsx          /chat, a live, paginated list with a loader that preloads it
      sign-in.tsx       /sign-in, sign-in and sign-up with Better Auth
  forge/
    package.json        server-only dependencies (@archlast/forge-runtime)
    tsconfig.json       for forge/
    schema.ts           the tables: `messages`, with a search index
    messages.ts         functions: list, search, send
    _generated/         api, internal, dataModel: written by codegen, committed
  public/               served as they are: favicon.svg, robots.txt
  compose.yaml          the production stack
  Dockerfile            your code on the engine image
  .dockerignore
  .env                  secrets for the stack: created for you, kept out of git
  .env.example          the same keys, empty
  .gitignore
  README.md
```

`forge/_generated/` appears after the first `bun run dev`, `bun run codegen` or `bun run typecheck`. Commit it: your frontend imports from it.

The files you will edit most:

- **`forge/schema.ts`** declares tables with `defineTable`, validators from `v`, and indexes. `users`, `sessions`, `accounts` and `verifications` come with Better Auth and are not declared. See [Schema and validators](schema.html).
- **`forge/messages.ts`** is a module of functions. Each export of `query`, `mutation` or `action` is callable as `<file>:<export>`, here `messages:list`. See [Functions](functions.html).
- **`app/root.tsx`** exports `Layout` (the `<html>` document), a default component with the chrome and an `<Outlet />`, and an `ErrorBoundary`.
- **`app/routes/`** has one file per page; the filename is the URL. `[id].tsx` is a parameter. See [Full-stack apps](framework.html).
- **`archlast-forge.json`** holds the mode and the services `dev` starts. **`compose.yaml`** is what `up` runs. It is yours to edit after it is written.
- **`.env`** holds `BETTER_AUTH_SECRET`, `ADMIN_KEY`, the public address and the port. It is created with random secrets (mode 0600) and never overwritten.

### A backend

```
api/
  archlast-forge.json   { "mode": "backend", "services": ["postgres", "redis", "s3"] }
  package.json          scripts: dev, codegen, typecheck, up, down, logs
  forge/
    package.json  tsconfig.json
    schema.ts           the same `messages` table
    messages.ts         list, search, send
    http.ts             GET /http/hello
    files.ts            generateUploadUrl and url (only when S3 storage is selected)
  compose.yaml          the app plus PostgreSQL, Redis and RustFS, with health checks
  Dockerfile  .dockerignore  .env  .env.example  .gitignore  README.md
```

There is no `app/`. A frontend lives wherever you like and imports the generated `api` from `forge/_generated`. Anything that imports from `forge/` other than `_generated` fails codegen, so server code never reaches a bundle.

## Make a first change

### In a full-stack app

Keep `bun run dev` running. Create a function, then a page that uses it.

```ts
// forge/hello.ts
import { query, v } from "@archlast/forge-runtime";

export const greet = query({
  args: { name: v.string() },
  handler: (ctx, { name }) => `Hello, ${name}!`,
});
```

```tsx
// app/routes/about.tsx
import type { LoaderArgs } from "@archlast/forge-framework";
import { useQuery } from "@archlast/forge-react";
import { api } from "../../forge/_generated/api";

export const loader = async ({ ctx }: LoaderArgs) => {
  await ctx.query(api.hello.greet, { name: "world" }); // runs on the server and fills the live cache
  return null;
};

export default function About() {
  const greeting = useQuery(api.hello.greet, { name: "world" });
  return (
    <main className="container">
      <title>About</title>
      <h1>{greeting}</h1>
    </main>
  );
}
```

Save both. The terminal shows the function runtime restarting and the app rebuilding, the types in `forge/_generated/api.ts` gain `hello`, and http://localhost:3000/about answers with `<h1>Hello, world!</h1>` in the HTML itself, before any JavaScript runs. That is the loader at work: `ctx.query` ran the query on the server and put the result where `useQuery` looks for it. Remove the loader and the page renders its first frame with `greeting` undefined, then fills in once the subscription connects.

To see a page change, edit the heading in `app/routes/index.tsx` and save; the browser reloads on its own.

Type errors show up in your editor, or run `bun run typecheck` (codegen, then `tsc`).

### In a backend

Add a function to `forge/`; the engine restarts only its function runtime and your open connections stay up.

```ts
// forge/greetings.ts
import { query, v } from "@archlast/forge-runtime";

export const hello = query({
  args: { name: v.string() },
  handler: (ctx, { name }) => `Hello, ${name}!`,
});
```

Call it. Every public function is `POST /rpc/<file>:<export>` with JSON arguments, and queries also answer `GET` with `?args=<json>`:

```bash
curl -X POST localhost:3000/rpc/greetings:hello -H 'content-type: application/json' -d '{"name":"Ada"}'
# {"result":"Hello, Ada!"}

curl -G localhost:3000/rpc/greetings:hello --data-urlencode 'args={"name":"Ada"}'
# {"result":"Hello, Ada!"}

curl -X POST localhost:3000/rpc/greetings:hello -H 'content-type: application/json' -d '{}'
# {"error":{"message":"args.name is required","code":"BAD_REQUEST","requestId":"..."}}
```

From TypeScript, with types:

```ts
import { ArchlastForgeClient } from "@archlast/forge-client";
import { api } from "./forge/_generated/api";

const client = new ArchlastForgeClient({ url: "http://localhost:3000" });
console.log(await client.query(api.greetings.hello, { name: "Ada" })); // "Hello, Ada!"
client.watch(api.messages.list, { paginationOpts: { numItems: 20, cursor: null } }, (update) => console.log(update)); // live
```

Add your frontend's origin to `TRUSTED_ORIGINS` so its cookies and requests are accepted. React, Vue and Svelte bindings are described in [Clients](clients.html).

## The dashboard

`/_dashboard` is on in development. Open http://localhost:3000/_dashboard and sign in with the **admin key** that `dev` printed (it is the `ADMIN_KEY` in your `.env`). From there you can:

- browse tables, filter by index, and edit or insert documents with validation (the **Data** page);
- run any function with a form generated from its validators, as any user (**Functions**);
- watch logs, call latency and subscriptions, the cache hit rate, scheduled jobs, uploaded files and users.

Prefer a named account over the shared key. With the server running:

```bash
bunx archlast-forge admin add you@example.com --role admin --password 'a-long-password'
# ✓ you@example.com (admin)
```

Roles are `viewer` (read), `admin` (edit data, run functions) and `owner`. Every change is recorded in the audit log. In production the dashboard is off unless you set `DASHBOARD=on` (the stack's `compose.yaml` does). See [Dashboard](dashboard.html).

## Production in one command

```bash
bun run up
```

`up` builds an image of your app (your code and dependencies on top of the engine image), creates `.env` with secrets if it is missing, starts the stack in `compose.yaml`, waits for the health check, and prints the addresses. `bun run down` stops it; the data stays in Docker volumes (`down --volumes` deletes them). `bun run logs` follows the logs and `archlast-forge status` shows what is running. Docker is required. The engine image comes from `ghcr.io/algochad/archlast-forge-engine`, tagged with the CLI version.

The stack as generated serves plain HTTP on port 3000 and sets `ALLOW_INSECURE_HTTP=1`, so you can try it. For a real deployment, put it behind TLS: choose the Caddy service when you create the project, or set `BETTER_AUTH_URL` to your `https://` address and remove `ALLOW_INSECURE_HTTP`. Outside development the engine refuses to start without `BETTER_AUTH_SECRET` and without an `https://` `BETTER_AUTH_URL`. See [Deployment](deployment.html).

To run the production build on this machine without Docker (a full-stack app):

```bash
bun run build
```

```
→ Building the app
✓ Building the app 1.6s
  first load  entry.client.js 387 kB (107 kB compressed), entry.client.css 5.3 kB (1.5 kB compressed)
  all code   6 files, 395 kB; each page loads only the routes it shows

Run it here with: archlast-forge start --no-docker
```

```bash
bun run start
# ✓ archlast-forge on http://localhost:3000 (app and API)
```

`start` reads the same `.env`. The SQLite file is `forge/data/app.db`, the same one `dev` uses, unless you set `DATA_DIR`.

## Projects from before modes existed

A project without `archlast-forge.json` keeps working as a backend with no services. To get the stack files for it, create a new project and copy `archlast-forge.json`, `compose.yaml`, `Dockerfile` and `.dockerignore` across.

## Where to go next

- **Learn by building:** the [tutorial](tutorial.html) makes a notes app with auth, search, optimistic updates and deployment.
- **Understand the model:** [How it works](concepts.html).
- **Full-stack apps:** [routes, loaders and the page head](framework.html). **Backends:** [the stack and how frontends connect](backend.html).
- **Your data:** [Schema and validators](schema.html), [Reading data](queries.html), [Migrations](migrations.html).
- **Functions and behaviour:** [Functions](functions.html), [Reactivity](reactivity.html), [Authentication](auth.html), [File storage](storage.html), [Scheduling](scheduling.html), [HTTP endpoints](http.html).
- **Running it:** [CLI reference](cli.html), [Deployment](deployment.html), [Configuration](configuration.html), [Limits and security](limits.html).
- **Stuck?** [Troubleshooting](troubleshooting.html).
