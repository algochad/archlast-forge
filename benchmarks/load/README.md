# Load and latency on the engine's own fixture

Throughput, latency and event-loop delay of the engine under its scaling settings: a cached query, an uncached one (one hot call, and
calls spread over 64 lists), a mutation, and subscription fan-out (many clients on one query, with writes); inline and with 1–3 runtime
processes; one and two servers on Postgres and Redis. The functions are `packages/runtime/test/fixture` (`todos:listByList` reads 20
documents through an index; `todos:add` inserts one).

## Run it

Linux with `taskset` and four cores: the server runs on cores 0–2 (or 0, and 1 for a second server), the load generator on core 3.
`node` runs the load generator, `bun` the server.

```bash
benchmarks/load/run.sh      # SQLite: saturation, open loop and fan-out -> results.jsonl (R=<file> to change)
bun run services:up         # Postgres and Redis for the next one; pin them to core 2 (docker update --cpuset-cpus 2 …)
benchmarks/load/run2.sh     # Postgres + Redis, one and two servers, and invalidation cost -> results2.jsonl

# one case: label, the server's cores, the load, then the server's environment
benchmarks/load/case.sh "uncached" 0 get CACHE_TTL_MS=0
SECONDS_=15 RATE=2000 benchmarks/load/case.sh "open loop" 0 getmany CACHE_TTL_MS=0 SEED_LISTS=64
CLIENTS=1000 RATE=10 benchmarks/load/case.sh "fan-out" 0 fanout CACHE_TTL_MS=0
benchmarks/load/threads.sh 0-2 CACHE_TTL_MS=0 RUNTIME_WORKERS=3   # CPU per process and thread
```

- `load.mjs`: raw keep-alive HTTP/1.1 sockets. Closed loop by default (64 connections, each sends its next request when the last one
  returns); with `RATE` it is open loop, and latency counts from each request's scheduled time, so queueing shows instead of slowing the load.
- `fanout.ts`: `CLIENTS` WebSockets watch one query while a writer adds `RATE` todos a second; delivery latency is from the write to the
  client seeing it (the 50 ms debounce included); runs per write come from `/metrics`.
- `case.sh` prints one JSON line: the load's numbers, busy % per core, the server process's event-loop delay (1 ms resolution, after a 3 s
  warm-up) and the runtime processes' (from their telemetry samples).
- `control.ts`: `Bun.serve` answering a fixed body, to measure the machine itself.

## Results

A 4-vCPU AMD EPYC shared VM, 7 GB, Linux 6.8, Bun 1.4.3, Node 24.22 for the load, Postgres 16 and Redis 7.0 on one core. 15 s a run,
two runs for each saturation case (ranges are the two); single runs for the others. **Before** is 0.5.0 as released; **after** adds
the changes in the commit that added this directory. Latency is p50 / p90 / p99 in ms; loop is the server's event-loop delay, p99 / max.

**The machine's noise:** `control.ts` at 2,000 requests a second showed p99 of 16–96 ms and loop pauses up to 90 ms, with no CPU steal
reported. Differences smaller than that, and run-to-run swings of a quarter, are the host. A lag threshold below about 100 ms can't be
checked here.

### Saturation, SQLite (64 connections, closed loop)

| Case                                                | Before req/s                            | Before latency         | After req/s                             | After latency           | After loop        |
| --------------------------------------------------- | --------------------------------------- | ---------------------- | --------------------------------------- | ----------------------- | ----------------- |
| cached query, inline, 1 core                        | 13,712–13,935                           | 3.8 / 7.5 / 17         | 10,054–14,643 (five runs)               | 3.7–4.1 / 7–11 / 15–42  | 21–26 / 38–71     |
| uncached query, one hot call, inline                | 4,187–5,389                             | 11 / 17–25 / 34–76     | 4,575–4,757                             | 11 / 21–22 / 45–51      | 22–53 / 39–164    |
| uncached, calls over 64 lists, inline               | –                                       | –                      | 4,296–4,492                             | 12 / 21–22 / 44–52      | 20–41 / 20–105    |
| mutation, inline                                    | 2,846–3,947                             | 13–16 / 25–37 / 72–122 | 2,837–3,061                             | 15–16 / 35–38 / 128–142 | 104–120 / 238–304 |
| uncached, one hot call, 1 / 2 / 3 workers (3 cores) | 3,442–5,005 / 4,773–5,096 / 2,989–4,590 |                        | 7,610–8,602 / 6,388–7,267 / 8,204–9,560 | p50 5–6.6               |                   |
| uncached over 64 lists, 1 / 2 / 3 workers           | –                                       |                        | 3,463–3,754 / 3,541–4,026 / 2,139–2,154 | p50 13–16               |                   |
| mutation, 1 / 2 / 3 workers                         | 2,008–3,750 / 2,439–3,461 / 2,632–2,840 |                        | 3,939–4,611 / 2,876–2,944 / 2,490–2,778 |                         |                   |

- **Workers don't add throughput for light calls.** Each call crosses to a worker and back: about 0.5 ms of CPU per call against
  0.26 ms inline (`threads.sh`). The server's one thread does the HTTP and that hop for every worker. In its profile, sending to the
  workers was 26% of its time, and changing the message format to JSON didn't move throughput. With three workers on three cores, the
  server process and the workers contend, so calls spread over 64 lists are slower than with one.
- **The hot uncached call got faster with workers** (3–5k to 6–10k req/s): identical calls now share one execution with the cache off
  too, and with workers more calls overlap. Spread over 64 lists, nothing overlaps, so those runs show the plain cost.
- **Mutations don't scale with workers on SQLite:** it has one writer.

### Open loop, inline, 1 core (latency from the scheduled send time)

| Load              | Before latency  | Before loop | After latency                                 | After loop |
| ----------------- | --------------- | ----------- | --------------------------------------------- | ---------- |
| uncached, 1,000/s | 6.8 / 198 / 464 | 88 / 288    | 2.1 / 19 / 92                                 | 31 / 38    |
| uncached, 2,000/s | 2.1 / 22 / 134  | 18 / 97     | 1.5 / 13 / 110                                | 33 / 60    |
| uncached, 3,000/s | 2.3 / 22 / 226  | 23 / 143    | 482 / 2,532 / 2,796 (re-runs: p99 461 and 56) | 252 / 553  |
| cached, 5,000/s   | 4.2 / 109 / 325 | 72 / 306    | 1.1 / 17 / 117                                | 9.6 / 19   |
| cached, 10,000/s  | 2.4 / 29 / 164  | 15 / 68     | 3.0 / 40 / 113                                | 13 / 35    |
| mutation, 500/s   | 2.1 / 6.8 / 26  | 9 / 22      | 2.3 / 12 / 56                                 | 24 / 88    |

Single runs; the 3,000/s run that fell behind was not reproduced (two re-runs: p99 461 ms and 56 ms). Under writes the inline server's
loop pauses for up to 300–850 ms in some runs and not others, before and after alike. Garbage collection pauses peaked at 61 ms
(`BUN_JSC_logGC=1`), so most of it isn't GC. A likely cause, not confirmed, is the kernel throttling SQLite's synchronous writes during
writeback on this VM's disk.

### Subscription fan-out, inline (10 writes a second, 15 s)

| Clients, cache   | Before: runs per write, delivery p50 / p99, loop p99         | After                                  |
| ---------------- | ------------------------------------------------------------ | -------------------------------------- |
| 200, cache on    | 0.99, 72 / 156 ms, 60 ms                                     | 0.99, 69 / 151 ms, 26 ms               |
| 200, cache off   | 147, 97 / 216 ms, 157 ms                                     | 0.99, 70 / 151 ms, 26 ms               |
| 1,000, cache on  | 0.59, 122 / 326 ms, 192 ms                                   | 0.85, 135 / 372 ms, 105 ms             |
| 1,000, cache off | 513, 204 / 1,289 ms, 522 ms (writer got 78 of 150 writes in) | 0.93, 121 / 362 ms, 73 ms (125 writes) |

### Postgres and Redis (the engine on core 0, a second server on core 1)

| Case                                | Before req/s | After req/s | After latency                 |
| ----------------------------------- | ------------ | ----------- | ----------------------------- |
| uncached, 1 server                  | 557–671      | 593–692     | 84–97 / 140–160 / 238–298     |
| uncached, 2 servers                 | 930–1,034    | 802–957     | 58–66 / 107–127 / 187–257     |
| mutation, 1 server                  | 278–285      | 310–367     | 162–187 / 237–294 / 376–593   |
| mutation, 2 servers                 | 469–478      | 479–599     | 102–113 / 141–216 / 212–344   |
| mutation, cache on (Redis cache)    | 293–318      | 253–275     | 199–214 / 331–427 / 592–1,701 |
| mutation, SQLite, cache on (memory) | 3,417–4,249  | 3,228–3,564 | 13 / 27–30 / 78–109           |

- **The engine's CPU is the limit on Postgres:** about 0.9 ms per call that reads Postgres, a quarter of it in the SQL driver. Postgres
  reached about 75% of its core with two servers. Pool sizes of 8, 16 and 32 per process gave the same 1,080–1,240 req/s; 64 dropped it to 233.
- **Invalidation costs nothing measurable:** a write publishes five topics here, and mutations ran at the same rate with the cache on or
  off, in memory and in Redis.


## Our engine under several configurations (`engine-compare.sh`)

`benchmarks/load/engine-compare.sh` runs four cases under each configuration: HTTP queries (cached, and uncached over 64 lists), HTTP mutations, and
subscription fan-out, the reactive side (1,000 WebSockets watching one query while 10 todos a second are added; delivery is write to client, the
50 ms debounce included). Same machine as above: server on cores 0–2 (Postgres runs: 0–1, with Postgres on core 2), load generator on core 3,
10 s a case, one run each, Bun 1.4.4; every request answered (no non-2xx), every subscriber got every update.

| configuration | cached query | uncached query, 64 lists | mutation | fan-out delivery p50 / p99 (1,000 subscribers) |
|---|---:|---:|---:|---:|
| sqlite / default | 47,505 req/s (p99 3.63 ms) | 15,394 req/s (p99 8.44 ms) | 8,735 req/s (p99 20.84 ms) | 70 / 111 ms |
| sqlite / RUNTIME_WORKERS=2 | 47,493 req/s (p99 4.18 ms) | 22,413 req/s (p99 8.88 ms) | 11,087 req/s (p99 58.97 ms) | 68 / 111 ms |
| sqlite / RUNTIME_WORKERS=3 | 53,153 req/s (p99 3.56 ms) | 21,932 req/s (p99 9.21 ms) | 10,959 req/s (p99 80.63 ms) | 70 / 113 ms |
| postgres / default | 52,826 req/s (p99 3.37 ms) | 9,540 req/s (p99 17.66 ms) | 3,870 req/s (p99 30.25 ms) | 72 / 109 ms |
| postgres / RUNTIME_WORKERS=2 | 53,595 req/s (p99 3.39 ms) | 12,451 req/s (p99 14.68 ms) | 4,882 req/s (p99 26.07 ms) | 73 / 114 ms |
| postgres / tuned server + RUNTIME_WORKERS=2 | 50,844 req/s (p99 3.51 ms) | 12,626 req/s (p99 14.59 ms) | 5,050 req/s (p99 23.31 ms) | 72 / 108 ms |

- **`RUNTIME_WORKERS=2` is the setting that matters**: uncached queries +46% on SQLite and +31% on Postgres, mutations +27% and +26%. It does nothing for
  cached queries, which the server answers itself. Three workers on three cores gave no more than two. On SQLite the mutation tail gets worse with
  workers (p99 21 ms → 59–81 ms): more writers contend for the one database writer.
- **Server tuning (Postgres) did not show up** at the engine: 12,451 → 12,626 uncached and 4,882 → 5,050 mutations a second is inside the noise.
- **Reactive delivery is the same everywhere** (p50 ≈ 70 ms, p99 ≈ 110 ms): the 50 ms debounce plus about 20 ms of re-running the query and sending to
  1,000 sockets; the database and the worker count don't change it at this rate.
- **The same cases for another backend**: `case.sh` takes a server command through `serve.ts`; to compare with a different backend, put it behind the same
  HTTP paths (`/rpc/todos:listByList` is a GET, `/rpc/todos:add` a POST) and the same WebSocket protocol in `fanout.ts`. Convex's self-hosted backend
  couldn't be run in this environment (its image's layers are on a host the sandbox's network policy blocks), so there is no Convex column.
