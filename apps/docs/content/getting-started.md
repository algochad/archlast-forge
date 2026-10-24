# Getting started

You need [Bun](https://bun.sh) 1.4.3 or later. Docker is optional while you develop a simple app, and is how you run databases, caches and storage, and how you deploy.

```bash
bun create archlast-forge my-app
```

You are asked two things.

**What are you building?**

- **Full-stack app.** React pages rendered on the server, file-based routes, live queries and your backend, all in one project and one container. Start here if the app is a website. See [Full-stack apps](framework.html).
- **Backend only.** `forge/` and a stack of containers: the engine with PostgreSQL, Redis and S3 storage. Bring any frontend, or none. See [Backends](backend.html).

**Which services?** PostgreSQL, Redis, S3 storage (RustFS) and Caddy (HTTPS). A full-stack app starts with none, because SQLite needs nothing. A backend starts with PostgreSQL, Redis and storage. Change either later in `archlast-forge.json` and `compose.yaml`.

Skip the questions with flags:

```bash
bun create archlast-forge my-app --mode framework
bun create archlast-forge api --mode backend --services postgres,redis,s3 --yes
```

## Run it

```bash
cd my-app
bun install
bun run dev
```

A full-stack app runs on this machine at http://localhost:3000 and reloads when you save. A backend's engine runs in Docker, with `forge/` mounted, and serves its API at the same address. Services you chose start in Docker, and stop when you press Ctrl-C. The admin dashboard is at `/_dashboard`; the admin key is printed on start.

## What you get

```
archlast-forge.json   the mode and the services
forge/                schema.ts, functions, crons.ts, auth.ts, http.ts, package.json
app/                  (full-stack apps) root.tsx and routes/
public/               (full-stack apps) files served as they are
compose.yaml          the production stack
Dockerfile            your app on the engine image
.env                  secrets for the stack; created for you, kept out of git
```

`bun run up` builds the image and starts the stack in `compose.yaml`; `bun run down` stops it. Details are in [Deployment](deployment.html).

Server-only packages go in `forge/package.json` (`bun add --cwd forge zod`). They never reach the browser. Codegen fails if your pages import anything from `forge/` except `_generated`.

## Projects from before this

A project without `archlast-forge.json` keeps working as a backend with no services. To get the stack files for it, create a new project with `archlast-forge init` and copy `archlast-forge.json`, `compose.yaml`, `Dockerfile` and `.dockerignore` across.

`archlast-forge init` is the same command as `bun create archlast-forge`; it only writes into an empty folder.
