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

## After removing tRPC, and Turso compared

The engine is now `bun:sqlite` with the plain RPC protocol. Turso was tried as the local database and dropped; its adapter is in commit 5527bb2, and this section is why.

2,000 users, 45 s ramp and 75 s hold, one core, no profiler, the same load generator (`score.mjs smoke` with `VUS=2000 RAMP=45s HOLD=75s`). The first row is the earlier run on `bun:sqlite` and tRPC.

| | p50 | p95 | p99 | server process CPU | runtime process CPU | memory | disk writes |
|---|---|---|---|---|---|---|---|
| `bun:sqlite`, tRPC | 13.8 ms | 261 ms | 668 ms | 26% | 33% | 156 MiB | 278 MiB |
| `bun:sqlite`, RPC | 4.4 ms | 50 ms | 154 ms | 15.6% | 27.8% | 154 MiB | 221 MiB |
| Turso, RPC | 11.8 ms | 584 ms | 1,502 ms | 14.2% | 47.9% | 255 MiB | 35 MiB |

Read the CPU columns, not the latency ones. Latency swings a lot between runs on this shared VM (two identical `bun:sqlite` profile runs gave p95 57 ms and 404 ms), and the first row used a differently built seed (indexes built after loading rather than before). The server process does about 40% less work without tRPC. Turso's runtime process uses about 1.7x the CPU of `bun:sqlite` for the same requests: 61% of its time is in `stepSync`, which runs on the JavaScript thread, so a slow statement stalls every request. It writes much less to disk, and, kept under 2 GiB, uses 255 MiB here. With `--cpu-prof` on, memory climbs to 0.7-1.1 GiB on either engine because the profiler keeps its samples, so compare memory only between runs without it.

Turso needed one workaround to get through this load at all: overlapping write transactions on separate connections hung the whole process (the first run, with that bug, failed 42% of requests). The adapter ran one write transaction at a time after that (`packages/runtime/bench/mixed-writes.ts` in commit 5527bb2 reproduces the hang).

## 10,000 users

60 s ramp, 90 s hold, one core, the same generator. Neither engine holds it; the server is 2-3x over capacity (10,000 users ask for about 1,100 requests/s, and one core serves roughly 350/s on Turso and 600/s on `bun:sqlite`).

| | requests | failed | p95 | p99 |
|---|---|---|---|---|
| `bun:sqlite`, RPC | 105,696 / 103,319 (two runs) | 0% / 7.1% | 7.2 s / 8.8 s | 7.7 s / 13.1 s |
| Turso, RPC | 104,997 / 92,644 (two runs) | 51.7% / 55.1% | 10.8 s / 14.6 s | 11.5 s / 15.3 s |

Past capacity, calls queue inside the single-threaded function runtime. Any call that waits longer than 15 s makes the server kill and restart the runtime, which fails every call in flight, and the cycle repeats. `bun:sqlite` stayed on the right side of that line for most of one run and crossed it for one 10 s window in the other; Turso, with the higher CPU cost per request, crossed it repeatedly. The fix for 10,000 users is capacity (more cores or runtime processes; Turso allows only one process per database file) and load shedding (answer 503 quickly instead of queueing until the kill), neither of which exists yet.

## Optimizing for 10,000 users (the BaaS's own cache on)

The challenge forbids caching across requests; this section does not follow that rule. It measures the BaaS as it runs by default: the query cache on (`CACHE_TTL_MS=60000`), still one core and 2 GiB. `score.mjs` now defaults to it; `CACHE_TTL_MS=0` measures without.

**10,000 users, 60 s ramp, 90 s hold: pass.** Five consecutive runs: 0% failed, p95 17-69 ms, p99 73-468 ms, 41-45% of the core (server process 28%, function runtime 15%), 160-190 MiB. The load generator (one Node process on two cores) is the limit above about 13,000 users, so this setup can't measure further.

**Capacity** (`node score.mjs capacity`: 64 keep-alive connections as fast as the server answers, one core). The first row is the code before these changes, the second after, medians of several runs:

| | mix of the challenge's requests | cached `feed.list` / `feed.get` | `feed.like` | `feed.create` |
|---|---|---|---|---|
| before | ~2,000 req/s (~17,000 users) | ~5,000 req/s | 1.3 ms of CPU | 0.9 ms |
| after | ~3,400 req/s (~29,000 users) | ~5,000 req/s (the Node HTTP client's limit, not the server's: with the raw-socket generator `rawload.mjs` a cached `feed.list` serves 17,000-21,000 req/s at 48-58 us of CPU each, `feed.get` 10,500, against 23,000-40,000 req/s and 30 us for an empty `Bun.serve` handler) | 0.8-1.1 ms | 0.65 ms |

What changed: a cached result keeps its JSON, so a hit does no serialization; IPC messages in one turn of the event loop go out as one; cache invalidation in-process is synchronous; signed-in calls read the session directly (1.2 ms to 0.08 ms; Better Auth stays for everything unusual); no client-address lookup when rate limiting is off; cheaper request ids and one URL parse.

**Overload.** At 10,000 users with the cache off the runtime can't keep up (about 1,100 requests/s wanted, about 600 served). Before: calls queued past 15 s, the runtime was killed and restarted over and over (7,000-50,000 failed calls a run), 7-55% of requests failed, p95 7-15 s. Now: no restarts, 12% refused at once with 503, the rest p95 1.5 s, p99 2.0 s, max 3.7 s.

### Where the CPU goes at 10,000 connections, and what is left

An empty `Bun.serve` handler (a fixed 6 KB body, nothing else) under the same 10,000-user load costs **277-314 us of CPU per request**; an empty `node:http` handler costs 516 us. The BaaS's whole server process costs about 280 us. So the HTTP side is at the floor of what a Bun process can do here, and the function runtime (about 140 us per request, mostly the 8% of requests that write or rebuild a cached result) is the only part application code can still shrink. When the server is saturated by a few busy connections the same empty handler costs 30 us, because a loaded process never goes idle; with 10,000 mostly idle sockets almost every request wakes it from idle, and that is most of what a request costs. Raw syscalls are cheap here (about 2.5 us), so this is wake-up cost, not slow I/O.

Consequence: on one core, a faster function runtime can buy roughly 15-20% at 10,000 users. Another 2x needs more cores for the HTTP side (several processes sharing the port with `reusePort`, which works in Bun), not more tuning of this one. Done so far: counts for a whole page of parents are one grouped query instead of one each (`feed.list` rebuild 500 us to 415 us).

## Toward 3x on one core

Measured with `node score.mjs capacity` and the raw-socket generator (`rawload.mjs`: the challenge's mix of feed, post, 15% likes and 2% new
posts, as fast as one core answers; 30 s runs, medians; this VM varies about 10% between runs). The yardstick is `minimal-server.ts`, the same
four calls hand-written on `Bun.serve` and prepared statements against the same database.

| | full mix |
|---|---|
| minimal hand-written server, no cache | ~3,100 req/s |
| the BaaS before this work (cache on, function runtime in a child process) | ~3,000 req/s |
| the BaaS now (production defaults) | ~6,500 req/s (5,700-7,200) |
| minimal hand-written server with the simplest exact cache | ~9,700 req/s (8,900-10,600) |

At 10,000 users the defaults pass with 33% of the core (p95 17 ms, p99 109 ms, 0% failed, 179 MiB). What got it here, in order of effect:
the function runtime in the server process (no IPC per call); group commit (writes alone match the minimal server, ~2,000 req/s); counting
likes from the index (a GROUP BY on the field read every like row: 17% of the CPU); an exact read cache inside the runtime that drops only
what a write touched (a like recounts one post, not twenty); WAL checkpoints off the serving thread; cached bodies keyed by raw arguments;
batched log writes. What is left between the BaaS and the minimal server is spread thin: per-call logging, the rebuild path's general
machinery (validation, timeouts, the document store), cache bookkeeping and the HTTP layer's extra steps.
