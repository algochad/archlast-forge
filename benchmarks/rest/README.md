# A REST API in nine setups

The same in-memory CRUD API, built in archlast-forge (NestJS path and light routes), archlast-serve alone (its native `App` API), plain NestJS on Node and on Bun, Node.js (Express), Bun (`Bun.serve`), Go (fasthttp), .NET (Minimal APIs) and Rust (Axum), each in a Docker container with the same limits, loaded with [oha](https://github.com/hatoo/oha). The results and how to read them are on the docs site's [Benchmarks](../../apps/docs/content/benchmarks.mdx) page.

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

- `servers/shared/store.ts`: the store the three JavaScript servers share.
- `servers/forge`, `archlast-serve`, `express`, `bun`, `go`, `dotnet`, `axum`: one server each, with its `Dockerfile` (build context: this folder).
