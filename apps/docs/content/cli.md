# CLI reference

`archlast-forge <command>`. Options that apply everywhere: `--dir <forge dir>`, `--port <n>`, `--no-docker`.

## Start

| Command | What it does |
|---|---|
| `init [dir]` | Creates a project; the same as `bun create archlast-forge`. Asks whether it is a full-stack app or a backend and which services to include. `--mode framework\|backend`, `--services postgres,redis,s3,caddy` (or `none`), `--yes` to ask nothing, `--no-install`, `--no-git`. |

## Develop

| Command | What it does |
|---|---|
| `dev` | A full-stack app: the engine and the app in this process, rebuilding and reloading on save, with your services in Docker. A backend: the engine in Docker with `forge/` mounted; edits restart only the function runtime. `--with postgres,redis,s3` overrides the services in `archlast-forge.json`; `--run "<cmd>"` runs a command alongside; `--no-docker` runs a backend's engine in this process. |
| `codegen` | Writes `forge/_generated/`, installs server dependencies when they change, and checks that `app/` and `src/` import only `forge/_generated`. |

## Ship

| Command | What it does |
|---|---|
| `up` | Builds the app image and starts the stack in `compose.yaml`: the app and its services. Creates `.env` with secrets on the first run. `--rebuild` ignores the build cache. |
| `down [--volumes]` | Stops the stack. `--volumes` also deletes its data. |
| `logs [service]`, `status` | Follow the logs; show what is running. |
| `build [--tag image]` | Builds the app image: the engine plus your code and dependencies. With `--no-docker`, a full-stack app's production bundles only. |
| `start` | Runs production. With `--no-docker`, in this process (a full-stack app needs `build --no-docker` first). With `--image <tag> [--env-file f]`, one image in Docker with `restart unless-stopped`. |
| `stop` | Stops a single engine container from an older project; with a stack, the same as `down`. |

## Data and configuration

| Command | What it does |
|---|---|
| `migrate` | Syncs tables and indexes and reports documents that don't match the schema. `--run-migrations [name…]` and `--status` handle [data migrations](migrations.html). |
| `export <file>`, `import <file> [--replace]`, `backup <file>` | Data portability. |
| `env list`, `env get`, `env set NAME value`, `env rm NAME` | Variables for your functions (`process.env`). Setting one reloads the running engine. |
| `admin add <email> [--role owner\|admin\|viewer] [--password p]`, `admin list`, `admin remove` | Dashboard accounts. |
| `dashboard` | Prints the dashboard's address. |
| `engine build` | Builds the engine image from this repository. |

When an engine container is running, data and config commands run inside it, through `docker exec`.

## archlast-forge.json

```json
{ "mode": "framework", "services": ["postgres", "redis"] }
```

`mode` is `framework` or `backend`. `services` is what `dev` starts; `compose.yaml` is what `up` runs, and is edited by hand. A project without this file behaves as a backend with no services.

Server dependencies in `forge/package.json` are installed with `--ignore-scripts`. If a package needs its install script, list it under `"trustedDependencies"` and Bun runs scripts for that package only.
