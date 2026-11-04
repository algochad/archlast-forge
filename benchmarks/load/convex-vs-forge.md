# Convex (local backend) vs archlast-forge, on one machine and one workload

Every number below comes from a run in [`convex/results/results.jsonl`](convex/results/results.jsonl) (raw JSON, one line per case and run; the closing control is in `results-control-end.jsonl`), made by [`convex/matrix.mjs`](convex/matrix.mjs). Server logs of every run are in [`convex/results/logs/`](convex/results/logs/) (a Convex backend logs every request at its default level, up to 938,000 lines a phase, so those logs keep the first and last 150 lines and say how many were left out). The tables are produced by [`convex/tables.mjs`](convex/tables.mjs) from those files. Nothing here was measured that is not in them; what was not run is marked **not measured**. No engine code of archlast-forge was changed.

Short answer, with the caveats in section 4: on this workload archlast-forge is several times faster on cached reads, many times faster on Convex-uncached reads and on mutations over SQLite (measured with the engine's `synchronous = NORMAL`; section 7 reruns it with durable commits, where the result depends on how fast the disk syncs: equal inserts at a 1.2 ms sync, about 3,500/s at 6 ms, at least 5× Convex's either way), and delivers live-query updates one by one where Convex merges them under load. With Convex's own result cache doing the work, uncached-style reads are a tie. Mutations over Postgres are not separable (the ranges overlap).

## 1. Environment

| | |
| --- | --- |
| CPU | 11th Gen Intel Core i7-11700 @ 2.50 GHz, 8 cores / 16 threads, `powersave` governor (intel_pstate), no AC reading available (a desktop) |
| RAM / OS | 62 GiB; Linux 7.2.5 (Omarchy) x86_64 |
| Disk under the data | btrfs on an encrypted LVM volume (`/home`). The SQLite files and the Docker volumes for Postgres and MongoDB sit on it, so durable writes pay real fsyncs |
| Bun / Node | 1.4.4 / 26.8.2 |
| archlast-forge | commit `d7ce7cc` (`origin/staging` with #10, #11 and #12 merged), package version 0.17.0 |
| Convex backend | `convex-local-backend` from the GitHub release `precompiled-2026-11-04-059b229` (x86_64 Linux), run directly as a process (not the Docker image). The binary reports only `local_backend unknown`; sha256 `c1f8f3dc…7e28f3`. Client and CLI: npm `convex` 1.49.0 |
| Postgres | 17.11 (`postgres:17-alpine`, image `sha256:266d3c25…`) |
| MongoDB | 7.0.45 (`mongo:7`, a replica set of one, image `sha256:8bb44427…`) |

Full detail in [`convex/results/environment.txt`](convex/results/environment.txt).

**The machine was not idle, and I did what I could about it.** Before the runs the Minecraft server container (`folia`, pinned to CPUs 0, 1, 8, 9) was stopped at the owner's request; the `horizon` container had already exited. A QEMU virtual machine (gnome-boxes) kept one core busy at about 93% and roamed across all CPUs, so I pinned it to CPUs 6, 7, 14, 15 for the runs and restored its affinity afterwards. Browser processes (Firefox, Zen) were running and used 15–20% of a thread now and then, including CPU 13, the hyperthread sibling of the load generator's core. The benchmark used physical cores 2–5 only (siblings 10–13 were otherwise idle). The load average during runs was about 5–8, mostly that VM and the load itself.

**The machine's own noise (`control.ts`, before and after the whole matrix).** `Bun.serve` answering a fixed 20-document body on the server cores, driven by the same `load.mjs` on the load core:

- Closed loop, 64 connections: 108,216 req/s (108,137–111,798) before, 110,734 (109,729–111,825) after, with p99 1.25 and 1.24 ms. This is also the load generator's ceiling: its core is at 100%.
- Open loop at 2,000 req/s: p99 0.70 (0.68–0.81) before, 0.75 (0.71–0.79) after; the worst single request 8–20 ms.
- So reads are measured with about ±5% and sub-millisecond tails. Mutations that wait on the disk were far noisier than this control; see section 5.

## 2. How each system was configured

**Cores (same budget for both).** The server and its database share three physical cores, the load generator has one: server and database on CPUs 2–4 when the database is embedded (SQLite, either system); server on CPUs 2–3 and the database container on CPU 4 (`docker update --cpuset-cpus`) for Postgres and MongoDB; load generator on CPU 5 (`taskset`). Both Convex and archlast-forge could be pinned (both run as host processes).

**Data and workload.** Fresh data for every phase of every run: 64 lists × 20 todos = **1,280 todos**, seeded over HTTP. archlast-forge runs `packages/runtime/test/fixture` (its schema also has two more indexes on `todos` and some optional fields; Convex has only `by_list` and the three fields). Convex functions are in [`convex/convex/`](convex/convex/). Closed loop = 64 connections; open loop = fixed rate (2,000 req/s for queries, **500 req/s for mutations**, which neither Convex nor Postgres/Mongo-backed forge could sustain at 2,000); same `load.mjs` for both. 4 s warm-up and 15 s measured per case; 3 runs of everything, interleaved (run 1 of all configs, then run 2, then run 3). The median and the min–max of the kept runs are given; a row is marked **noisy** when its throughput spread is above 25% of its median.

**Correctness checks (every case, every run).** Before and after each case a script reads all 64 lists back and checks: 20 rows each, every row has the right `listId`, every insert is there (case C: each list holds 20 plus the inserts sent to it), and the `done` flag of each of the 1,280 todos equals the parity of how many times it was toggled (case D). The load generator counts a response as an error if it is not 2xx, **or, with the opt-in `OK_BODY` I added to `load.mjs`, if its body lacks the expected text** (Convex answers HTTP 200 to a failed function; the error is in the body). Totals: 0 non-2xx and 0 data-check failures in the kept runs. Runs that fail any check are discarded; one was (section 5).

| Case | archlast-forge | Convex |
| --- | --- | --- |
| A cached query | `GET /rpc/todos:listByList?args=…`, one hot list | `POST /api/query` `todos:listByList`, one hot list (its result cache is on) |
| B uncached query | same, over the 64 lists, server started with `CACHE_TTL_MS=0` | same query over 64 lists with Convex's result cache **as it is** (it cannot be switched off: no knob exists) |
| B′ | not applicable | `todos:listByListNoCache`, the same query plus a `nonce` argument that is different on every call, so no two calls share a cache entry (the cache cannot be disabled, so this is how it is bypassed) |
| C insert | `POST /rpc/todos:add`, `listId` cycling over the 64 lists | `POST /api/mutation` `todos:add`, same |
| D read-modify-write | `POST /rpc/todos:toggle`, cycling the 1,280 ids | `POST /api/mutation` `todos:toggle`, same |
| E fan-out | `fanout.ts` unchanged: 1,000 WebSockets, a writer inserting 10 todos/s for 15 s | `convex/fanout-convex.mjs`: 1,000 `ConvexClient`s with `onUpdate`, the same writer and the same latency definition |

**archlast-forge configurations.** `default` = no settings. `RUNTIME_WORKERS=2` = two runtime processes. `Postgres tuned` = the engine-compare settings (`shared_buffers=1GB`, `effective_cache_size=4GB`, `random_page_cost=1.1`, `jit=off`, `wal_compression=on`, `max_connections=200`) with `RUNTIME_WORKERS=2`; the Postgres in the default configs has none of that. MongoDB runs with the URL of `docker-compose.yml` (majority-acknowledged and journaled writes); `w=1 journal=false` is the extra, less durable variant (run with `RUNTIME_WORKERS=2` only). SQLite is the engine's `bun:sqlite` in WAL mode with **`synchronous = NORMAL`** (`packages/runtime/src/server/db/sqlite.ts`).

**Convex configurations.**

- *default*: no flags besides the instance name/secret, `--disable-beacon` and the storage paths. SQLite in a file, or `--db postgres-v5` with `POSTGRES_URL`-style spec `postgresql://forge:forge@localhost:55432` and `--do-not-require-ssl`, database `convex_self_hosted` (recreated for each run).
- *optimized* = `APPLICATION_MAX_CONCURRENT_QUERIES=64`, `APPLICATION_MAX_CONCURRENT_MUTATIONS=64` (both default to 16; the load uses 64 connections) and `RUST_LOG=warn` (default `info` logs every request: 938,000 lines in one phase). On Postgres, the same tuned Postgres as the forge row. These are the knobs listed in Convex's own `self-hosted/docker/docker-compose.yml`.
- **What `--help` offers:** the binary's `--help` lists only the database driver (`sqlite`, `mysql-v5`, `mysql-v5-multitenant`, `mysql-v6-multitenant`, `postgres-v5`), ports, storage, logging redaction and the SSL option. **There is no flag for threads, concurrency or cache.** The knobs above are environment variables I took from the compose file and from `crates/common/src/knobs.rs` on Convex's `main` branch, not from this binary's `--help`; the binary does not print them, so I cannot prove each one is read by this build. `RUST_LOG` visibly did something (an optimized log is 3 lines, a default one hundreds of thousands). The concurrency limits changed nothing measurable.
- **Not set:** thread counts (`V8_THREADS`, `RUNTIME_WORKER_THREADS` default to the number of cores the process may use, which under `taskset` is 3), the cache size (`UDF_CACHE_MAX_SIZE`; the cache was never the limit), and anything for MySQL. A short sensitivity sweep before the matrix (single 8–10 s runs on Convex+SQLite, data in [`convex/results/tuning/`](convex/results/tuning/)) tried the concurrency limits, `RUST_LOG`, the committer knobs `COMMITTER_MAX_CONCURRENT_WRITE_BATCHES` / `…PRE_VALIDATIONS` (no effect), and tmpfs instead of disk (mutations rose from about 700 to about 1,200 req/s, so the disk costs Convex something but is not what limits it).

## 3. Results

Each cell is the median of the kept runs with the min–max in brackets; "CPU" is the sum of busy % over the three server+database cores (300 = all three busy); errors are non-2xx responses plus body errors. Latencies are ms. In the open-loop tables a p50 slightly below zero is an artifact of `load.mjs` (a request timed from its scheduled time can leave a hair early): read it as 0.

### Tables


#### A. Cached query, closed loop (64 connections), one hot list

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 73,548 (70,485–74,553) | 0.82 (0.81–0.85) | 1.00 (0.99–1.10) | 1.74 (1.73–1.88) | 0 | 104 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 75,500 (72,663–76,608) | 0.80 (0.80–0.83) | 0.97 (0.92–1.04) | 1.67 (1.66–1.80) | 0 | 104 of 300 |
| archlast-forge, Postgres, default | 3/3 | 74,337 (72,135–76,342) | 0.82 (0.80–0.83) | 0.98 (0.91–1.06) | 1.71 (1.63–1.79) | 0 | 107 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 74,355 (70,729–76,115) | 0.82 (0.81–0.84) | 0.98 (0.91–1.14) | 1.69 (1.64–1.87) | 0 | 105 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 72,675 (70,377–73,032) | 0.83 (0.83–0.85) | 1.03 (1.00–1.09) | 1.82 (1.79–1.93) | 0 | 107 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 70,477 (57,828–72,463) | 0.85 (0.83–1.01) | 1.11 (1.06–1.56) | 1.87 (1.81–2.84) | 0 | 108 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 73,844 (70,957–75,359) | 0.82 (0.81–0.84) | 1.03 (0.91–1.08) | 1.75 (1.65–1.89) | 0 | 107 of 300 |
| Convex, SQLite, default | 3/3 | 20,190 (18,720–20,484) | 3.05 (3.00–3.26) | 4.71 (4.68–5.17) | 6.70 (6.55–7.88) | 0 | 294 of 300 |
| Convex, SQLite, optimized | 3/3 | 22,574 (21,988–22,642) | 2.72 (2.72–2.80) | 4.23 (4.18–4.34) | 5.90 (5.87–6.32) | 0 | 294 of 300 |
| Convex, Postgres, default | 3/3 | 14,050 (13,494–14,332) | 4.63 (4.62–4.81) | 6.31 (6.21–6.52) | 7.64 (7.38–8.16) | 0 | 211 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 15,939 (11,231–15,988) **noisy** | 4.21 (4.11–4.75) | 5.56 (5.53–9.79) | 6.49 (6.46–12.46) | 0 | 209 of 300 |

#### A. Cached query, open loop at 2,000 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 1,999 (1,999–2,000) | -0.37 (-0.38–-0.35) | 0.37 (0.22–0.43) | 0.90 (0.89–5.70) | 0 | 16 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | -0.40 (-0.40–-0.37) | 0.30 (0.16–0.37) | 0.82 (0.79–0.87) | 0 | 16 of 300 |
| archlast-forge, Postgres, default | 3/3 | 2,000 (1,999–2,000) | -0.40 (-0.41–-0.38) | 0.31 (0.20–0.39) | 0.81 (0.79–0.83) | 0 | 16 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | -0.41 (-0.41–-0.39) | 0.27 (0.20–0.32) | 0.80 (0.80–0.82) | 0 | 13 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 2,000 (1,999–2,000) | -0.39 (-0.39–-0.38) | 0.31 (0.28–0.31) | 0.84 (0.79–0.85) | 0 | 19 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | -0.37 (-0.39–-0.35) | 0.33 (0.19–0.36) | 0.84 (0.83–0.84) | 0 | 21 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 2,000 (2,000) | -0.37 (-0.42–-0.34) | 0.31 (0.30–0.34) | 0.79 (0.78–0.89) | 0 | 21 of 300 |
| Convex, SQLite, default | 3/3 | 2,000 (1,999–2,000) | -0.18 (-0.21–-0.15) | 0.49 (0.45–0.54) | 0.98 (0.98–1.10) | 0 | 35 of 300 |
| Convex, SQLite, optimized | 3/3 | 2,000 (1,999–2,000) | -0.21 (-0.22–-0.18) | 0.48 (0.44–0.52) | 0.90 (0.86–0.97) | 0 | 33 of 300 |
| Convex, Postgres, default | 3/3 | 2,000 (1,999–2,000) | -0.17 (-0.18–-0.16) | 0.51 (0.50–0.53) | 1.01 (1.00–1.05) | 0 | 34 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 2,000 (1,999–2,000) | -0.17 (-0.21–-0.16) | 0.50 (0.45–0.53) | 0.97 (0.95–1.14) | 0 | 33 of 300 |

#### B. Uncached query over 64 lists, closed loop (forge: CACHE_TTL_MS=0; Convex: its result cache as it is)

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 21,500 (20,799–21,830) | 2.82 (2.76–2.90) | 3.47 (3.41–3.63) | 5.08 (4.61–5.48) | 0 | 106 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 38,284 (33,350–38,333) | 1.48 (1.46–1.66) | 2.59 (2.58–3.00) | 4.96 (4.85–5.46) | 0 | 216 of 300 |
| archlast-forge, Postgres, default | 3/3 | 15,716 (15,188–16,306) | 3.92 (3.72–3.97) | 5.84 (5.51–6.19) | 10.49 (8.28–10.61) | 0 | 194 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 21,654 (17,595–22,848) | 2.51 (2.51–3.09) | 5.82 (5.39–7.00) | 11.65 (8.79–13.77) | 0 | 243 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 4,783 (4,392–4,826) | 12.67 (12.45–13.84) | 17.47 (17.46–19.41) | 25.18 (23.95–27.04) | 0 | 183 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 9,750 (9,630–10,814) | 6.13 (5.65–6.22) | 12.79 (11.27–12.99) | 20.39 (18.81–21.20) | 0 | 256 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 9,347 (8,912–10,925) | 6.43 (5.67–6.51) | 13.22 (10.74–14.36) | 21.84 (18.38–24.57) | 0 | 255 of 300 |
| Convex, SQLite, default | 3/3 | 20,087 (19,529–20,662) | 3.08 (2.98–3.15) | 4.71 (4.57–4.89) | 6.57 (6.43–7.04) | 0 | 294 of 300 |
| Convex, SQLite, optimized | 3/3 | 22,508 (21,576–22,551) | 2.74 (2.73–2.85) | 4.19 (4.19–4.44) | 5.99 (5.93–6.40) | 0 | 294 of 300 |
| Convex, Postgres, default | 3/3 | 14,047 (13,957–14,638) | 4.65 (4.52–4.67) | 6.38 (6.04–6.40) | 7.67 (7.09–7.73) | 0 | 211 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 15,839 (14,410–15,942) | 4.19 (4.15–4.31) | 5.61 (5.49–6.33) | 6.51 (6.33–10.78) | 0 | 210 of 300 |

#### B. Same, open loop at 2,000 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 2,000 (2,000) | -0.30 (-0.31–-0.29) | 0.39 (0.38–0.45) | 0.93 (0.93–0.96) | 0 | 22 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 2,000 (2,000) | -0.26 (-0.27–-0.22) | 0.45 (0.43–0.52) | 1.00 (0.99–1.13) | 0 | 29 of 300 |
| archlast-forge, Postgres, default | 3/3 | 2,000 (1,999–2,000) | -0.16 (-0.18–-0.14) | 0.50 (0.50–0.55) | 1.21 (1.17–1.54) | 0 | 43 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 2,000 (2,000) | -0.09 (-0.12–-0.08) | 0.69 (0.61–0.69) | 1.51 (1.20–1.77) | 0 | 51 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 2,000 (1,999–2,000) | 0.39 (0.16–0.40) | 1.73 (1.15–1.80) | 6.57 (5.19–8.13) | 0 | 87 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | 0.26 (0.23–0.52) | 2.74 (2.66–4.36) | 10.93 (10.04–14.37) | 0 | 84 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 1,999 (1,999–2,000) | 0.48 (0.28–0.59) | 4.56 (3.38–4.64) | 14.50 (10.99–15.49) | 0 | 106 of 300 |
| Convex, SQLite, default | 3/3 | 2,000 (1,999–2,000) | -0.20 (-0.21–-0.19) | 0.45 (0.43–0.49) | 0.95 (0.90–0.99) | 0 | 34 of 300 |
| Convex, SQLite, optimized | 3/3 | 2,000 (2,000) | -0.23 (-0.24–-0.22) | 0.46 (0.44–0.46) | 0.93 (0.88–0.94) | 0 | 32 of 300 |
| Convex, Postgres, default | 3/3 | 2,000 (2,000) | -0.19 (-0.20–-0.17) | 0.53 (0.46–0.53) | 1.00 (1.00) | 0 | 36 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 2,000 (2,000) | -0.20 (-0.20–-0.18) | 0.48 (0.44–0.52) | 0.93 (0.88–1.09) | 0 | 31 of 300 |

#### B′. Convex without its result cache (a throwaway argument per call), closed loop

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Convex, SQLite, default | 3/3 | 825 (825–847) | 74.56 (72.85–74.99) | 94.83 (91.35–95.23) | 122.59 (119.93–128.01) | 0 | 291 of 300 |
| Convex, SQLite, optimized | 3/3 | 821 (789–860) | 75.80 (72.64–79.12) | 107.83 (102.93–111.71) | 143.64 (135.11–153.88) | 0 | 292 of 300 |
| Convex, Postgres, default | 3/3 | 597 (572–608) | 105.91 (103.85–110.44) | 121.37 (120.01–128.88) | 142.21 (137.59–148.80) | 0 | 219 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 612 (577–619) | 102.55 (101.66–109.10) | 134.47 (133.51–144.29) | 169.58 (168.04–181.60) | 0 | 219 of 300 |

#### B′. Same, open loop at 2,000 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Convex, SQLite, default | 3/3 | 813 (800–829) | 4484.59 (4326.50–4624.14) | 8125.11 (7874.20–8158.28) | 8860.69 (8714.82–8941.81) | 0 | 291 of 300 |
| Convex, SQLite, optimized | 3/3 | 800 (785–854) | 4502.37 (4357.92–4552.15) | 7952.19 (7801.59–8179.41) | 8969.45 (8600.76–9076.31) | 0 | 291 of 300 |
| Convex, Postgres, default | 3/3 | 589 (579–594) | 5281.69 (5260.38–5296.14) | 9558.70 (9539.44–9662.61) | 10545.13 (10514.11–10627.57) | 0 | 219 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 592 (551–603) | 5258.41 (4948.35–5318.27) | 9527.08 (9456.32–9936.24) | 10527.06 (10448.66–10845.66) | 0 | 220 of 300 |

#### C. Insert mutation, closed loop, inserts spread over the 64 lists

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 12,452 (12,194–13,134) | 4.76 (4.74–4.89) | 7.09 (6.55–7.11) | 20.74 (15.74–23.57) | 0 | 113 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 13,728 (12,642–13,742) | 1.88 (1.84–1.95) | 3.39 (3.14–3.91) | 35.86 (25.91–45.89) | 0 | 145 of 300 |
| archlast-forge, Postgres, default | 3/3 | 651 (633–2,825) **noisy** | 96.20 (21.99–99.48) | 110.84 (26.24–116.57) | 139.74 (32.57–144.20) | 0 | 37 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 1,112 (1,086–3,185) **noisy** | 53.74 (13.97–57.15) | 69.96 (50.29–71.43) | 85.73 (61.29–91.41) | 0 | 58 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 2,845 (2,810–9,974) **noisy** | 20.93 (6.03–21.19) | 30.06 (8.36–30.41) | 37.30 (13.75–42.12) | 0 | 53 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 5,823 (2,494–8,686) **noisy** | 8.05 (6.53–22.29) | 21.04 (11.21–40.02) | 32.19 (19.92–68.23) | 0 | 131 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 14,465 (13,625–16,633) | 3.67 (3.28–4.00) | 7.48 (6.05–7.73) | 13.13 (11.33–13.75) | 0 | 221 of 300 |
| Convex, SQLite, default | 3/3 | 628 (255–699) **noisy** | 100.29 (90.46–244.85) | 134.52 (119.99–334.50) | 171.65 (147.56–428.79) | 0 | 181 of 300 |
| Convex, SQLite, optimized | 3/3 | 309 (274–316) | 208.37 (198.25–226.25) | 283.91 (271.82–324.60) | 412.74 (359.64–414.21) | 0 | 87 of 300 |
| Convex, Postgres, default | 3/3 | 805 (795–860) | 78.72 (73.89–78.96) | 105.08 (98.88–106.51) | 136.70 (126.07–141.78) | 0 | 218 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 796 (780–863) | 78.98 (73.99–81.99) | 105.31 (97.13–106.99) | 133.96 (128.04–139.33) | 0 | 212 of 300 |

#### C. Insert mutation, open loop at 500 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 500 (500) | -0.19 (-0.21–-0.16) | 0.52 (0.47–0.55) | 1.70 (1.39–1.76) | 0 | 21 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | -0.03 (-0.05–0.12) | 1.05 (1.04–1.34) | 3.84 (2.19–5.89) | 0 | 24 of 300 |
| archlast-forge, Postgres, default | 3/3 | 499 (496–500) | 10.57 (1.57–10.59) | 24.84 (2.74–27.51) | 49.61 (5.22–123.83) | 0 | 31 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 500 (499–500) | 9.12 (8.99–12.84) | 22.62 (12.14–28.00) | 50.15 (47.46–240.86) | 0 | 31 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 499 (497–500) | 15.69 (14.24–15.76) | 25.51 (19.58–31.10) | 46.07 (30.91–107.73) | 0 | 36 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 499 (499–500) | 11.20 (9.72–13.31) | 18.56 (16.00–27.98) | 45.07 (27.55–68.33) | 0 | 50 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 500 (500) | 0.24 (0.16–0.27) | 1.31 (1.28–1.68) | 5.92 (5.19–5.96) | 0 | 38 of 300 |
| Convex, SQLite, default | 3/3 | 364 (242–498) **noisy** | 72.69 (47.11–4183.98) | 3014.73 (69.18–7303.44) | 4091.16 (94.58–7884.43) | 0 | 116 of 300 |
| Convex, SQLite, optimized | 3/3 | 284 (278–304) | 3322.31 (3131.49–3358.95) | 6099.61 (5449.88–6224.45) | 6651.44 (6032.91–6853.23) | 0 | 82 of 300 |
| Convex, Postgres, default | 3/3 | 499 (498–500) | 17.83 (9.06–19.50) | 26.91 (14.90–35.38) | 45.06 (24.77–201.11) | 0 | 151 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 500 (499–500) | 9.50 (8.98–17.84) | 20.09 (16.63–31.63) | 41.03 (30.64–70.71) | 0 | 160 of 300 |

#### D. Read-modify-write mutation (toggle), closed loop, cycling the 1,280 todos

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 23,634 (22,914–24,712) | 2.75 (2.64–2.78) | 3.84 (3.61–3.99) | 6.89 (6.58–7.10) | 0 | 110 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 28,549 (26,696–29,111) | 1.00 (0.99–1.05) | 1.86 (1.83–2.18) | 22.90 (20.68–34.51) | 0 | 167 of 300 |
| archlast-forge, Postgres, default | 3/3 | 2,553 (2,001–2,685) **noisy** | 20.47 (19.61–21.49) | 39.02 (33.65–73.63) | 81.03 (64.11–143.33) | 0 | 117 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 1,465 (1,117–3,220) **noisy** | 39.10 (15.83–45.37) | 73.79 (32.72–89.22) | 146.84 (65.72–200.88) | 0 | 94 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 1,439 (696–1,865) **noisy** | 34.27 (32.83–90.98) | 86.34 (42.71–107.04) | 104.54 (58.10–136.30) | 0 | 105 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 1,980 (1,842–2,368) **noisy** | 27.17 (23.65–27.82) | 51.65 (43.95–56.88) | 70.73 (63.24–84.19) | 0 | 186 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 3,123 (3,052–3,347) | 17.37 (16.39–17.68) | 32.97 (30.43–33.46) | 50.16 (48.61–55.33) | 0 | 212 of 300 |
| Convex, SQLite, default | 3/3 | 572 (442–626) **noisy** | 110.24 (100.73–110.88) | 146.88 (133.45–289.64) | 185.08 (159.04–386.84) | 0 | 173 of 300 |
| Convex, SQLite, optimized | 3/3 | 682 (678–712) | 92.05 (88.46–92.78) | 120.18 (116.21–121.40) | 156.45 (143.37–157.84) | 0 | 191 of 300 |
| Convex, Postgres, default | 3/3 | 786 (778–798) | 80.75 (78.71–81.03) | 105.19 (103.26–105.58) | 128.91 (125.67–131.52) | 0 | 224 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 799 (787–803) | 78.70 (77.61–79.58) | 104.70 (101.50–104.70) | 134.61 (127.13–144.56) | 0 | 220 of 300 |

#### D. Read-modify-write, open loop at 500 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 500 (500) | -0.25 (-0.27–-0.24) | 0.44 (0.44–0.49) | 1.67 (1.41–2.41) | 0 | 19 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | -0.01 (-0.05–0.07) | 0.99 (0.99–29.55) | 4.97 (2.27–246.13) | 0 | 21 of 300 |
| archlast-forge, Postgres, default | 3/3 | 499 (499–500) | 9.59 (1.63–10.17) | 17.72 (2.99–18.05) | 40.49 (8.34–49.66) | 0 | 39 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | 8.85 (1.68–9.83) | 12.67 (2.86–18.27) | 25.54 (7.30–59.31) | 0 | 41 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 499 (499–500) | 11.47 (2.70–12.88) | 19.63 (5.25–26.48) | 60.40 (14.17–104.72) | 0 | 62 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | 3.33 (3.00–11.65) | 13.01 (12.99–19.28) | 28.83 (28.46–46.82) | 0 | 84 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 500 (500) | 0.71 (0.47–0.77) | 4.78 (4.11–5.66) | 13.99 (13.23–28.64) | 0 | 54 of 300 |
| Convex, SQLite, default | 3/3 | 498 (216–499) **noisy** | 74.32 (64.61–4325.59) | 136.29 (96.13–7884.29) | 224.20 (141.59–8695.58) | 0 | 152 of 300 |
| Convex, SQLite, optimized | 3/3 | 395 (273–499) **noisy** | 73.48 (65.41–3713.36) | 2237.45 (97.75–6389.23) | 3159.17 (138.75–6922.92) | 0 | 118 of 300 |
| Convex, Postgres, default | 3/3 | 500 (499–500) | 17.67 (11.64–21.45) | 25.72 (23.70–46.91) | 36.93 (33.91–83.31) | 0 | 161 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 500 (500) | 10.33 (9.73–16.09) | 22.53 (19.12–31.04) | 47.25 (37.42–146.10) | 0 | 167 of 300 |

#### E. Reactive fan-out: 1,000 subscribers on one live query, 10 inserts/s for 15 s (delivery latency in ms, from the write's send time)

| System / config | kept runs | p50 | p90 | p99 | max | per-write p50 / p99 | updates received / expected | clients that saw every write | settle after last write ms | function re-runs per write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 65 (65–66) | 88 (87–89) | 104 (102–107) | 117 (110–129) | n/a | 149,000 / 149,000 | n/a (every update arrived) | n/a | 1.00 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 69 (66–70) | 92 (89–95) | 108 (107–113) | 128 (116–140) | n/a | 147,000 / 148,000 | n/a (every update arrived) | n/a | 1.00 |
| archlast-forge, Postgres, default | 3/3 | 71 (67–74) | 94 (93–109) | 126 (112–132) | 152 (122–163) | n/a | 144,000 / 147,000 | n/a (every update arrived) | n/a | 0.99 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 72 (69–72) | 97 (94–98) | 119 (118–119) | 136 (132–137) | n/a | 145,000 / 147,000 | n/a (every update arrived) | n/a | 0.99–1.01 |
| archlast-forge, MongoDB, default | 2/3 | 72 (70–74) | 96 (94–98) | 117 (114–120) | 135 (127–142) | n/a | 144,500 / 146,000 | n/a (every update arrived) | n/a | 0.99–1.00 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 72 (72–74) | 98 (93–102) | 122 (116–125) | 142 (137–166) | n/a | 142,000 / 147,000 | n/a (every update arrived) | n/a | 0.96–1.00 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 68 (66–68) | 91 (89–93) | 107 (105–112) | 115 (113–126) | n/a | 148,000 / 148,000 | n/a (every update arrived) | n/a | 1.00 |
| Convex, SQLite, default | 3/3 | 67 (48–71) | 124 (106–127) | 622 (618–656) | 1,305 (1,184–1,335) | 470 / 3829 | 28,398 / 150,000 | 1,000 | 1,101–1,306 | not measured |
| Convex, SQLite, optimized | 3/3 | 68 (65–71) | 125 (121–130) | 622 (578–705) | 1,397 (1,013–1,405) | 476 / 3917 | 28,333 / 150,000 | 1,000 | 1,013–1,404 | not measured |
| Convex, Postgres, default | 3/3 | 56 (55–57) | 123 (121–137) | 741 (726–970) | 1,572 (1,150–1,871) | 477 / 3838 | 27,893 / 148,000 | 1,000 | 1,102–1,801 | not measured |
| Convex, Postgres tuned, optimized | 3/3 | 59 (52–66) | 128 (112–143) | 727 (534–1,020) | 1,505 (1,262–1,957) | 482 / 3879 | 27,757 / 149,000 | 1,000 | 1,201–1,906 | not measured |

#### E′. The same, archlast-forge measured with the Convex port's client code (WebSocket in Node)

| System / config | kept runs | p50 | p90 | p99 | max | per-write p50 / p99 | updates received / expected | clients that saw every write | settle after last write ms | function re-runs per write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 68 (67–69) | 89 (87–91) | 103 (101–110) | 114 (109–140) | 68 / 103 | 149,000 / 149,000 | 1,000 | 0–100 | not measured |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 70 (69–70) | 91 (88–93) | 106 (102–136) | 126 (110–147) | 70 / 106 | 148,000 / 148,000 | 1,000 | 0 | not measured |
| archlast-forge, Postgres, default | 3/3 | 78 (74–86) | 107 (98–108) | 131 (124–137) | 150 (145–158) | 78 / 137 | 145,000 / 146,000 | 1,000 | 0–99 | not measured |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 76 (75–82) | 105 (100–108) | 133 (126–135) | 153 (146–155) | 76 / 145 | 143,000 / 145,000 | 1,000 | 0–101 | not measured |
| archlast-forge, MongoDB, default | 3/3 | 78 (71–82) | 103 (93–107) | 124 (124–125) | 144 (136–157) | 78 / 196 | 136,000 / 145,000 | 1,000 | 0–101 | not measured |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 77 (75–79) | 99 (94–102) | 116 (107–118) | 129 (116–131) | 77 / 122 | 144,000 / 148,000 | 1,000 | 0–101 | not measured |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 69 (69–70) | 91 (89–91) | 106 (103–109) | 115 (115–122) | 69 / 106 | 148,000 / 149,000 | 1,000 | 0 | not measured |

#### Control: the machine's own noise (Bun.serve answering a fixed 20-document body, same cores and load generator)

| When | case | runs | req/s | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before | closed | 3 | 108,216 (108,137–111,798) | 0.55 (0.55–0.56) | 0.63 (0.59–0.64) | 1.25 (1.22–1.29) | 8.4 (8.2–14.8) |
| before | open2000 | 3 | 2,000 (2,000) | -0.38 (-0.40–-0.37) | 0.29 (0.29–0.33) | 0.70 (0.68–0.81) | 13.1 (8.2–19.7) |
| after | closed | 3 | 110,734 (109,729–111,825) | 0.55 (0.54–0.55) | 0.61 (0.60–0.61) | 1.24 (1.24–1.25) | 8.4 (7.2–9.2) |
| after | open2000 | 3 | 2,000 (2,000) | -0.38 (-0.40–-0.37) | 0.34 (0.30–0.37) | 0.75 (0.71–0.79) | 10.2 (8.8–13.0) |

#### Discarded runs and errors

- run 2 forge-mongodb-default E: updates 121000/135000, missing undefined

## 4. What this does and doesn't show

**Where the ranges clearly don't overlap**

- **A, cached query (closed loop):** archlast-forge 70,500–75,500 req/s on every database, Convex 14,000 (Postgres) to 22,600 (SQLite optimized). Roughly 3.3–5× in throughput at a half to a third of the CPU. Caveat: the forge figure is probably not the server's limit: in these runs the load generator sat at 81–86% of its core (the control tops out near 110,000 req/s) and the server used about one core, so the forge ceiling may be higher than shown.
- **B′, Convex with its result cache bypassed:** Convex 597–825 req/s (p50 75–106 ms), against 15,716–38,284 req/s for forge uncached on the same database. Convex uses about 3.7 ms of CPU per query here with all its cores busy and the database mostly idle (23% on Postgres), so the cost is in the function execution, not the database. On Postgres, where forge has no read cache below it, the comparison is 15,716 vs 597 req/s (about 26×). At an open loop of 2,000 req/s Convex served only 589–813 req/s and requests queued for 4.5–5.3 s (p50).
- **C and D on SQLite:** forge 12,452–13,728 (inserts) and 23,634–28,549 (toggles) req/s; Convex 309–628 (inserts, **noisy**) and 572–682 (toggles). The durability note below applies, and section 7 has the `FULL` numbers.
- **E, fan-out delivery shape:** see the E tables. Convex merges updates when its clients can't keep up: about 28,000 of 150,000 possible messages arrived. Every client did see every write (clients seeing every write: 1,000 of 1,000 in every Convex run), but the settle time after the last write was 1.0–1.9 s, the p99 of "newest row seen" 580–1,020 ms, and per write (counting merged writes from the moment they were written) p50 about 470 ms and p99 about 3.8–3.9 s. archlast-forge's p99 is 104–126 ms and its updates arrive one per write, except where its 50 ms debounce merges two writes that land within 50 ms of each other.

**Ties and no winner**

- **B with Convex's cache on, vs forge uncached.** Convex SQLite optimized 22,508 (21,576–22,551) overlaps forge SQLite default 21,500 (20,799–21,830); default Convex 20,087 vs forge 21,500 is a 7% edge that is within what the control suggests. On Postgres, Convex optimized 15,839 (14,410–15,942) overlaps forge default 15,716 (15,188–16,306). Forge ahead only with `RUNTIME_WORKERS=2` (SQLite 38,284; Postgres tuned 21,654 vs Convex 15,839), using more CPU (216–243 of 300 vs Convex's 210–294).
- **Open loop at 2,000 req/s for cached and uncached queries:** all configs sit at p99 0.8–1.5 ms except forge on MongoDB (6–15 ms in B). No difference between forge and Convex.
- **C inserts over Postgres:** forge 651 (633–2,825) and 1,112 (1,086–3,185) vs Convex 805 (795–860): the ranges overlap and forge's are **noisy**. D (toggle) over Postgres: forge default 2,553 (2,001–2,685) and tuned+workers 1,465 (1,117–3,220, noisy) vs Convex 786 (778–798): forge's lowest run is above Convex's best, though forge's spread is wide.
- **E p50 (newest-row definition):** Convex 56–68 ms, forge 65–72 ms. The forge figure includes its 50 ms debounce (the engine waits 50 ms to coalesce re-runs before sending), so it cannot be below 50 ms; Convex's p50 omits merged updates, which is why its p99 and per-write numbers are the more telling. Forge measured with the Convex port's client code (E′) gives 68–78 ms, so the client code does not explain the tail difference.

**Things that limit what you can conclude**

- **Durability is not the same.** All the tables above were measured with archlast-forge's SQLite on `synchronous = NORMAL` (the engine's setting when the benchmark was run) in WAL mode, which keeps data through a process crash but can lose the last commits on power loss. Section 7 repeats the forge SQLite runs with durable commits: the plain `synchronous = FULL` halves insert and toggle throughput (7.1), and the shipped design (7.2) matches the non-durable inserts when the disk syncs in about 1.2 ms and falls to about 3,500 inserts/s when it takes about 6 ms, still several times Convex's. I did **not** check what Convex's SQLite or its Postgres path syncs. Part of the SQLite mutation gap (12,000+ vs 300–700 req/s) may be this, not engine speed. Over Postgres and MongoDB (majority-acknowledged, journaled) forge has to wait for the disk too, and the gap closes to the noisy 1–3× above. `w=1 journal=false` on MongoDB is the less durable variant; against the durable MongoDB config with the same two workers it was 2.5× faster on inserts (14,465 vs 5,823 req/s) and 1.6× on toggles (3,123 vs 1,980) — a durability/speed trade, reported separately.
- **Convex's result cache** makes repeated reads cheap; whether a workload looks like B (repeats) or B′ (distinct arguments) decides which Convex figure applies. The nonce method for B′ is my own way to bypass a cache that can't be turned off.
- **forge's SQLite "uncached" path is not cache-free below the engine**: the engine's per-statement read cache (`read-cache.ts`) is on when the process is the only writer. The Postgres and MongoDB numbers have no such cache.
- **Architecture:** Convex runs each function as JavaScript in a V8 isolate and offers serializable transactions with optimistic concurrency and retained history; archlast-forge runs functions in-process in Bun. Some of the gap is that design, and neither list of features was measured.
- **Single machine, three cores for server+database, one for the load generator, synthetic 20-row reads and single-row writes.** Nothing here speaks to scale-out, large documents, auth, files, or long-running soak behaviour. The Convex binary I used is the local-development backend, not the Docker image or a Convex Cloud deployment.
- **Different client code:** E uses archlast-forge's own `fanout.ts` for forge (Bun, raw WebSocket) and a Node `ConvexClient` for Convex. E′ runs the Convex port's code against forge too (the Convex port computes the per-write numbers; `fanout.ts` cannot). Function re-runs per write: forge about 1.0 (0.96–1.01) from `/metrics`; Convex **not measured** (no counter was read).
- **Case C differs from `case.sh post`** in one way: inserts are spread over the 64 lists instead of all going to one, because after a few hundred thousand inserts a single list exceeds what a query may return (the data check could no longer read it). The same is done for both systems.
- **GET vs POST:** forge's queries are `GET` (as in its own harness), Convex's are `POST`.

## 5. Surprising or broken, as found

1. **Convex answers HTTP 200 to failed functions** (`{"status":"error",…}`). A load generator that counts only non-2xx would report 100% success on a broken run. `load.mjs` got an opt-in `OK_BODY` for this; without it, Convex errors would have gone unnoticed. (There were none in the kept runs.)
2. **Durable-write cases are unstable on this disk.** Per-run req/s for C (inserts): forge Postgres default 2,825 / 651 / 633, forge Postgres tuned 3,185 / 1,112 / 1,086, forge MongoDB default 9,974 / 2,810 / 2,845, Convex SQLite default 699 / 255 / 628. For the forge Postgres and MongoDB configs the first run was 3–4× faster than runs 2 and 3 (Convex SQLite default dipped only in run 2), while the configs that rarely wait for the disk (forge SQLite with `synchronous=NORMAL`, MongoDB with `journal=false`) did not move. The control did not drift. I did not capture disk activity, so the cause is **not determined**; a shared btrfs/encrypted volume and a running VM are the candidates. Treat every durable mutation row as noisy; reads and fan-out were stable.
3. **Convex SQLite "optimized" was slower than default for inserts** in all three runs (309 vs 628 req/s; and 284 vs 364 at 500 req/s open loop, where it fell behind and queued for seconds), yet slightly better for toggles (682 vs 572) and cached reads (22,574 vs 20,190). In the short sweep the same knobs did not show this for inserts. I did not investigate; I report it as measured.
4. **Convex saturates 3 cores to serve 600–800 uncached queries/s**, and its Postgres backend was no faster than SQLite for any read case, with Postgres reads a little slower (14,050 vs 20,190 cached).
5. **Convex's default logging** writes one INFO line per request to stdout: 938,381 lines in one phase. Setting `RUST_LOG=warn` is part of "optimized"; in the single-run sweep cached reads were 23,032 vs 20,314 req/s with it, and in the matrix the optimized rows are mixed.
6. **archlast-forge on MongoDB** is its weakest backend for uncached reads (4,783 req/s default, 9,750 with two workers vs 15,716 on Postgres) and its open-loop tails are the longest (p99 6–15 ms at 2,000 req/s). Its durable mutations are noisy (above).
7. **`benchmarks/load/engine-compare.sh` cannot run MongoDB as written:** it names a container `forge-mongo`, but `docker-compose.yml` creates `archlast-forge-mongo-1`, so its `docker update` fails. I used my own runner and did not edit the script.
8. **Fan-out runs flagged by my own rule:** `matrix.mjs` first discarded any archlast-forge fan-out run whose message count was not exactly writes × clients. Nine runs tripped it. In eight of them the run on the same server with the Convex port's client (E′) showed no client missing a write and at least 90% of the messages had arrived, so the shortfall is the 50 ms debounce merging writes that land close together, and `tables.mjs` keeps them (their message counts are in the table). The ninth, `forge-mongodb-default` in run 2, received 121,000 of 135,000 (below the 90% I accept) and stays discarded; that is why that row shows 2 of 3.
9. **A slip of mine, caught early:** during the smoke tests a leftover backend from my first manual test still held port 3210, so the first deploy failed with a misleading "admin key invalid" error. I killed it before the sweep and the matrix, so none of the reported runs were affected.

## 6. Reproducing

```bash
bun install && bun run services:up                # Postgres :55432, MongoDB :57017
cd benchmarks/load/convex && npm install          # convex client/CLI
# the Convex backend: download convex-local-backend from the release named above into ~/.cache/bench/bin/,
# put a 64-character hex secret in ~/.cache/bench/convex-secret
./run-all.sh                                      # about 2.5 hours: control, 3 runs of every config, control
node tables.mjs results/results.jsonl results/results-control-end.jsonl   # -> results/tables.md
```

The section 7 addendum: `node matrix.mjs --runs 1 --configs control,forge-sqlite-default,forge-sqlite-normal --out results-sync/results.jsonl` (section 7.1) and the sequence in `results-sync/final/go.sh` (7.2); both need the `SQLITE_SYNCHRONOUS` change (commit `92d284e`); on an engine without it both rows run `NORMAL`.

Raw per-run records: `convex/results/results.jsonl`; one run's tables above were generated from them with `tables.mjs` (a run flagged `discard` is left out; the reasons are in the last list of section 3).

## 7. Addendum: archlast-forge's SQLite with durable commits

**Why.** Section 4 says part of the SQLite mutation gap may be a durability difference. archlast-forge's SQLite ran `PRAGMA synchronous = NORMAL`: in WAL mode that never syncs at commit, so an acknowledged write survives a crash of the engine but can be lost to a power cut or an operating-system crash. The change in commit `92d284e` (branch `claude/sqlite-synchronous`, merged below this report's commit) adds `SQLITE_SYNCHRONOUS=FULL|NORMAL`, default `FULL`. Everything in sections 3–6 was measured with `NORMAL`, which is what the engine did then; `NORMAL` is still available and is the "before" column here. The only harness change is one added config, `forge-sqlite-normal` (`SQLITE_SYNCHRONOUS=NORMAL`), in [`convex/matrix.mjs`](convex/matrix.mjs). Nothing in this section involves Convex, Postgres or MongoDB. Raw records, logs and the small probe scripts are in [`convex/results-sync/`](convex/results-sync/).

**The one thing to know first: the disk.** With durable commits a write waits for the disk, and this disk's sync time changed a lot while I measured. A bare probe (append 4 KiB and `fsync`, 400 times, [`probes/fs.ts`](convex/results-sync/probes/fs.ts)) gave a median of:

| When | fsync p50 |
| --- | --- |
| three probes before the final sequence below | 1.12, 1.16, 1.25 ms |
| after its read and fan-out cases, before its write cases | 2.26 ms |
| three probes after its write cases | 5.60, 5.88, 6.42 ms |
| earlier probes the same day | 1.00, 1.05, 1.01 ms; later 2.26, 5.77, 6.16 ms |

I did not find out why a sync went from about 1 ms to about 6 ms within some 15 minutes of heavy writing (an SSD that slows as its write cache fills would do it, but I did not test that). When I looked, no other process was writing much (the largest was 33 KiB/s over 8 s), but I cannot rule out a background cause; the IO-pressure averages in `/proc/pressure/io` are dominated by my own runs and say nothing either way. The same effect shows without HTTP: the engine's database layer alone, 64 writers, did 50,879 writes/s when a sync took about 1.1 ms and 9,766 when it took about 5 ms ([`probes/dbsync.ts`](convex/results-sync/probes/dbsync.ts), run with the earlier worker-based syncer of 7.3). **Every number below carries the disk state it was measured in.** The earlier Convex and archlast-forge runs in sections 3–6 were made on this disk at times I did not probe.

### 7.1 `synchronous = FULL` the plain way (one run)

**How.** The same matrix, same cores (server 2–5, load generator on its own core, the VM pinned away), same cases and settings, but **one run** per configuration, not three, and only archlast-forge on SQLite, no Convex, no Postgres or MongoDB: `node matrix.mjs --runs 1 --configs control,forge-sqlite-default,forge-sqlite-normal`. The `control` ran first: 106,173 req/s closed loop, p99 1.27 ms, in line with section 3. Raw records and logs: [`convex/results-sync/`](convex/results-sync/results.jsonl). With one run there is no range and no way to call a difference noise from this table alone, so I compare against the three-run ranges above where I can. Every case had 0 errors, and C and D passed the data checks (E follows the rule in section 5).

| Case | `FULL` (new default) | `NORMAL` (as in sections 3–4) | Change |
| --- | --- | --- | --- |
| A. cached query, closed loop, req/s (p99 ms) | 72,491 (1.72) | 73,415 (1.72) | none |
| B. uncached query, closed loop, req/s (p99 ms) | 21,892 (5.21) | 21,848 (5.32) | none |
| C. insert, closed loop, req/s (p50 / p99 ms) | **6,472** (10.73 / 17.31) | 12,673 (4.76 / 20.87) | −49% |
| D. toggle, closed loop, req/s (p50 / p99 ms) | **13,186** (5.21 / 8.51) | 24,373 (2.66 / 6.66) | −46% |
| C. insert, open loop at 500 req/s, p90 / p99 ms | 2.46 / 5.88 | 0.46 / 3.44 | one lone sync is about 2 ms |
| D. toggle, open loop at 500 req/s, p90 / p99 ms | 2.46 / 4.25 | 0.44 / 4.35 | same |
| E. fan-out p50 / p99 ms (every client saw every write in both) | 67 / 109 | 65 / 111 | none |

- **What moved.** Only writes, by about half in the closed loop, and by about 2 ms of added latency for a write that arrives alone (open loop, where nothing shares the sync). Reads (A, B, and the open-loop reads), and the fan-out (E) are unchanged. The one visible oddity: the open-loop A run with `FULL` has a p99 of 4.59 ms against 0.92 ms with `NORMAL`, although reads do not write; I have one run of each and don't know whether that is noise, so I don't read anything into it.
- **The `NORMAL` row agrees with the three-run data.** Its inserts (12,673) and toggles (24,373) fall inside the ranges in section 3 (12,452–13,728 and 23,634–28,549), so this run did not drift.
- **Against Convex.** With `FULL`, archlast-forge's SQLite did 6,472 inserts/s and 13,186 toggles/s (one run), against Convex's 309–628 and 572–682 in section 3: still about 10–20× and 19–23× ahead. The caveat in section 4 stands on the other side: I did not check what Convex syncs, so this narrows the unknown but does not remove it. Whether the Convex numbers are for the same durability as `FULL` is still **not measured**.
- **Why writes lose half is not measured.** A standalone SQLite script with the same group-commit shape (not the engine; 8 s, one run each) gave 82,031 inserts/s on `NORMAL` against 17,853 on `FULL` with 64 clients, 44,617 against 832 for one client, and an fsync of about 3.5 ms on this disk. My guess was that the sync blocks the event loop of the process that owns the writer. Section 7.2 changes that and measures it.
- **Limits.** One run per configuration; one disk (btrfs on an encrypted volume, where fsync cost is higher and noisier than on many servers); SQLite only. Postgres and MongoDB were not rerun: their commit settings did not change.

### 7.2 FULL without stopping the runtime: the shipped design

`PRAGMA synchronous = FULL` fsyncs inside `COMMIT`, on the thread that runs the functions, and that is what cost half the write throughput in 7.1. The shipped design keeps the writer's connection on `NORMAL` and fsyncs the `-wal` file through the asynchronous `fs.fsync` (`WalSyncer` in `packages/runtime/src/server/db/sqlite.ts`; a 1 ms timer kept ticking through 300 such fsyncs, largest gap 1.1 ms, [`probes/afs.ts`](convex/results-sync/probes/afs.ts)). A write is answered when an fsync that began after its commit has finished, and the commits that arrive during a sync share the next one. Raw data: [`results-sync/final/`](convex/results-sync/final/).

**How.** Same cores and cases. One sequence: `control`, then the read and fan-out cases once, then the write cases (C, D and their open loops) three times with `forge-sqlite-default` (FULL) and `forge-sqlite-normal` taking turns inside each run, so both see the same disk. Every case had 0 errors and passed the data checks.

*Closed loop, 64 connections, per run (req/s; p50 / p99 ms). The disk's sync time rose across the three runs (the probes above).*

| Case | Run | FULL | NORMAL |
| --- | --- | --- | --- |
| C, inserts | 1 | **12,939** (4.61 / 11.7) | 13,039 (4.64 / 20.1) |
| C, inserts | 2 | 3,645 (16.98 / 34.8) | 13,379 (4.59 / 21.6) |
| C, inserts | 3 | 3,535 (15.94 / 109.2) | 12,719 (4.72 / 21.0) |
| D, toggles | 1 | 21,472 (2.76 / 5.8) | 24,166 (2.64 / 7.3) |
| D, toggles | 2 | 21,307 (2.78 / 6.1) | 25,222 (2.62 / 7.7) |
| D, toggles | 3 | 4,385 (13.02 / 42.1) | 25,281 (2.65 / 6.4) |

Medians (min–max): C FULL 3,645 (3,535–12,939, **noisy**), C NORMAL 13,039 (12,719–13,379); D FULL 21,307 (4,385–21,472, **noisy**), D NORMAL 25,222 (24,166–25,281).

*Open loop at 500 req/s, so most writes arrive alone (p50 / p90 / p99 ms; the negative p50 of the `NORMAL` rows is the timer artifact described in section 5):*

| Case | Run | FULL | NORMAL |
| --- | --- | --- | --- |
| C | 1 | 1.21 / 2.34 / 6.8 | −0.21 / 0.54 / 7.8 |
| C | 2 | 11.29 / 16.72 / 82.4 | −0.19 / 0.57 / 5.2 |
| C | 3 | 11.76 / 27.78 / 144.3 | −0.19 / 0.58 / 5.5 |
| D | 1 | 1.14 / 2.15 / 3.6 | −0.26 / 0.50 / 3.6 |
| D | 2 | 1.17 / 2.27 / 4.1 | −0.22 / 0.65 / 160.9 |
| D | 3 | 9.68 / 15.85 / 589.7 | −0.22 / 0.59 / 55.7 |

*Reads and fan-out (one run, FULL; `NORMAL` from 7.1 in brackets): A cached 74,970 req/s, p99 1.66 ms (73,415, 1.72); B uncached 22,837, p99 4.38 (21,848, 5.32); E fan-out p50 65, p99 119 ms with 139,000 of 146,000 updates (the strict count flagged it, as in section 5; the run on the Convex-port client had no client missing a write: p50 76, p99 127, 140,000 of 148,000) against 65 / 111 (148,000 of 148,000). The control ran first: 109,845 req/s, p99 1.24 ms.*

- **When the disk syncs in about 1.2 ms (run 1), durable inserts equal non-durable ones**: 12,939 against 13,039 req/s, one pair. Toggles are 11% lower (21,472 against 24,166). The plain `FULL` of 7.1 measured 6,472 and 13,186 on a fast disk, so the design roughly doubles inserts and adds about 60% to toggles. These compare different single runs an hour or more apart, both at times when a lone write took about 1.2–1.4 ms (which suggests a similar disk state; the disk was not probed during 7.1), not an interleaved pair.
- **When the disk syncs in about 6 ms (runs 2–3 for inserts, run 3 for toggles), durable writes fall to about 3,500 inserts and 4,400 toggles a second, and open-loop tails reach hundreds of ms**, while `NORMAL` does not move. This is the price of acknowledging a write only after the disk has it: 64 closed-loop clients can do no more than about 64 divided by the time a write waits (the first sync it misses plus its own). Nothing in the engine can shorten a sync; a faster disk shortens it.
- **Reads and fan-out are the same as with `NORMAL`**: A 74,970 against 73,415, B 22,837 against 21,848, E's p99 119 against 111 ms (single runs, ranges not known to differ).
- **A write that arrives alone waits for its own sync**: open loop p90 2.3 ms against 0.5 ms at a 1.2 ms sync.
- **Against Convex** (section 3: 309–628 inserts/s and 572–682 toggles/s on SQLite): the durable archlast-forge numbers here are 3,535–12,939 inserts/s and 4,385–21,472 toggles/s, at least 5× and 6× higher in the worst runs. As before, I did not check what Convex's SQLite syncs, and I did not probe the disk during the Convex runs, so this is an order-of-magnitude statement, not a ratio.
- **Kill test.** `packages/runtime/test/group-commit.test.ts` kills a writing process with SIGKILL after 3,000 answered writes and checks that none is missing. It covers a crash of the engine, which `NORMAL` also survives. A test cannot cut the power, so **power-loss durability is argued from how the design works (the answer waits for an fsync that began after the commit), not measured**.

### 7.3 What I tried and did not keep

All on the same disk with its changing sync time, so the pairs are the point, not the absolute numbers. Raw: [`results-sync/experiments/`](convex/results-sync/experiments/) and [`results-sync/pipelined-worker/`](convex/results-sync/pipelined-worker/).

- **A Worker thread doing the fsync** (the first version of the design above; same idea, different mechanism). On a fast disk, one run: 12,203 inserts and 20,220 toggles/s. In a fuller sequence: 8,589 inserts; then three runs of 9,248 / 3,604 / 3,330 inserts and 21,382 / 21,336 / 17,528 toggles. Against the plain `FULL` of 7.1 in a slow-disk state, three interleaved pairs: inserts 2,780 / 3,038 / 3,411 against 2,085 / 2,861 / 2,889; toggles 4,279 / 4,418 / 4,063 against 3,898 / 4,434 / 4,201. Dropped: it hung one test intermittently (the thread answered and the main thread never saw the reply; I did not find out why) and needed more code than `fs.fsync`. One run with it was discarded for 137,130 non-2xx responses of 157,934 and per-list row counts 4–12 below what the harness's bookkeeping expected on five lists; I did not find the cause, the bookkeeping assumes an even spread of successes over lists so the shortfall does not prove lost writes, and the version that produced it no longer exists. The shipped version has had no error or data-check failure in the final sequence (one read and fan-out run, three write runs) or in the kill test.
- **Two syncs in flight at once**: 1,982 and 2,271 inserts/s, against 2,887 and 2,646 with one (a first pair was lost to a mistake in my script). The kernel serializes the syncs, and the second thread only added waiting.
- **`fdatasync` instead of `fsync`**: 3,205 and 3,406 inserts/s; **a checkpoint threshold of 512 MiB instead of 32**: 3,187 and 2,559; both against 6,682 and 2,825 for the unchanged code in the same session. No effect I could see over the disk's own swings.

### 7.4 What this section does and doesn't show

- It shows that durable commits do not have to stop the runtime: reads and fan-out are unchanged, and on a fast-syncing disk inserts match the non-durable ones.
- It does not show a stable number for durable inserts on this machine: the same code did 12,939 and 3,535 inserts/s depending on the disk's sync time. On a server whose disk syncs in 0.1–0.5 ms I expect less loss than shown here, but **I did not measure any other disk**.
- One run per configuration for the read and fan-out cases; three runs, interleaved, for the writes; one machine, one filesystem (btrfs on an encrypted volume).
