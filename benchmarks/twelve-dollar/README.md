# The $12 server challenge, on archlast-forge

An unofficial run of [the $12 Server Challenge](https://github.com/arjaythedev/twelve-dollar-server-challenge) against the BaaS: its seed data, its
load scenario and its scoring procedure, with the API translated to the BaaS's own tRPC functions (not its REST shapes).
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
