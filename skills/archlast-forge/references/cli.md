# The archlast-forge CLI: every command, flag and default

Read this when you run, script or choose any `archlast-forge` or `create-archlast-forge` command, or need to know what a command writes, where it runs (Docker, in process, inside a running server) and whether to ask the user first.
For what the generated files are see [scaffolding.md](scaffolding.md); for choosing a project shape [project-modes.md](project-modes.md); for configuration, deployment and debugging [operations.md](operations.md). Verified against `@archlast/forge-cli` 0.16.

## 1. Basics

**Invoke.** The CLI is `@archlast/forge-cli` (bin `archlast-forge`), a `devDependency` of every project. Inside a project use its scripts (`bun run dev`), `bunx archlast-forge <command>` or `./node_modules/.bin/archlast-forge`. With no project yet: `bun create archlast-forge <dir>`, `bunx create-archlast-forge <dir>` or `bunx --package @archlast/forge-cli archlast-forge init <dir>`. All three `init` forms are one program.

**Project scripts** the starters write: `dev` (`archlast-forge dev`), `codegen`, `typecheck` (`archlast-forge codegen && tsc --noEmit`, backend: `tsc -p forge --noEmit`), `up`, `down`, `format`; full-stack adds `build` (`build --no-docker`) and `start` (`start --no-docker`); backend adds `logs`. In a monorepo the root scripts are `turbo run dev|build|typecheck`; a service's or added app's `dev` is `archlast-forge dev --no-docker --port <n>`, and a backend main app that has services gets `--no-docker` too (a full-stack main app keeps plain `archlast-forge dev`).

**Which project a command acts on.** Commands look for the forge folder in this order: `--dir <path>`, `./forge/schema.ts`, `./schema.ts` (the cwd is the forge folder), `./convex/schema.ts` (old name, prints a warning). None: `✗ No schema.ts in <abs>. Pass --dir <path to forge/>.` The project root is the parent of `forge/`; `archlast-forge.json`, `compose.yaml`, `.env` live there.

| Command group                                                                           | `--dir` means                                                         | Where to run it                                                                      |
| --------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `dev codegen build up down start stop logs status stack monorepo` and the data commands | the **forge folder**                                                  | the project root, or an app of a monorepo (`cd apps/web`, or `--dir apps/web/forge`) |
| `add remove workspace`                                                                  | **any path inside** the monorepo (default: cwd)                       | anywhere in the monorepo                                                             |
| `upgrade`                                                                               | the forge folder; with no `--dir` it finds the monorepo above the cwd | a project, or a monorepo root or app                                                 |
| `init`                                                                                  | not used: the folder is the positional argument                       | anywhere                                                                             |

At a monorepo root (`archlast-forge.workspace.json`) `stack` and `monorepo` explain this; `dev`, `codegen`, `up` and the rest fail with `No schema.ts`. Run them in an app.

**Global options** (parsed for every command except `init`; an option a command doesn't use is ignored, an unknown one is an error):

| Option            | Default              | Meaning                                                                                           |
| ----------------- | -------------------- | ------------------------------------------------------------------------------------------------- |
| `--dir <path>`    | see above            | forge folder, or a path in the monorepo                                                           |
| `--port <n>`      | `$PORT`, else `3000` | port `dev` and `start` listen on; port data commands and `dashboard` use to find a running server |
| `--no-docker`     | off                  | run in this process; also `ARCHLAST_NO_DOCKER=1`                                                  |
| `--docker`        | off                  | fail instead of falling back when Docker is missing                                               |
| `-y`, `--yes`     | off                  | answer yes to confirmations (`monorepo`, `remove`)                                                |
| `--no-install`    | off                  | skip `bun install` and codegen after `monorepo`, `add`, `remove`, `workspace sync`                |
| `-h`, `--help`    |                      | print usage, exit 0                                                                               |
| `-v`, `--version` |                      | print the CLI version, exit 0                                                                     |

Other options belong to one command and are listed there: `--with --run --tag --image --env-file --rebuild --volumes --run-migrations --status --replace --no-files --config --role --password --mode --services --transport --microservices --mobile --desktop --dry-run --shadcn --no-shadcn --base-color --dev`.

`init` is handled before option parsing: it must be the **first** argument (`archlast-forge --yes init x` prints usage and exits 1) and takes only the scaffolder's options (section 3). `--install` and `--git` exist only on `init`; `add --install` is an unknown option.

**Output and exit codes.**

| Code | When                                                                                                                                                                                                                                |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 0    | success; `--help`, `--version`; no command (prints usage); Ctrl-C or SIGTERM of `dev`/`start`; `dev` when its container stops                                                                                                       |
| 1    | any `✗ <message>` (stderr); unknown command (prints usage); unknown option; a second signal while stopping; `migrate` found documents that don't match the schema; a confirmation with no terminal; a failed `engine`/`docker` step |
| 130  | Ctrl-C at an `init` prompt (`Cancelled. Nothing was created.`)                                                                                                                                                                      |

Lines: `✓` done, `→` working, `!` warning, `✗` error. Colors are off when stdout isn't a terminal, `NO_COLOR` is set or `TERM=dumb`; `FORCE_COLOR` turns them on. Spinners become plain lines.

**How an agent must run it (no terminal).**

- Nothing may prompt. `init`: give the folder and every choice as flags, or `--yes` (takes defaults, asks nothing). `monorepo` and `remove` ask a confirmation; with stdin not a terminal they change nothing and exit 1 with `...run it again with --yes`. Pass `--yes` only after the user agreed, and use `monorepo --dry-run` first.
- `dev`, `start --no-docker` and `logs` never exit on their own, `up` waits up to 240 s for health. Start long-running ones in the background, poll `http://localhost:<port>/health` (200 `{"ok":true}`; `/ready` is 503 until functions load), and stop them when done.
- Without Docker set `ARCHLAST_NO_DOCKER=1` (or `--no-docker`): a full-stack `dev` whose `archlast-forge.json` lists `postgres`, `redis` or `s3` otherwise stops with `This project uses postgres, which run in Docker, and Docker isn't available.`; `--no-docker` develops on SQLite instead.
- After any command that changes code structure, run `bun run codegen`, then `bun run typecheck`.

## 2. Command map

| Task              | Commands                                                                                                    | Safety                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| Scaffold          | [`init`](#init), [`upgrade`](#upgrade)                                                                      | writes files                                  |
| Evolve a monorepo | [`monorepo`](#monorepo), [`add`](#add), [`remove`](#remove), [`workspace`](#workspace), [`stack`](#stack)   | writes files; `remove` deletes folders        |
| Run               | [`dev`](#dev), [`codegen`](#codegen), [`build`](#build), [`start`](#start)                                  | starts processes, writes generated files      |
| Operate the stack | [`up`](#up), [`down`](#down), [`logs`](#logs), [`status`](#status), [`stop`](#stop)                         | Docker; `down --volumes` deletes data         |
| Data              | [`migrate`](#migrate), [`export`](#export), [`import`](#import), [`backup`](#backup), [`restore`](#restore) | act on the database                           |
| Config            | [`env`](#env), [`admin`](#admin), [`dashboard`](#dashboard)                                                 | change a running server's config and accounts |
| Engine            | [`engine`](#engine)                                                                                         | builds an image                               |

## 3. Scaffold

### init

```bash
archlast-forge init [dir] [options]      # same as: bun create archlast-forge [dir] / bunx create-archlast-forge [dir]
bun create archlast-forge my-app --yes --no-git
bun create archlast-forge api --mode backend --services postgres,redis --yes
bun create archlast-forge shop --monorepo --microservices orders,billing --yes
```

Creates a project in `dir`, which must not exist or must be empty (any file, even `.git`, counts; `init .` in a used folder fails). The folder name becomes the project and package name (lowercased; anything but letters, digits, `-`, `_` becomes `-`).

| Option                                                   | Default (no prompt)                                              | Meaning                                                                                                                             |
| -------------------------------------------------------- | ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `dir` (positional)                                       | none: required without a terminal                                | `✗ Which folder? Pass a directory: bun create archlast-forge my-app`                                                                |
| `-m`, `--mode <framework\|backend>` (`--template` alias) | `framework`                                                      | full-stack React app, or backend (engine and services, no pages)                                                                    |
| `-s`, `--services <list>`                                | framework `postgres,redis,s3,caddy`; backend `postgres,redis,s3` | any of `postgres redis s3 caddy`, comma separated, or `none` (SQLite, no containers)                                                |
| `--shadcn`, `--no-shadcn`                                | shadcn on (framework only)                                       | shadcn/ui with Tailwind v4, or the plain stylesheet. `--shadcn` with `--mode backend` is an error                                   |
| `--base-color <name>`                                    | `neutral`                                                        | `neutral stone zinc mauve olive mist taupe`; fixed at creation; implies `--shadcn`; an error with `--no-shadcn` or `--mode backend` |
| `--monorepo`                                             | off                                                              | Turborepo monorepo: apps in `apps/`, `packages/api`                                                                                 |
| `--microservices <a,b>`                                  | none                                                             | backends beside the app (names `^[a-z][a-z0-9-]{0,30}$`, not `web api mobile desktop`, no repeats). Implies `--monorepo`            |
| `--transport <forge-rpc\|tcp\|redis\|nats>`              | `forge-rpc`                                                      | how services talk. Implies `--monorepo`                                                                                             |
| `--mobile`                                               | off                                                              | Expo app in `apps/mobile` (client of the main app). Implies `--monorepo`                                                            |
| `--desktop <full\|client>`                               | none                                                             | Tauri app in `apps/desktop`; `full` needs `--mode framework`. Implies `--monorepo`                                                  |
| `--install`, `--no-install`                              | **no install**                                                   | run `bun install` afterwards                                                                                                        |
| `--git`, `--no-git`                                      | **no git init**                                                  | run `git init -q`                                                                                                                   |
| `-y`, `--yes`                                            |                                                                  | never ask; take defaults                                                                                                            |
| `-h`, `--help`                                           |                                                                  | usage, exit 0                                                                                                                       |

**Prompts and the flag that answers each.** It asks only when stdin and stdout are terminals, `CI` is unset and `--yes` is absent; otherwise every missing answer takes the default above. Note `--yes` means no install and no git unless you also pass `--install` / `--git`.

| Prompt                                                             | Answered by                                 |
| ------------------------------------------------------------------ | ------------------------------------------- |
| Where should we create your project?                               | `dir`                                       |
| What are you building?                                             | `--mode`                                    |
| Add shadcn/ui? (framework)                                         | `--shadcn` / `--no-shadcn` / `--base-color` |
| Which base color for the theme?                                    | `--base-color`                              |
| Which services will production need?                               | `--services`                                |
| Add a React Native (Expo) app?                                     | `--mobile`                                  |
| Add a desktop app (Tauri)?                                         | `--desktop`                                 |
| One app, or a monorepo? (asked only if neither mobile nor desktop) | `--monorepo`                                |
| Microservices to add beside the app?                               | `--microservices`                           |
| How do the services talk? (asked only with microservices)          | `--transport`                               |
| Install dependencies with bun?                                     | `--install` / `--no-install`                |
| Start a git repository?                                            | `--git` / `--no-git`                        |

Errors (exit 1): `Unknown mode "x". Choose framework or backend.` (and usage), `Unknown service "mysql". Choose from postgres, redis, s3, caddy, or "none".`, `Unknown transport`, `Unknown desktop mode`, `<dir> already has files in it. Pick an empty folder or a new name.`, `--desktop full ... use --mode framework`. A failed `bun install` or `git init` is reported and the project stays.

Writes: the starter, `archlast-forge.json`, `compose.yaml`, `Dockerfile`, `.dockerignore`, `.env` (fresh secrets, 0600) and `.env.example`, `Caddyfile` (with `caddy`), `.prettierrc` (4 spaces), `.prettierignore`, then formats everything. A monorepo adds `package.json` (workspaces), `turbo.json`, `archlast-forge.workspace.json`, `packages/api`, and for services `packages/contracts`. Details: [scaffolding.md](scaffolding.md).

After it: `cd <dir> && bun install && bun run codegen` (when you skipped install), then `bun run dev`.

### upgrade

```bash
archlast-forge upgrade [version] [--dir <forge dir>]     # version: 0.16.1, or a dist-tag; default latest
```

Moves the project to a release. Resolves the version with `bun info @archlast/forge-runtime@<version>` on the project's registry (`✗ Couldn't find archlast-forge 0.42.0 on the registry`: nothing changes). Then, in order:

1. `package.json` and `forge/package.json`: every `@archlast/forge-*` and `create-archlast-forge` dependency with a version keeps its `^`/`~` and gets the new one. `workspace:`, `file:` and tag specifiers are left.
2. `Dockerfile`, `compose.yaml`: the `ghcr.io/algochad/archlast-forge-engine:<version>` tag (a non-version tag like `latest` stays).
3. Prettier where missing: `.prettierrc` (only if there is no Prettier config at all), `.prettierignore`, a `format` script, `prettier` devDependency. Existing code is not reformatted.
4. `bun install` in the project root and then `forge/` (`--ignore-scripts` unless `trustedDependencies`).
5. `codegen` with the CLI just installed.

In a **monorepo** (run from its root or any app) every app that has `archlast-forge.json` is upgraded the same way, the other apps and packages (mobile, desktop, `packages/api`, `packages/contracts`) have their archlast-forge dependencies moved, one `bun install` runs at the root, then each project's server dependencies and codegen. Prettier is not added there. Output ends `✓ Upgraded to <version>`, `✓ Nothing to change: the project is on <version>`, or `✓ Set up Prettier; the project was already on <version>`.
If `bun install` fails the version edits are already on disk: fix the install and rerun `bun install`. A lower version is a downgrade made the same way. Data needs no step; for schema changes see `migrate`. Take a backup before deploying the new engine image. Projects on 0.9.0 or older have no `upgrade`: `bunx --package @archlast/forge-cli@latest archlast-forge upgrade`.

## 4. Evolve a monorepo

All of these read `archlast-forge.workspace.json` (or work the monorepo out from `apps/` when it is missing) and write it back. Names of services and apps: `^[a-z][a-z0-9-]{0,30}$`, not `web`, `api`, `mobile`, `desktop`, not already taken. Never hand-edit `packages/api`, `packages/contracts` or `forge/_services.ts`: `workspace sync` writes them. Structure: [project-modes.md](project-modes.md).

| Command            | `--yes` asked?                         | `--no-install` honored? | Notes                                   |
| ------------------ | -------------------------------------- | ----------------------- | --------------------------------------- |
| `monorepo`         | asks, needs `--yes` without a terminal | yes                     | `--dry-run` never asks, changes nothing |
| `add ...`          | never asks                             | yes                     | install + codegen after                 |
| `remove`           | asks, needs `--yes` without a terminal | yes                     | deletes folders                         |
| `workspace` (list) | no                                     | n/a                     | read only                               |
| `workspace sync`   | never asks                             | yes                     | `bun install` only (no codegen)         |
| `stack`            | never asks                             | n/a (no install)        | ignores `--yes`/`--no-install`          |

After `monorepo`, `add`, `remove` the CLI prints `next ...` and, unless `--no-install`, runs `bun install` at the root and codegen in each app it changed (`! codegen in apps/<app> didn't finish` is a warning, not a failure: run `archlast-forge codegen --dir apps/<app>/forge`).

### monorepo

```bash
archlast-forge monorepo [--microservices a,b] [--transport forge-rpc|tcp|redis|nats] [--mobile] [--desktop full|client] [--dry-run] [--yes] [--no-install] [--dir <forge dir>]
```

Turns the project you are in into the main app of a monorepo, in place. Every file in the folder moves to `apps/web` (full-stack) or `apps/api` (backend), except `.git .github .gitlab .vscode .idea .husky .claude node_modules LICENSE*`. It writes the root `package.json` (workspaces, turbo), `turbo.json`, `README.md`, `.gitignore`, `archlast-forge.workspace.json`, `packages/api`, and with the other options the services, `apps/mobile`, `apps/desktop`. `.env`, data, `compose.yaml` (its `name:` does not change, so volumes survive), the lockfile and history come along; user code is not reformatted (Prettier runs only over written files). The project's own `bun.lock` moves with it; delete it after the root install if you want.
Refuses: already inside a monorepo, an `apps/` folder already exists, no `forge/`, `archlast-forge.json` with a bad `mode`, `--desktop full` on a backend, a repeated or reserved service name. Ask the user, use `--dry-run`, and check the git tree is clean first.

### add

```bash
archlast-forge add service <name>
archlast-forge add app <name> [--mode framework|backend] [--services <list>] [--no-shadcn] [--base-color <name>]
archlast-forge add mobile
archlast-forge add desktop <full|client>
```

- `add service <name>`: `apps/<name>` (a backend serving the monorepo's transport, a Forge RPC router by default) with the next free ports (`port` from 3001, `rpcPort` from 4001). In the main app: `forge/<name>.service.ts`, `forge/<name>.controller.ts`, `forge/<camelName>.ts`. Also `FORGE_RPC_TOKEN` and the dashboard variables (`DASHBOARD_URL`, `MICROSERVICES`) in the `.env` files, `packages/contracts`, `forge/_services.ts`. Refused if any of those files exists.
- `add app <name>`: `apps/<name>`, a project like `init` makes (full-stack with shadcn by default, or `--mode backend`), its own port, and `packages/api/<name>.ts` (types as `@<project>/api/<name>`).
- `add mobile`: `apps/mobile` (Expo) and `@better-auth/expo` in the main app's `forge/package.json`. A hand-written `auth.ts` is kept and you are told what to add.
- `add desktop full|client`: `apps/desktop` (Tauri). `full` only if the main app is full-stack; needs Rust.

`add app` errors: `Unknown mode`, `shadcn/ui is for full-stack apps: use --mode framework.` (with `--mode backend` plus `--base-color`/`--shadcn`). `--services` takes the `init` list (default is the mode's). `add` with no or an unknown first word prints `Usage: archlast-forge add service <name> | add app <name> ... | add mobile | add desktop <full|client>`. Errors for existing things: `apps/<name> already exists.`, `apps/mobile already exists.`.

### remove

```bash
archlast-forge remove <name> --yes [--no-install]       # name: a service, an app, mobile or desktop
```

Deletes `apps/<name>` with its code, data and `.env`. For a service it also deletes the main app's `<name>.service.ts`, `<name>.controller.ts`, `<camelName>.ts` and rewrites `packages/api`, `packages/contracts`, `forge/_services.ts`. Removing `mobile` leaves `forge/auth.ts` and `@better-auth/expo` (told in a note). The main app cannot be removed. `There is no apps/<name> in <root>.` if it doesn't exist. Destructive: ask the user; in a git repo `git checkout .` and `git clean` restore tracked files.

### workspace

```bash
archlast-forge workspace          # table: apps, kind, transport port, dev URL; says when the file is missing and was inferred
archlast-forge workspace sync     # write the shared packages again from apps/
```

`sync` is for hand changes: an app folder that is gone drops out of the workspace (with a note to delete the main app's calls to a removed service); a new `apps/<d>/archlast-forge.json` joins as an `app` (port from its `dev` script's `--port`, else next free); a main app named `@<project>/api` is renamed `@<project>/backend` (two packages can't share a name); `packages/api`, `packages/contracts`, `forge/_services.ts` and the dashboard variables are rewritten. A hand-made monorepo is adopted by writing `archlast-forge.workspace.json` with `main` (and `scope`) and running `sync`. Other argument: `Usage: archlast-forge workspace | workspace sync`.

### stack

```bash
archlast-forge stack                         # services this app has, and the ones it could
archlast-forge stack add <postgres,redis,s3,caddy>
archlast-forge stack remove <list>
```

Changes which stack services the app (one project; in a monorepo run it in the app) has. Writes `archlast-forge.json`, then follows from it:

- `compose.yaml`, `.env.example`, `Caddyfile`: rewritten only when they equal what the old services would have generated; a `compose.yaml` you edited stays and the new one is `compose.new.yaml` to merge by hand and delete.
- `.env`: only missing keys are appended (`DOMAIN`, `POSTGRES_PASSWORD`, `S3_*`) with fresh secrets; existing values are never touched.
- Notes printed: documents are not moved between SQLite and Postgres (`export` before, `import` after), Caddy needs `DOMAIN` and an https `BETTER_AUTH_URL` and no `ALLOW_INSECURE_HTTP`, a removed service's volumes stay until `down --volumes`.

Errors: `Nothing to change: the stack has ...` (exit 1), `Unknown service`, `No archlast-forge.json in <root>`, usage line for a malformed call. Extra keys in `archlast-forge.json` are dropped when it is rewritten.

## 5. Run

### dev

```bash
archlast-forge dev [--port <n>] [--with postgres,redis,s3] [--no-docker] [--docker] [--run "<cmd>"] [--dir <forge dir>]
```

Develops with live reload. Never exits by itself. Behavior depends on `mode` in `archlast-forge.json` (no file: backend). Both modes first run `bun install` for `forge/package.json` when it or the lockfile changed (`--ignore-scripts` unless `trustedDependencies`) and `codegen` (`✓ codegen: N modules`).

**Full-stack app**

- Engine runs in this process with the app.
- Services (`--with`, else `archlast-forge.json`; `caddy` and `none` ignored) are containers on 127.0.0.1 at free ports. Services listed and no Docker: **error**, unless `--no-docker` (then SQLite, with a warning).
- Docker only matters for services.
- Banner rows: App, Dashboard, Admin key, Service.
- Saving in `app/` or `public/` rebuilds and reloads the page; saving in `forge/` regenerates types and restarts functions.
- Ctrl-C or SIGTERM drains, stops the services it started, exit 0.

**Backend**

- Engine runs in a Docker container with `forge/` mounted read-only (it watches it); the host process only keeps `forge/_generated` current. No Docker: runs in this process on SQLite.
- Services are containers beside the engine; with no Docker they are skipped with a warning.
- Docker missing prints `! Docker isn't available; running in this process`; `--docker` makes it an error.
- Banner rows: API, Dashboard, Admin key, Container.
- Ctrl-C stops the container (15 s drain) and its services, exit 0.

Environment `dev` sets for the engine: `BETTER_AUTH_URL=http://localhost:<port>` (always, over `.env`), `TRUSTED_ORIGINS` (default `http://localhost:<port>`; yours replaces it), `DATA_DIR` (default `<forge dir>/data`, so `forge/data/app.db`), `BETTER_AUTH_SECRET` and `ADMIN_KEY` from the environment (Bun loads the project root `.env` of the cwd) else generated once into `$DATA_DIR/.dev-secrets.json` (0600). Behind code-server (`VSCODE_PROXY_URI` with `{{port}}`) the proxy's origin is trusted and `STORAGE_PUBLIC_URL` is set. Backend in Docker: the container is `archlast-forge-<project>-<hash>-dev`, port `--port` maps to 3000, `forge/.env` is its env file if it exists, volumes `<name>-data` and `<name>-modules`, and any older container of that name is removed first.

`--run "<cmd>"` runs a companion command through `sh -c` (a separate frontend) and kills it when the CLI exits.

Other failures: `Failed to start server. Is port 3000 in use?` (use `--port`), `Engine image ghcr.io/...:<version> isn't available. Set ARCHLAST_ENGINE_IMAGE...`, `bun install failed in <dir>...` (fix `forge/package.json`; native packages may need `trustedDependencies`), `Couldn't start postgres: ...` / `postgres didn't become ready in 60 s`, `Frontend code must import only forge/_generated`.

### codegen

```bash
archlast-forge codegen [--dir <forge dir>]
```

Installs server dependencies if changed, writes `forge/_generated/api.ts` and `dataModel.ts` (unchanged files untouched) and `rpc.ts` when `forge/` has Forge RPC routers (deleted when it has none; a procedure without `output` prints a warning), then checks that frontend code (`app/`, `src/` next to the forge folder) imports nothing from `forge/` except `forge/_generated`, and nothing from `@archlast/forge-runtime/nest/rpc` or `_generated/rpc`. Violations: `✗ Frontend code must import only forge/_generated (and not Forge RPC, which is for backends):` then one `<file> imports "<path>"` line each; exit 1. Output: `✓ wrote <forge>/_generated (N modules)`. `dev`, `build`, `up` run the same steps. Commit `_generated`; `_generated/.depshash` is git-ignored.

### build

```bash
archlast-forge build [--tag <image>] [--no-docker]
```

Installs `forge/package.json` if it changed (in a monorepo nothing else does) and runs codegen, then:

- **Docker** (default): builds the app image from the project's `Dockerfile` on the engine image (`--build-arg ENGINE_IMAGE=...`), tag `--tag` or `<project>-<hash>:latest`; builds or pulls the engine image if missing. A project with no `Dockerfile` gets a generated one around `forge/`. Ends `✓ built <tag>`. Failures: `Engine image build failed`, `App image build failed`.
- **`--no-docker`, full-stack**: production bundles into `.forge/build` (browser and server), prints first-load sizes. Build errors print file/line/column, exit 1.
- **`--no-docker`, backend**: prints `Nothing to build without Docker: a backend runs straight from forge/` and exits 0.

### start

```bash
archlast-forge start [--no-docker | --image <tag> [--env-file <file>] [--with <list>]] [--port <n>]
```

- Docker, `archlast-forge.json` present, no `--image`: same as `up`.
- `--image <tag>`: runs the image detached as `archlast-forge-<project>-<hash>` (`--restart unless-stopped`, host `--port` to container 3000, volume `<name>-data` at `/data`, `PORT=3000`, `DATA_DIR=/data`, `--env-file` default `forge/.env` if it exists). `--with` also starts postgres/redis/s3 containers. Any container of that name is removed first.
- Docker, no config file, no `--image`: `Pass --image <tag> (from archlast-forge build), or --no-docker ...`.
- `--no-docker`: runs the engine in this process until SIGTERM/SIGINT (graceful, exit 0; a second signal exits 1; SIGHUP reloads functions).

`start --no-docker` needs `BETTER_AUTH_SECRET` and an https `BETTER_AUTH_URL` (or `ALLOW_INSECURE_HTTP=1`) in the environment (Bun reads `.env` from the cwd); `DATA_DIR` defaults to `forge/data`. A full-stack app needs a build first: `No production build in <root>/.forge/build. Run archlast-forge build --no-docker first.` Config problems print one line and exit 1. Without Docker `start --image` falls back to in-process and ignores the image.

## 6. Operate the Docker stack

`up`, `down`, `logs`, `status` run `docker compose` against the project's `compose.yaml` (`--project-directory <root>`, `ENGINE_IMAGE` set to the CLI's engine image unless already in the environment). They need Docker and a `compose.yaml` (`No compose.yaml in <root>`). A stack lives in the project's root; in a monorepo run them in the app.

### up

```bash
archlast-forge up [--rebuild] [--dir <forge dir>]
```

1. Requires `archlast-forge.json` (`This folder has no archlast-forge.json...`).
2. Installs dependencies, regenerates types, checks imports.
3. Creates `.env` with fresh secrets if absent (0600; an existing `.env` is never touched).
4. Ensures the engine image locally (builds it in a checkout, else pulls).
5. `docker compose build` (`--rebuild` = `--no-cache`), then `docker compose up -d --no-build --wait --wait-timeout 240`.

Prints App, Dashboard, `ADMIN_KEY in .env`; warns about plain http when there is no Caddy and `ALLOW_INSECURE_HTTP=1`. Failures (exit 1): `The app image didn't build. The end of the output:` (last 15 lines), `The stack didn't become healthy` (read `archlast-forge logs app`; usual causes: a missing `.env` key, a port already published (`PORT`, `S3_PORT`), a config the engine refuses).

### down

```bash
archlast-forge down [--volumes]
```

`docker compose down`. `--volumes` also deletes volumes: database, files, Caddy certificates. **Destructive; ask the user.** Without it: `Data stays in Docker volumes.`

### logs, status, stop

- `logs [service]`: `docker compose logs --follow --tail 100 [service]` until Ctrl-C (services: `app postgres redis rustfs caddy`). No stack: follows the single engine container; nothing running: `✗ Nothing is running for this project`.
- `status`: `docker compose ps -a`; no stack: lists containers named for the project, or `no containers for <name>`.
- `stop`: with a stack, like `down` (never `--volumes`); else `docker stop -t 15` of the project's engine containers (from `start --image` or an old `dev`).

### Docker names and the image

Project slug = folder name lowercased with non-alphanumerics as `-`, plus a 6-hex hash of its path: containers `archlast-forge-<slug>-<hash>` (`-dev` for dev), `-dev-<service>` for dev services, volumes `<name>-data`. Engine image `ghcr.io/algochad/archlast-forge-engine:<CLI version>` (override `ARCHLAST_ENGINE_IMAGE`). Without Docker: `up`/`down` fail with `Docker isn't available...`; `logs` reports nothing running; `status` prints `no containers`; `stop` does nothing.

## 7. Data commands

`migrate`, `export`, `import`, `backup`, `restore`, `env`, `admin` pick a target in this order:

1. **Inside the engine container**: `docker exec <c> bun .../cli/src/index.ts <cmd> ... --dir /app/forge --no-docker`. Used when Docker is usable (not `--no-docker`, not `ARCHLAST_NO_DOCKER=1`) and the project's compose `app` service, or its `archlast-forge-<slug>-<hash>[-dev]` container, is running. `export` and `backup` write inside the container and `docker cp` the file out (`✓ copied to <file>`); `import` and `restore` `docker cp` the file in.
2. **The running server**: `POST http://localhost:<port>/_cli` with header `x-admin-key`. Used when a server answers on `--port`. The work happens in the server (imports reach live subscribers) and `<file>` is opened on the **server's** filesystem. A `401` prints `The server on port N rejected the admin key; set ADMIN_KEY to the one it runs with.`
3. **The database directly**: used when nothing answers (or `/_cli` is 404). SQLite under `DATA_DIR` (default `<forge dir>/data/app.db`), or Postgres or MongoDB if `DATABASE_URL` is set. `env` and `admin` open only the database; the others load `forge/` and create missing tables and indexes first.

`ADMIN_KEY` = the environment (including a `.env` in the cwd), else the dev secret in `$DATA_DIR/.dev-secrets.json` (created if missing). To hit a local dev server or database even when a Docker stack is up, pass `--no-docker` (then it uses 2, then 3). Case 3 silently acts on the local SQLite file whatever your stack uses; pass the right `--port` or run the command in the container. A project in a monorepo: run it in the app.

### migrate

```bash
archlast-forge migrate                               # create tables and indexes; check documents against the schema
archlast-forge migrate --status                      # one line per data migration: <state> <name> (<table>, <n> processed) [✗ error]
archlast-forge migrate --run-migrations [name ...]   # run pending data migrations (all, or the named ones); resumable
```

`✓ migrated N tables`. Documents that no longer match a strict table's schema print (up to 50) as `✗ <id>: <problem>`, then `✗ N documents don't match the schema; write a migration and run archlast-forge migrate --run-migrations` and exit 1. Running migrations rewrites documents (audited); `✓ ran <names>` or `✓ no pending migrations`; a failure says it resumes. Writing migrations: [data-and-functions.md](data-and-functions.md).

### export, import

```bash
archlast-forge export <file>                  # all documents of all tables as JSON Lines: {"table","_id","_creationTime","doc"}
archlast-forge import <file> [--replace]      # restore an export, keeping ids and creation times, validated
```

`import` refuses a table that already has documents (`Table "posts" already has 7 documents; pass --replace to clear it first`); `--replace` clears the tables named in the file first. Other errors: `Line 3 of <file> isn't valid JSON`, `Table "x" in the export isn't in the schema`. Missing file argument prints the usage line, exit 1. `import --replace` is destructive.

### backup, restore

```bash
archlast-forge backup <file>                        # SQLite consistent copy (VACUUM INTO); the file must not exist; Postgres: refuses, use pg_dump
archlast-forge backup <file>.tar.gz [--no-files]    # full backup (also .tgz): documents, jobs, env, settings, forge/ source, stored files
archlast-forge restore <file>.tar.gz [--no-files] [--config]
```

`restore` first makes a safety backup of the current state into the backup store (shown on the dashboard's Backups page; if that fails nothing is restored), then replaces files (unless `--no-files`), every table, scheduled jobs and migration states in one transaction. A document that doesn't fit the schema aborts with nothing changed. `--config` also replaces env variables and settings; restart the server after. Output `✓ restored N documents in M tables and K files`. **Destructive; ask the user.**

### env

```bash
archlast-forge env [list]
archlast-forge env get <NAME>          # exit 1: ✗ NAME isn't set
archlast-forge env set <NAME> <value>  # quote values with spaces
archlast-forge env rm <NAME>
```

Variables stored in the database and loaded as `process.env` in functions; the process environment wins. After `set`/`rm` it asks the running server to reload its function runtime: SIGHUP to the container (`✓ engine reloaded`), or `POST /_admin/reload` to a local server (`✓ running server reloaded`). The reload endpoint exists only when the dashboard is on (default in dev, off in production unless enabled), so a plain `start --no-docker` prints `(no running server picked it up; it applies on next start)`: restart it. Wrong form: `Usage: archlast-forge env list | get <NAME> | set <NAME> <value> | rm <NAME>`. Values passed as arguments land in shell history and process lists: avoid for secrets when you can.

### admin

```bash
archlast-forge admin add <email> [--role owner|admin|viewer] [--password <pw>]   # default role admin
archlast-forge admin list                                                          # <role> <email>
archlast-forge admin remove <email>                                                # ✗ No admin <email> if unknown
```

Dashboard accounts (sign in at `/_dashboard`). Without `--password` a random 20-character one is generated and printed once. A password must have at least 12 characters (`✗ Admin passwords must be at least 12 characters`). `add` on an existing email replaces its password and role. `ADMIN_KEY` works as an owner without an account.

## 8. Other commands

### dashboard

`archlast-forge dashboard [--port <n>]` prints `http://localhost:<port>/_dashboard` and exits 0. It checks nothing and always says localhost. In production the dashboard is off unless enabled (`DASHBOARD`, see [operations.md](operations.md)).

### engine

```bash
archlast-forge engine build [--tag <image>]   # builds the engine image from docker/engine.Dockerfile (needs a checkout of the archlast-forge repo)
archlast-forge engine serve [--dev]           # the container's main process
archlast-forge engine prepare                 # image build step: copy the project in, install, build a full-stack app
```

Only `build` is for people (default tag `ghcr.io/algochad/archlast-forge-engine:<version>` or `--tag` or `ARCHLAST_ENGINE_IMAGE`; from an installed package: `No engine Dockerfile at ...; set ARCHLAST_ENGINE_IMAGE to a published image`). `serve` and `prepare` run inside the image; `serve --dev` on a full-stack app fails (it runs on the host in dev). Anything else: `Usage: archlast-forge engine build [--tag <image>]`, exit 1.

## 9. Configuration the CLI reads and writes

### archlast-forge.json (project root)

```json
{ "mode": "framework", "services": ["postgres", "redis", "s3", "caddy"] }
```

| Key        | Type                                     | Rule                                        |
| ---------- | ---------------------------------------- | ------------------------------------------- |
| `mode`     | `"framework"` \| `"backend"`             | required                                    |
| `services` | array of `postgres` `redis` `s3` `caddy` | optional (default `[]`), duplicates dropped |

It sets what `dev` starts (not `caddy`) and what `up` expects; `up` runs whatever `compose.yaml` says (edit it by hand or use `stack`). No file = a backend with no services (`up` then refuses). Errors name the file: `<file>: "mode" must be "framework" or "backend" (got "web")`, `<file>: unknown service "mysql"; choose from postgres, redis, s3, caddy`, `<file>: "services" must be a list such as ["postgres", "redis"]`, `<file>: expected an object like { "mode": "framework", "services": [] }`, `<file> isn't valid JSON: ...`. Change services with `archlast-forge stack`, not by hand.

### archlast-forge.workspace.json (monorepo root)

```json
{
  "main": "web",
  "scope": "shop",
  "transport": "forge-rpc",
  "apps": {
    "orders": { "kind": "service", "port": 3001, "rpcPort": 4001 },
    "admin": { "kind": "app", "port": 3002 }
  },
  "mobile": true,
  "desktop": "client"
}
```

`main` (required): folder in `apps/` of the main app (`web` or `api` when `init` made it). `scope` optional: package scope when it isn't the root package name. `transport`: `forge-rpc|tcp|redis|nats`. `apps.<name>`: `kind` `service|app` and numeric `port` (services also `rpcPort`). `mobile` boolean, `desktop` `full|client`. Errors: `<file> isn't valid JSON`, `"main" must be the folder of the main app...`, `"transport" must be one of ...`, `"apps.<n>" needs a "kind" ... and a "port"`. A monorepo is a root with that file, or `turbo.json` plus `packages/api`. Without the file the layout is inferred (main = `web`, else `api`, else the only project) and the next change writes it. A backend main app's package is `@<scope>/backend` because `@<scope>/api` is `packages/api`.

### Environment variables

| Variable                                                   | Read by                                   | Effect                                                                                                |
| ---------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `ARCHLAST_NO_DOCKER=1`                                     | all                                       | same as `--no-docker`                                                                                 |
| `ARCHLAST_ENGINE=1`                                        | all                                       | set inside the engine image; the CLI never uses Docker there                                          |
| `ARCHLAST_ENGINE_IMAGE`                                    | build, up, dev, start, engine build       | engine image to build on, pull or tag; default `ghcr.io/algochad/archlast-forge-engine:<CLI version>` |
| `ENGINE_IMAGE`                                             | `up`, `down`, `logs`, `status`            | passed to `docker compose`; overrides the above there                                                 |
| `DOCKER`                                                   | all Docker calls                          | container program, default `docker`                                                                   |
| `PORT`                                                     | all                                       | default for `--port`                                                                                  |
| `ADMIN_KEY`                                                | data commands, `dev`                      | key for `/_cli` and the dashboard; `dev` generates one if unset                                       |
| `BETTER_AUTH_SECRET`                                       | `dev`                                     | used if set, else generated                                                                           |
| `DATA_DIR`                                                 | `dev`, `start --no-docker`, data commands | database and dev-secrets folder; default `<forge dir>/data`                                           |
| `TRUSTED_ORIGINS`                                          | `dev`                                     | replaces the localhost default                                                                        |
| `VSCODE_PROXY_URI`                                         | `dev`                                     | trusts the code-server proxy origin and sets `STORAGE_PUBLIC_URL`                                     |
| `S3_PUBLIC_ENDPOINT`                                       | backend `dev` in Docker                   | public URL of the S3 container (default `http://localhost:9000`)                                      |
| `DATABASE_URL`, `REDIS_URL`, `S3_*`, other engine settings | engine in the CLI's process               | export them to use your own services                                                                  |
| `CI`                                                       | `init`                                    | any value: never prompt                                                                               |
| `NO_COLOR`, `FORCE_COLOR`, `TERM`                          | all                                       | output colors                                                                                         |

Bun loads `.env` from the **cwd**, so `ADMIN_KEY`, `BETTER_AUTH_SECRET`, `DATABASE_URL` in the project root `.env` apply to every command run from there. `ARCHLAST_SRC`, `ARCHLAST_APP`, `ARCHLAST_WORKER`, `ARCHLAST_DEV`, `ARCHLAST_FORGE_DIR`, `ARCHLAST_SERVER_ID` are engine internals.

### Files the commands write

| Path                                                                                                          | By                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `forge/_generated/{api,dataModel,rpc}.ts`, `.depshash`                                                        | `codegen`, `dev`, `build`, `up`, `upgrade`                       |
| `forge/node_modules`, `forge/bun.lock`                                                                        | the same (server dependencies)                                   |
| `forge/data/app.db` (+ `-wal`, `-shm`), `forge/data/.dev-secrets.json`                                        | `dev`, `start --no-docker`, data commands case 3                 |
| `.forge/gen`, `.forge/build/`                                                                                 | full-stack `dev`, `build`                                        |
| `.env` (once, 0600)                                                                                           | `init`, `up`; `stack` appends keys                               |
| `archlast-forge.json`, `compose.yaml` (or `compose.new.yaml`), `.env.example`, `Caddyfile`                    | `stack`                                                          |
| `package.json`, `forge/package.json`, `Dockerfile`, `compose.yaml` versions; `.prettierrc`, `.prettierignore` | `upgrade`                                                        |
| `archlast-forge.workspace.json`, `apps/`, `packages/`, `turbo.json`                                           | `init --monorepo`, `monorepo`, `add`, `remove`, `workspace sync` |

## 10. Safe versus ask first

- **Read only**: `--help`, `--version`, `dashboard`, `workspace`, `stack` (no arguments), `status`, `logs`, `monorepo --dry-run`, `migrate --status`, `env list|get`, `admin list`.
- **Writes project files, reversible with git**: `init` (new folder), `codegen`, `add ...`, `stack add|remove`, `workspace sync`, `upgrade` (also runs install), `dev`, `build`, `engine build`.
- **Writes a file outside the project**: `export <file>`, `backup <file>` (a `.tar.gz` is overwritten; a `.db` must be new).
- **Ask the user first**:
  - `monorepo` (moves every file) and `remove` (deletes folders with data and `.env`).
  - `down --volumes` (deletes volumes), `import --replace` (clears tables), `restore` (replaces all data), `migrate --run-migrations` (rewrites documents).
  - `up`, `down`, `stop`, `start --image` (start, stop or replace containers; production downtime).
  - `env set|rm` (changes and reloads a running server), `admin add|remove` (creates, overwrites or deletes an account).
  - `stack remove` (changes compose; leaves volumes), `upgrade` to another minor (changes the engine image).
- **Anything against production**: every data command pointed at a production server or container, including a read like `export` (it can be large and holds user data).

When the target is production, state which server (`--port`, container, `DATABASE_URL`) the command will hit before you run it.

## 11. Common mistakes

1. **Running `dev`, `start --no-docker` or `logs` in the foreground** of a shell you must keep using. They never exit. Background them, poll `/health`, stop them.
2. **`init` without a folder, or expecting prompts.** No terminal means no questions: pass `dir`, `--mode`, `--services`, etc., or `--yes`. `--yes` does not install or `git init`; add `--install`/`--git` or run `bun install` yourself.
3. **`archlast-forge --yes init x`.** `init` must be argument 1. Also `--install`/`--git` are `init`-only.
4. **Running project commands at a monorepo root.** `dev`, `codegen`, `up`, `build` need an app: `cd apps/<app>` or `--dir apps/<app>/forge`. Only `add`, `remove`, `workspace`, `upgrade`, `monorepo` (refuses) and `stack` (explains) understand the root.
5. **`monorepo` or `remove` without `--yes` in a non-TTY** exits 1 and changes nothing; with `--yes` they act at once. Dry-run first, confirm with the user, check `git status`.
6. **Full-stack `dev` with Docker missing** and services in `archlast-forge.json`: use `ARCHLAST_NO_DOCKER=1` or `--no-docker` (SQLite). In an agent sandbox that is the normal case.
7. **Data command hits the wrong target.** With a Docker stack up it goes to the container even when you meant the local dev DB; `--no-docker` targets a local server (`--port`) or the local `forge/data/app.db`. With nothing listening it silently opens the local SQLite file.
8. **`--port` ignored by the container.** `--port` selects where `dev`/`start` publish and where data commands look; it never changes the port inside a container (3000).
9. **Hand-editing generated or CLI-owned files**: `forge/_generated`, `forge/_services.ts`, `packages/api`, `packages/contracts`, `archlast-forge.json` services, `.env` secrets. Use `codegen`, `workspace sync`, `stack`.
10. **Assuming `stack remove postgres` moves data.** It doesn't; `export` first, `import` into the new stack. Edits to `compose.yaml` turn the update into `compose.new.yaml`.
11. **`backup x.db` onto an existing file** fails (`output file already exists`), and on Postgres it refuses. Use a new name, `x.tar.gz`, or `pg_dump`.
12. **`start --no-docker` of a full-stack app before `build --no-docker`**, or `build --no-docker` of a backend (a no-op). `bun run build` and `bun run start` already pass `--no-docker`; backends have neither script.
13. **Expecting `env set` to apply instantly in production.** The reload needs the dashboard on or a container; otherwise restart.
14. **Passing secrets as arguments** (`--password`, `env set`). They persist in history and process lists; prefer the generated password and read secrets from `.env` rather than printing them.
15. **Forgetting codegen** after changing functions, schema, routers or `_modules`: `bun run typecheck` runs it, then fix what it reports.
16. **`upgrade` surprises.** It changes versions before installing (a failed install leaves edited files), moves a whole monorepo, and can downgrade. Run it on a clean tree, commit, then `bun run codegen`, tests and `up`.
17. **Reading `dashboard` as a health check.** It prints a URL and nothing more.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                                  | Read it for                                                |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| [cli](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/cli.mdx)                     | the full CLI reference this file summarizes                |
| [configuration](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/configuration.mdx) | the environment variables the commands and the engine read |
| [migrations](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/migrations.mdx)       | `migrate`, `export`, `import`                              |
| [backups](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/backups.mdx)             | `backup` and `restore`                                     |
| [dashboard](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/dashboard.mdx)         | `admin` accounts and the dashboard the CLI prints          |
| [monorepo](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/monorepo.mdx)           | `monorepo`, `add`, `remove`, `workspace`                   |
