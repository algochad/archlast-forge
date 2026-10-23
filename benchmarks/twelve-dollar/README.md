# The $12 server challenge, on archlast-forge

An unofficial run of [the $12 Server Challenge](https://github.com/arjaythedev/twelve-dollar-server-challenge) against the BaaS: its seed data, its
load scenario and its scoring procedure, with the API translated to the BaaS's own RPC functions (not its REST shapes).
It is not a leaderboard submission: the data lives in the engine's JSON document tables, not the challenge's `schema.sql`.

| Challenge | Here |
|---|---|
| `GET /feed`, `GET /posts/:id` | `feed.list`, `feed.get` (public queries) |
| `POST /posts`, `POST /posts/:id/like` | `feed.create`, `feed.like` (mutations, need a signed-in user) |
| users, posts, likes tables | built-in `users`; `posts` and `likes` in [`forge/schema.ts`](forge/schema.ts); same indexes |
| JWT per user (20,000 in `tokens.json`) | a real Better Auth session per user, and its signed cookie |
| 50k users, 500k posts, ~2M likes | the same rows, from the challenge's own generator |

## Run it

```bash
git clone https://github.com/arjaythedev/twelve-dollar-server-challenge   # for the generator and golden files
export CHALLENGE=$PWD/twelve-dollar-server-challenge BETTER_AUTH_SECRET=twelve-dollar-bench-secret-0123456789abcdef
bun benchmarks/twelve-dollar/seed.ts --challenge $CHALLENGE --out /some/dir      # about a minute; 1.2 GB
SEED=/some/dir WORK=/scratch node benchmarks/twelve-dollar/score.mjs check      # the test suite, translated
SEED=/some/dir WORK=/scratch node benchmarks/twelve-dollar/score.mjs score      # warm-up, find the limit, confirm
SEED=/some/dir WORK=/scratch VUS=2000 node benchmarks/twelve-dollar/score.mjs profile   # CPU profiles of both processes
node benchmarks/twelve-dollar/analyze-profile.mjs <profile dir>
```

- `score.mjs` runs the real engine (`archlast-forge start --no-docker`) on **one CPU core** (`taskset`) with a **2 GiB** memory cap (a watchdog;
  Docker can't set cgroup limits in the sandbox this was run in). The load generator runs on other cores.
- `load.mjs` ports the challenge's `bench/load.js` (k6) for machines that can't hold thousands of k6 users in memory. `load.k6.js` is the same
  scenario for real k6.
- Server settings that differ from the defaults: `CACHE_TTL_MS=0` (the challenge forbids caching across requests), `RATE_LIMIT_PER_MINUTE=0`
  (all users share one IP) and `SCHEMA_CHECK=off` (the startup check takes ~70 s on 2.5M documents; ready in 1.7 s without it).

## Results (this machine: 4 vCPU shared VM, server pinned to 1 core)

**Score: 2,000 users** held for 5 minutes (p95 225 ms, p99 714 ms, 0% failed, server CPU 55%, 163 MiB). The limit search went 2,500 pass, 5,000 /
3,750 / 3,250 / 3,000 / 2,750 fail, then the 5-minute confirmations: 2,500 fail, 2,250 fail, 2,000 pass. Functional checks: 45 of 46
(arguments are validated before the function runs, so a malformed id gets a 400 before the auth check the challenge wants first).

Caveats: against a server that does nothing, this generator at 2,000 users records p95 ≈ 90-200 ms and p99 ≈ 200-560 ms, with event-loop stalls of
0.5-0.9 s even when split over two processes and cores (no CPU steal, GC pauses under 120 ms): host-level noise. The score is therefore conservative.
`results/` has the raw runs, and `results/profile/analysis-2000-users.txt` the profile.

## Where the time goes

At ~180 requests/s the one core is ~59% busy: ~3.3 ms of CPU per request, 26% in the HTTP server process and 33% in the function-runtime process.

- **HTTP server process:** tRPC's HTTP adapter ~55% of its work (a slow object-spread helper ~14%, building `Response`/`Headers`), IPC to the runtime
  process ~27%, Bun's own handling and `requestIP` ~14%.
- **Function-runtime process:** SQLite execution ~27%, document store (building SQL, parsing JSON, read-set topics) ~27%, IPC back ~15%, executor ~6%,
  Better Auth ~6%, log persistence and your functions ~1-2% each.
- **Tail latency** comes from the single JS thread blocking: SQLite is synchronous, so each cache-missing read or commit stops every request.
  Warm page cache vs cold at 2,000 users: p50 12 ms vs 48 ms, p95 315 ms vs 764 ms (only 20 MiB read from disk).
- **~278 MiB written per 165 s** (~8 KB per request); 58% of it is the per-request log rows (117 MiB without them).
- **More runtime processes make it worse** on SQLite (p95 614 ms warm, 2.8 s cold): the processes fight for the one write lock and wait for it synchronously.
- **mmap** (1.5 GiB): median 7 ms vs 13 ms, p95 195 ms vs 261-315 ms, CPU 54% vs 59%; p99 didn't improve in one run.

## After removing tRPC, and on Turso

2,000 users, 45 s ramp and 75 s hold, one core, no profiler, the same load generator (`score.mjs smoke` with `VUS=2000 RAMP=45s HOLD=75s`). The first row is the earlier run on `bun:sqlite` and tRPC.

| | p50 | p95 | p99 | server process CPU | runtime process CPU | memory | disk writes |
|---|---|---|---|---|---|---|---|
| `bun:sqlite`, tRPC | 13.8 ms | 261 ms | 668 ms | 26% | 33% | 156 MiB | 278 MiB |
| `bun:sqlite`, RPC | 4.4 ms | 50 ms | 154 ms | 15.6% | 27.8% | 154 MiB | 221 MiB |
| Turso, RPC | 11.8 ms | 584 ms | 1,502 ms | 14.2% | 47.9% | 255 MiB | 35 MiB |

Read the CPU columns, not the latency ones. Latency swings a lot between runs on this shared VM (two identical `bun:sqlite` profile runs gave p95 57 ms and 404 ms), and the first row used a differently built seed (indexes built after loading rather than before). The server process does about 40% less work without tRPC. Turso's runtime process uses about 1.7x the CPU of `bun:sqlite` for the same requests: 61% of its time is in `stepSync`, which runs on the JavaScript thread, so a slow statement stalls every request. It writes much less to disk, and, kept under 2 GiB, uses 255 MiB here. With `--cpu-prof` on, memory climbs to 0.7-1.1 GiB on either engine because the profiler keeps its samples, so compare memory only between runs without it.

Turso needed one workaround to get through this load at all: overlapping write transactions on separate connections hung the whole process (the first run, with that bug, failed 42% of requests). The adapter now runs one write transaction at a time; see `packages/runtime/bench/mixed-writes.ts`.

## 10,000 users

60 s ramp, 90 s hold, one core, the same generator. Neither engine holds it; the server is 2-3x over capacity (10,000 users ask for about 1,100 requests/s, and one core serves roughly 350/s on Turso and 600/s on `bun:sqlite`).

| | requests | failed | p95 | p99 |
|---|---|---|---|---|
| `bun:sqlite`, RPC | 105,696 / 103,319 (two runs) | 0% / 7.1% | 7.2 s / 8.8 s | 7.7 s / 13.1 s |
| Turso, RPC | 104,997 / 92,644 (two runs) | 51.7% / 55.1% | 10.8 s / 14.6 s | 11.5 s / 15.3 s |

Past capacity, calls queue inside the single-threaded function runtime. Any call that waits longer than 15 s makes the server kill and restart the runtime, which fails every call in flight, and the cycle repeats. `bun:sqlite` stayed on the right side of that line for most of one run and crossed it for one 10 s window in the other; Turso, with the higher CPU cost per request, crossed it repeatedly. The fix for 10,000 users is capacity (more cores or runtime processes; Turso allows only one process per database file) and load shedding (answer 503 quickly instead of queueing until the kill), neither of which exists yet.
