# CLI reference

`archlast-forge <command>`. Options that apply everywhere: `--dir <forge dir>`, `--port <n>`, `--no-docker`.

| Command | What it does |
|---|---|
| `dev` | Codegen, then the engine in Docker with `forge/` mounted. Edits restart only the function runtime. `--with postgres,redis,s3` starts service containers; `--run "vite"` runs a command alongside; `--no-docker` runs in-process. |
| `codegen` | Writes `forge/_generated/`, installs server dependencies when they change, and checks that `src/` imports only `forge/_generated`. |
| `build [--tag image]` | Production image: the engine plus your code and dependencies. |
| `start --image <tag> [--env-file f]` | Runs it with `restart unless-stopped`. With `--no-docker`, serves in this process. |
| `stop`, `logs`, `status` | Control the project's engine containers. `stop` sends SIGTERM, so connections drain. |
| `migrate` | Syncs tables and indexes and reports documents that don't match the schema. `--run-migrations [name…]` and `--status` handle [data migrations](migrations.html). |
| `export <file>`, `import <file> [--replace]`, `backup <file>` | Data portability. |
| `env list`, `env get`, `env set NAME value`, `env rm NAME` | Variables for your functions (`process.env`). Setting one reloads the running engine. |
| `admin add <email> [--role owner\|admin\|viewer] [--password p]`, `admin list`, `admin remove` | Dashboard accounts. |
| `engine build` | Builds the engine image from this repository. |

When an engine container is running, data and config commands run inside it, through `docker exec`.

Server dependencies in `forge/package.json` are installed with `--ignore-scripts`. If a package needs its install script, list it under `"trustedDependencies"` and Bun runs scripts for that package only.
