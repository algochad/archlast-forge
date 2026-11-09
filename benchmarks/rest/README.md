# A REST API in nine setups, in memory and on SQLite

The same in-memory CRUD API, built in archlast-forge (NestJS path and minimal routes), Tuyere alone (its native `App` API), plain NestJS on Node and on Bun, Node.js (Express), Bun (`Bun.serve`), Go (fasthttp), .NET (Minimal APIs) and Rust (Axum), each in a Docker container with the same limits, loaded with [oha](https://github.com/hatoo/oha). The results and how to read them are on the docs site's [Benchmarks](../../apps/docs/content/benchmarks.mdx) page.

## The API

An item is `{ id, name, quantity }`.

| | |
|---|---|
| `GET /items/:id` | `200` with the item, or `404 {"error":"not found"}` (also for an id that is not a whole number of 1 or more) |
| `GET /items?limit=N` | `200` with the existing items among ids `1…N` in id order; `limit` is 20 when absent or not a whole number from 1 to 100 |
| `POST /items` | `201` with the new item (ids count up from 1001), or `400 {"error":"invalid item"}` |
| `PUT /items/:id` | `200` with the replaced item, `404`, or `400` |
| `DELETE /items/:id` | `204`, or `404` |
| any other path | `404` |

A valid body is a JSON object with a `name` (a string of 1 to 100 characters) and a `quantity` (a whole number, 0 or more). The store is seeded with items 1 to 1000 (`item-<id>`, quantity `id % 100`) and holds at most 100,000 items: creating item *n* removes item *n − 100,000*. It is safe for concurrent use. `conformance.ts` checks all of this (`bun conformance.ts http://127.0.0.1:3000 [/prefix]`), and `run.sh` refuses to measure a server that fails it.

archlast-forge serves its routes under `/http` (a Forge rule), so the harness uses that prefix for it. Its rate limit is off (`RATE_LIMIT_PER_MINUTE=0`, or the load is refused); everything else, including telemetry, is as shipped.

## The same API on SQLite

`SUITE=sqlite ./run.sh` runs the same API and scenarios with the items in SQLite instead of in memory (`SUITE=sqlite bun report.ts` makes `results-sqlite.md` and `.json`). The first twelve rows are the same, each with its own SQLite driver:

| Row | Driver |
|---|---|
| Rust (Axum) | `rusqlite` (bundled SQLite), one writer connection behind a mutex and four reader connections |
| Go (fasthttp) | `mattn/go-sqlite3` through `database/sql`: one writer connection, four readers |
| .NET | `Microsoft.Data.Sqlite`: pooled connections for reads, one connection behind a lock for writes |
| Bun.serve, NestJS on Bun, Tuyere | `bun:sqlite`, one connection (one JavaScript thread) |
| Express, NestJS on Node | `node:sqlite`, one connection |
| archlast-forge (two more rows) | the same routes with the items in `bun:sqlite` through the store the other JavaScript servers use (`forge-bunsqlite`, `forge-minimal-bunsqlite`), to show what the engine's database costs over a bare connection |
| archlast-forge (four rows) | the engine's own database, directly from the route: `ctx.read` / `ctx.write` (a transaction with `ctx.db`) in the minimal routes, and a `DbService` with `@Read()` / `@Write()` methods in the NestJS controller. No `ctx.runQuery`, so no function of the reactive system is called |

Every server uses the same table (`items(id INTEGER PRIMARY KEY AUTOINCREMENT, name, quantity)`), WAL and `synchronous = NORMAL` (Forge: `SQLITE_SYNCHRONOUS=NORMAL`). A trigger enforces the cap (inserting item *n* deletes item *n − 100,000*), so a create is one `INSERT`. Forge's items are documents with an indexed `itemId` (`by_item`; `servers/shared/forge-items.ts`), and its create reads the highest id, inserts, and deletes `itemId − 100,000` itself; the one difference from the SQL servers is that a deleted highest id is reused. The Forge rows are seeded by `POST /seed` once the server is up (a setup route in the benchmark app, not part of the measured API).

The database is a file in a new directory of the machine's disk, bind-mounted at `/data` and removed afterwards. Forge's write-ahead log is the reason it is not tmpfs: with writes that never pause (the create case) its checkpointer copies the log back but the log is not recycled, and it grew to several gigabytes in a 17-second create run. "Peak memory" in this suite is the largest anonymous memory sampled every 0.2 s, because `memory.peak` counts the page cache and that log fills it.

## Run it

```sh
./run.sh                 # all servers; builds the images on the first run (a few minutes)
./run.sh axum go         # some of them
bun report.ts            # results.raw -> results.md and results.json
bun ../collect.ts && bun ../docs.ts   # put the numbers on the docs pages
```

| Variable | Default | |
|---|---|---|
| `SERVER_CPUS` | `0-3` | cores for the server container (`--cpuset-cpus`): four physical cores on the machine in the docs |
| `SERVER_MEM` | `2g` | memory limit, no swap |
| `CLIENT_CPUS` | `4-7,12-15` | cores for oha (`taskset`): the four other physical cores, both threads |
| `CONNS`, `SECS`, `RUNS` | 64, 5, 3 | connections, seconds per run, runs (the median is reported) |

Each case warms up for 2 s, then runs `RUNS` times. For each run the harness records the requests per second, the latency, the share of 2xx answers, and the CPU the container used (cgroup `cpu.stat`); after the last case it records the container's peak memory (`memory.peak`).

Choose `SERVER_CPUS` and `CLIENT_CPUS` so the two do not share a core or its SMT sibling (`cat /sys/devices/system/cpu/cpu0/topology/thread_siblings_list`). The compiled servers can use more than one oha client of this size can send, so their numbers are a floor.

## Layout

- `servers/shared/store.ts`: the store the JavaScript servers share. `rules.ts`, `store-sqlite.ts` and `driver-bun.ts` / `driver-node.ts` are the SQLite suite's (the Dockerfiles join them into a `store.ts`, so the servers' code is the same); `forge-items.ts` is Forge's `ctx.db` functions.
- `servers/nest-serve`: the NestJS controller on Tuyere with no Forge, through a basic Nest HTTP adapter (`adapter.ts`, about 150 lines, JSON bodies and Nest's guards, pipes and exception filter only), in memory (`Dockerfile`) and on SQLite (`Dockerfile.sqlite`).
- `servers/axum-sqlite`, `go-sqlite`, `dotnet-sqlite`, `forge-sqlite`, `forge-minimal-sqlite` and the `Dockerfile.sqlite` beside each JavaScript server: the SQLite suite's builds.
- `servers/forge`, `tuyere`, `express`, `bun`, `go`, `dotnet`, `axum`: one server each, with its `Dockerfile` (build context: this folder).
- `servers/dotnet-webapi`: the same API as a .NET Web API (MVC controllers). `STORE=memory` or `STORE=sqlite` picks the store, and `PIPELINE=controllers` leaves out the middleware (request ids, security headers, telemetry, a rate limiter, CORS, an exception handler), so that two harness rows, `dotnet-webapi` and `dotnet-controllers`, show what MVC costs and what the middleware costs. The middleware is this benchmark's own, made to carry about the work Forge does for a request.
