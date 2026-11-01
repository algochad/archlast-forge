# Hospital-scale load: where one server saturates

A load test of a real app on the engine (archlast-medico, an electronic medical record: 30 typed functions, Better Auth with the admin plugin, SQLite) found the engine saturating at a few dozen requests a second on four cores. This directory has the scenarios, the findings checked against the code and profiles, and the results before and after the changes that came out of it.

## What each finding turned out to be

| # | Reported | Verdict | What changed |
| - | -------- | ------- | ------------ |
| 1 | One function-runtime process by default | Confirmed. `RUNTIME_WORKERS=1`, and dev always uses a child process. | Calls go to the process with the fewest waiting, not round-robin. Queue depth is on the Runtime page, in `/metrics` and in a warning at about 2 s of work waiting. The default stays 1: more processes help queries that compute and cost light ones about twice the CPU per call. |
| 2 | An authenticated query is cached once per user | Confirmed exactly: in a 60 s run `admissions:census` ran 2,088 times for 2,088 calls (58 hits). The engine can't tell a check from a use of `ctx.auth`. | A query can declare `access` (the check, run for every caller on every serve and push) and then its result is shared. See [Sharing a query between users](../../apps/docs/content/functions.mdx). |
| 3 | A write re-runs every affected subscription once per user | Confirmed, and a consequence of 2. Subscriptions woken together already shared one run; with `access` they now do. | In a run of the same scenario with `access`, `census` ran 488 times for about 7,500 serves (2,500 from the cache, 4,500 sharing a run in flight). |
| 4 | An authenticated call costs about 4× an anonymous one | Confirmed, and the cause is more specific than guessed: a round trip to the function runtime to resolve the caller on every call, and, because the app uses a Better Auth plugin (which turns the engine's own fast session path off), about a millisecond in Better Auth's `getSession` each time. | The server keeps who a session belongs to until a write to the session or user row it came from, or the session's end or refresh. With plugins too: the topics `getSession` read are collected, and nothing is kept if it read none (cookie cache). |
| 5 | Overload: cheap queued calls time out, and a timeout kills the whole worker | Partly wrong. The worker is only killed when it has answered nothing since the call was sent. The real cause: SQLite reads never wait for I/O, so a burst of queued queries ran as one long run of microtasks. Nothing was sent and no message read until the last query was done, so a long queue looked like a hang. Timed-out calls then still ran. | A process starts queued queries a few per event-loop turn (as many as fit 4 ms), so answers leave as they are ready. A query that would wait longer than `FUNCTION_TIMEOUT_MS` is refused at once with the retryable 503, and one still queued after that long is refused by the process instead of run. |
| 6 | Single-writer SQLite | Agreed, not a limit here. | — |
| 7 | Mixed load is much slower than single-function numbers predict | Explained, not a bug in the writer. Single-function numbers are 100% cache hits. A run that a write overlaps can't be cached or shared, and under write load most runs overlap. On top of that, callers waiting on an overlapped run each started their own run instead of sharing one. | Waiters join one new run. Verified to fail on 0.6.1 (10 runs where 2 are needed). The loss of hits under writes is inherent and documented in [caching](../../apps/docs/content/caching.mdx). |

One error in the hand-over's scripts: `hospital.ts` timed a subscription that failed ("Server is busy") as a fast first value, so its "before" tables understate errors. It now counts them.

## Setup

A 4-vCPU shared VM, 7.9 GB, Linux 6.8, Bun 1.4.4. The engine and the load generator share the machine, so absolute numbers are conservative and runs vary by 10–20%. **Before** is the 0.6.1 source (`e93192a`); **after** is this change. Both ran the same app code, started with `archlast-forge dev --no-docker` (child-process runtime) unless a row says production, and each run started from a fresh copy of the same database: 751 users (500 nurses, 250 physicians, an admin), 3,000 patients, 500 active admissions, 12,000 monitoring rows, 18,000 fluid entries.

- **realistic**: 300 signed-in staff, each subscribed to the sidebar's ward list, an action every 20 s on average (open the census, open a chart = 3 live queries, search, list patients, 8% charting writes), sign-ins staggered over 15 s, 75 s.
- **stress**: 300 staff, 3 s between actions, everyone connecting at once, 60 s.
- **base**: the 0.6.1 engine with the app as it is. **eorig**: this engine, app unchanged. **emig**: this engine with the app's 11 gated queries moved to `access` (a mechanical change: `await requireUser(ctx)` as a query's first line became `access: requireUser`).

Three runs of every configuration, interleaved; medians with [min–max]. Raw logs: the `results` directory of the run.

## Results

### Stress (saturated)

| | req/s | errors per run | chart open p50 / p95 | census page p50 | patient search p50 / p95 | save p50 / p95 |
| - | - | - | - | - | - | - |
| base, 1 worker | 39 [37–40] | 1,144 · 1,247 · 1,272 | 5.6 s / 8.7 s | 5.7 s | 6.3 s / 13.4 s | 2.9 s / 6.1 s |
| eorig, 1 worker | 44 [43–47] | 183 · 304 · 345 | 3.7 s / 6.6 s | 3.7 s | 3.8 s / 8.9 s | 36 ms / 442 ms |
| **emig, 1 worker** | **132 [132–136]** | **0 · 0 · 0** | **9 ms / 250 ms** | **6 ms** | **5 ms / 176 ms** | **10 ms / 77 ms** |
| base, 3 workers | 52 [44–56] | 0 · 0 · 15 | 1.7 s / 4.8 s | 2.0 s | 3.0 s / 11.0 s | 1.7 s / 5.4 s |
| eorig, 3 workers | 83 [81–89] | 0 · 24 · 260 | 1.2 s / 2.7 s | 1.3 s | 1.2 s / 3.4 s | 73 ms / 498 ms |
| **emig, 3 workers** | **133 [115–138]** | **0 · 0 · 0** | **5 ms / 55 ms** | **4 ms** | **4 ms / 46 ms** | **7 ms / 47 ms** |

132 req/s is what 300 clients with a 3 s think time ask for, so the new engine with `access` is no longer the limit. The first value of the sidebar, with 300 clients connecting in the same instant, is 1.4 s (base: 6.9 s with one worker, 7.3 s with three). With the app unchanged (**eorig**) the engine can't remove per-user work, but a saturated server now refuses what it can't finish in time (the errors are 503s that never ran) instead of making everyone wait, and 3 workers do 60% more work.

On the production runtime (inline, one process, `archlast-forge start --no-docker`) the same scenario: base 33–34 req/s using a full core, chart open p50 3.6 s / p95 7.0 s, search 4.4 s / 14.2 s, save 7.0 s / 14.6 s; **emig 117–133 req/s on 0.6 cores, 0 errors, chart open 9 ms / 424 ms, search 7 ms / 550 ms, save 11 ms / 1.1 s**.

### Realistic (not saturated)

| | requests | server cores | sidebar p50 / p95 | chart open p50 / p95 | census page p50 / p95 | patient search p50 / p95 | save p50 / p95 |
| - | - | - | - | - | - | - | - |
| base, 1 worker | 2,178–2,292 | 0.39–0.50 | 39 / 209 ms | 72 / 811 ms | 70 / 594 ms | 72 / 842 ms | 80 / 267 ms |
| **emig, 1 worker** | 2,248–2,265 | **0.14–0.15** | **11 / 50 ms** | **8 / 75 ms** | **5 / 52 ms** | **4 / 47 ms** | **7 / 30 ms** |
| base, 3 workers | 2,190–2,279 | 0.71–0.84 | 48 / 128 ms | 23 / 283 ms | 58 / 314 ms | 29 / 293 ms | 22 / 172 ms |
| **emig, 3 workers** | 2,205–2,300 | **0.22–0.23** | **14 / 36 ms** | **6 / 31 ms** | **5 / 32 ms** | **4 / 32 ms** | **8 / 29 ms** |

No errors in any run. The request count is the same everywhere: the generator's think times set the load, so a rate would only measure how long its last client slept.

### Single functions, cached (5-bed database, 100 clients on one session, 1 worker, 3 runs, req/s)

| | `system:config` (anonymous) | `system:me` | `admissions:census` |
| - | - | - | - |
| base | 13–14 k | 2,270–2,410 | 1,958–2,458 |
| this engine, app unchanged | 13 k | 10,785–12,311 | 10,206–11,103 |
| this engine, `access` | 14 k | 8,533–9,391 | 9,020–11,205 |

An authenticated cached call now costs what an anonymous one does. (`system:me` reads `ctx.auth` itself and isn't migrated; the spread between the last two rows for it is the machine.)

### Mixed reads and writes (5-bed database, 100 clients, 12 s, 1 worker, 3 rounds, req/s)

| writes | 0% | 2% | 10% |
| - | - | - | - |
| base | 1,639 · 2,034 · 2,059 | 971 · 954 · 916 | 553 · 507 · 567 |
| this engine | 5,135 · 4,322 · 6,140 | 1,411 · 1,616 · 1,792 | 651 · 599 · 535 |

The drop with writes is what the cache can no longer hold, not the cost of writing: a write evicts what it touched, and a run that a write overlaps can't be kept or shared. Pure writes are unchanged (about 300–370 a second either way).

### A burst (200 different users call one function in the same instant, 1 worker)

- Census of one unit (about 23 ms each): base answers at least 90% of the 200 together at 4.8 s (first at 71 ms, p10 4.8 s). This engine: first 70 ms, p10 0.5 s, p50 2.4 s, last 4.5 s.
- Census of all 500 beds (550 KB, about 180 ms each), 0.6.1: failed 199 of 200 (166 with "Function runtime was restarted because a call didn't finish in time", 33 timeouts) and killed the runtime. 0.7.0: serves 87–97 and refuses the rest with the retryable 503, without a restart, but the answers arrive together near the end (median served call 11.4–11.9 s; the first tenth of all answers at 11.2–11.6 s). After 0.7.0, with results sent as JSON text and the drain gate (below): 73–112 served (mean 95 over 7 runs), median served call 7.6–12.4 s (median of runs 9.0 s), the first tenth of answers at 2.5–5.6 s. The same number of calls get served; they are answered while they are made instead of after, and the process that refuses a stale call does it at the deadline. The pipe, not the server, is what remains (see the next section).

### Large answers from a busy runtime process

A result is moved from the runtime process to the server through a pipe that a busy process can only write to between its own turns (about 4 MB a second here). Until 0.7.0 each result crossed as the object and as its JSON, with its topics as an array of strings, and nothing stopped a process from running ahead of what the pipe had taken. The arrival times of the same 40 calls, each doing some work and returning a large answer, 3 runs each:

| answer | 0.7.0: first · median · last | now: first · median · last |
| ------ | ---------------------------- | -------------------------- |
| 1,500 rows (about 700 KB), 25 ms of work | 1.57–1.85 · 1.70–1.95 · 1.81–2.07 s | 0.44–0.49 · 0.95–0.98 · 1.52–1.57 s |
| 3,000 rows (about 1.4 MB), 60 ms of work | 3.5–3.9 · 3.7–4.2 · 3.8–4.3 s | 0.90–0.98 · 1.88–2.08 · 3.07–3.46 s |
| 300 rows (about 140 KB), 10 ms of work, 150 calls | 0.14–0.25 · 0.97–1.13 · 1.8–2.3 s | 0.11–0.19 · 0.97–1.03 · 1.8–2.0 s |

The median answer comes back 45–55% sooner and the first 3–4× sooner for large answers, and nothing changes for ordinary ones. What changed (the reasons are in `docs/decisions.md`): a result crosses as its JSON text and its topics as one string; large results are messages of their own and no queued query starts while more than 4 MB of results are unreported by the pipe; a call past its deadline is dropped on every turn and by a timer; and the 10 s process sampler reads the heap with `process.memoryUsage()` (0.02 ms) instead of `heapStats()`, which walked the heap on the main thread: 36 ms at 27 MB of live objects, 180 ms at 109 MB, 490 ms at 281 MB, in every process. `server-prod.test.ts` has the first row as a test: it fails on 0.7.0 five times of five and passes on the new code five of five.

### Checks that nothing got slower (0.7.0 against the same code with those changes, interleaved)

- Closed-loop mixed load, 5-bed database, 100 clients, 4 rounds each: 2% writes 1,716 req/s (1,473 · 1,683 · 1,824 · 1,885) against 1,560 (1,464 · 1,424 · 1,704 · 1,648); 10% writes 587 against 604. Per-operation p50 and p99 are comparable, some a little better and some a little worse.
- Stress scenario with the migrated app, 1 worker, 5 rounds each with the first 20 s left out: no errors in any of the 10 runs. Median of the runs' p95 / p99 for a chart open 71 / 221 ms against 158 / 339 ms. Individual runs overlap a lot (p95 58–463 ms against 85–441 ms), so this shows no regression, not a measured gain. Including the cold start, 6 rounds each: the same throughput and server CPU; the "Server is busy" refusals that sometimes happen when 300 clients connect in the same instant came up in one run of six on the new code and two of six on 0.7.0.
- Everything off (`TELEMETRY=off` and no sampler) did not lower any tail beyond noise, in the stress scenario or the burst.

### Correctness

`race.ts` on 3 workers, 3 rounds: one winner when 30 patients race for a bed, one when one patient races for 30 beds, and one stored row when the same save id is sent 30 times at once. Ban, role change and sign-out take effect on the next call and cut off a live subscription: `packages/runtime/test/access.test.ts`, in child-process and inline runtimes, with and without a Better Auth plugin.

## Not done, and found on the way

- **Postgres, Redis and several servers were not run**: this machine has no Docker, Postgres or Redis. A function-runtime process allows up to 32 queries in flight so a Postgres-backed one still overlaps its waits; that path has no test beyond the in-memory ones.
- **Observability is not what held the burst back.** With everything off (`TELEMETRY=off` and the process sampler disabled), three runs each: the stress scenario's p99 for a chart open was 292 ms against 314 ms with it on, inside a run-to-run spread of 76–446 ms; the 200-user full-census burst had the same p10 and p50 (10.9–11.7 s against 11.0–12.0 s) and the same 113–121 refusals. An earlier version of this file blamed the telemetry flush; a profile suggested it and the experiment refuted it. The one observability cost that was real, the sampler's `heapStats()`, is gone (above).
- **Big results still cost a busy process time to move.** The census of 500 beds returns 550 KB, and a busy runtime process pushes about 4 MB a second through the pipe, so a burst of those is bound by the pipe (the first tenth of answers now arrives in 2.5–5.6 s, the median served call still in 7.6–12.4 s). Results that big are the app's to shrink; the engine now keeps the wait where a deadline can refuse a call instead of in the pipe.
- **The app's `shiftOf`** builds an `Intl.DateTimeFormat` on every call: 8–9% of the runtime's time in the profiles. A cached formatter fixes it (`packages/shared/src/shifts.ts` in the app).
- **The cold start**: 300 callers connecting at once each need their session resolved and their access checked, two round trips each. After that they are kept.
- **Across servers**, a deactivation is seen as soon as the Redis bus delivers the write, as for any cached result. The old per-user cache skipped the handler's check on a hit in the same way, so nothing got weaker.

## Reproduce

Seed an empty engine (about 100 s), then run a scenario from the repo root; `MEDICO_DIR` points at a checkout of the app, whose `scripts/client.ts` the seed and race scripts use.

```bash
DATA_DIR=/tmp/hospital RUNTIME_WORKERS=1 ADMIN_KEY=k BETTER_AUTH_SECRET=… BETTER_AUTH_URL=http://localhost:3100 TRUSTED_ORIGINS=http://localhost:3100 \
  archlast-forge dev --no-docker --port 3100        # in the app's directory
MEDICO_DIR=../archlast-medico API_URL=http://localhost:3100 BETTER_AUTH_URL=http://localhost:3100 ADMIN_KEY=k bun benchmarks/hospital/bigseed.ts
STAGGER=15000 VARIANT=after bun benchmarks/hospital/hospital.ts 300 75 20000 0.08   # realistic
STAGGER=0     VARIANT=after bun benchmarks/hospital/hospital.ts 300 60 3000 0.08    # stress
bun benchmarks/hospital/burst.ts admissions:census 200 '{"unit":"CCU"}'              # 200 users at once
```

Stop the engine and copy the database before each run so every run starts from the same data. `SPREAD_IPS=1` with `TRUST_PROXY=1` gives each simulated user an address of their own, which production mode needs for 300 sign-ins; add `RATE_LIMIT_PER_MINUTE=100000000` there. `VARIANT=after` uses the app's light sidebar query and per-unit census; `before` uses the original ones. `loadtest.ts` is the closed-loop mix (`NO_CENSUS=1` drops the full census), `race.ts` the correctness check, `bigseed.ts` the dataset.
