# Database adapters side by side

One workload through the engine's own `Executor` and `DocStore` on SQLite, Postgres and MongoDB: the same data (200,000 todos, 120,000
comments and 50,000 notes at `SCALE=1`), the same operations, so only the database changes. `ctx.db` reads (get, indexes, paging, filters, joins,
aggregates), writes (one document and in bulk), and throughput with many callers at once.

```bash
docker compose up -d --wait postgres mongo       # Postgres 17 on :55432, MongoDB 7 (a replica set of one) on :57017
bun benchmarks/db-adapters/run-all.sh             # SQLite (read cache on and off), Postgres (defaults, then tuned), MongoDB -> results/*.json
bun benchmarks/db-adapters/compare.ts             # the table below
DB=postgres POOL=16 SCALE=1 SECONDS=5 ONLY=throughput bun benchmarks/db-adapters/bench.ts   # one adapter, some lines
```

## Results

4 vCPU Xeon, 16 GB, Bun 1.4.4, Postgres 17 and MongoDB 7 in Docker **on the same four cores** (so the server and Bun compete), `SCALE=0.5` (190,000 documents),
3 s per throughput line, latency lines p50 in ms, one run each. Run-to-run swings of 20–30% are the machine.

| operation | sqlite | sqlite-nocache | postgres-default | postgres-tuned | mongodb |
|---|---:|---:|---:|---:|---:|
| seed (docs/s) (per second) | 58,943 | 36,896 | 28,869 | 21,979 | 33,285 |
| read: get(id) (p50 ms) | 0.02 | 0.02 | 0.17 | 0.23 | 0.89 |
| read: getMany(50) (p50 ms) | 0.26 | 0.21 | 0.86 | 0.90 | 1.69 |
| read: withIndex.take(100) (p50 ms) | 0.05 | 0.09 | 0.38 | 0.66 | 1.57 |
| read: withIndex.collect() 2000 docs (p50 ms) | 0.74 | 1.37 | 4.13 | 5.26 | 12.0 |
| read: paginate(100) (p50 ms) | 0.05 | 0.09 | 0.38 | 0.62 | 1.42 |
| read: count() 2000 docs (p50 ms) | 0.01 | 0.13 | 0.81 | 0.89 | 1.70 |
| read: where(eq done).collect() (p50 ms) | 0.30 | 0.68 | 1.84 | 1.78 | 5.22 |
| read: filter(done).collect() (p50 ms) | 0.99 | 1.88 | 6.34 | 5.45 | 15.5 |
| read: orderBy(title).take(100) (p50 ms) | 0.08 | 1.99 | 4.47 | 4.32 | 5.43 |
| read: select(['title']).collect() (p50 ms) | 1.08 | 1.65 | 4.51 | 4.93 | 12.2 |
| join: include forward (list) x100 (p50 ms) | 0.07 | 0.11 | 0.84 | 1.23 | 3.89 |
| join: include reverse all x100 (p50 ms) | 0.37 | 0.77 | 14.1 | 6.06 | 8.49 |
| join: include reverse take:2 x100 (p50 ms) | 1.00 | 1.25 | 2.73 | 3.25 | 12.9 |
| join: include reverse count x100 (p50 ms) | 0.17 | 0.58 | 2.52 | 3.34 | 5.65 |
| agg: sum(n) notes (p50 ms) | 0.02 | 10.1 | 55.9 | 55.9 | 91.1 |
| agg: avg(n) notes (p50 ms) | 0.01 | 9.89 | 56.9 | 60.7 | 91.5 |
| agg: min/max(n) notes (p50 ms) | 0.03 | 20.8 | 113.4 | 119.4 | 180.7 |
| write: insert 1 (p50 ms) | 0.10 | 0.07 | 1.13 | 1.21 | 2.28 |
| write: patch 1 (p50 ms) | 0.07 | 0.05 | 1.33 | 1.17 | 3.00 |
| write: patch 1 (indexed field) (p50 ms) | 0.05 | 0.04 | 1.18 | 1.07 | 2.63 |
| write: delete 1 (p50 ms) | 0.05 | 0.04 | 1.14 | 1.04 | 3.01 |
| write: insertMany 100 (p50 ms) | 3.96 | 4.20 | 5.68 | 5.96 | 5.38 |
| write: insertMany 1000 (p50 ms) | 85.5 | 52.6 | 35.9 | 40.2 | 35.6 |
| write: updateMany 100 (p50 ms) | 8.90 | 9.30 | 9.90 | 9.48 | 7.95 |
| throughput: get(id), 64 concurrent (per second) | 57,348 | 110,344 | 49,300 | 41,974 | 14,813 |
| throughput: take(100), 32 concurrent (per second) | 15,396 | 10,217 | 7,637 | 7,061 | 1,332 |
| throughput: patch 1, 32 concurrent (per second) | 19,072 | 16,875 | 4,171 | 3,748 | 1,510 |
| throughput: insert 1, 32 concurrent (per second) | 7,647 | 7,509 | 5,983 | 5,410 | 2,300 |
| throughput: 90% read / 10% write, 64 concurrent (per second) | 31,613 | 39,664 | 23,528 | 19,651 | 6,540 |

sqlite: 190,000 documents; sqlite-nocache: 190,000 documents; postgres-default: 190,000 documents; postgres-tuned: 190,000 documents; mongodb: 190,000 documents

- **SQLite is in-process**, which is most of its lead. "sqlite" has the exact read cache (repeated reads are cache hits, which is why its counts and
  aggregates read 0.01–0.03 ms); "sqlite-nocache" is the database itself. The cache also halves random `get` throughput (57,000 against 110,000 a
  second): every miss stores an entry.
- **Postgres tuned** is `shared_buffers=1GB`, `effective_cache_size=4GB`, `random_page_cost=1.1`, `jit=off`, `wal_compression=on`, `max_connections=200`.
  It did not help this workload (the data fits in the default cache and the box is CPU-bound); `synchronous_commit=off` is the setting that moves writes
  (+30–38% in a separate test), and it trades durability, so it is not in either column.
- **One anomaly:** the first Postgres-default run measured `take(100)`, `paginate` and the three `include` lines at 33–47 ms. Two reruns with the same
  settings gave 0.4–0.8 ms and 3–14 ms. I could not reproduce it or find the cause (statistics taken mid-load is the suspect); the table is the rerun.
- **MongoDB is slowest everywhere** because of the driver: about 150 µs of JavaScript an operation, 64 gets at once use 1.4 cores. It does well at
  bulk writes (`insertMany`, `updateMany`). Its writes are snapshot isolation, not serializable.
- **Group commit is SQLite's** (19,000 patches a second on 32 callers). Postgres and MongoDB scale writes with connections: see `docs/decisions.md#database-adapters-postgres-and-mongodb`.
