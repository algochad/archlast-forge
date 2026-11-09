# An API with blocking work, with and without Anvil

One Forge app (a NestJS controller, served by Tuyere) with three routes:

- `GET /http/work/inline?rounds=N`: a chain of `N` SHA-256 hashes (20,000 by default, about 8 ms of CPU) on the thread that serves requests;
- `GET /http/work/pool?rounds=N`: the same function, run by [Anvil](../../apps/docs/content/thread-pool.mdx) (`computePool`, made right in the controller file from a plain function);
- `GET /http/ping`: does nothing.

`run.sh` runs the app in a container limited to 4 CPU cores and 2 GiB of memory, loads each work route with oha at 32 connections, then loads `/ping` (4 connections) while the work route is under load, which shows what is left of the serving thread for other requests. It reports requests per second, p50 and p99, and the CPU the container used.

```sh
./run.sh        # builds the image on the first run; writes results.raw, results.json, results.md
bun ../collect.ts && bun ../docs.ts
```

`SERVER_CPUS` (0-3), `SERVER_MEM` (2g), `CLIENT_CPUS` (4-7,12-15), `ROUNDS`, `CONNS` (32), `SECS` (6), `RUNS` (3) change it. The pool has `cores − 1` threads (3 here); a bigger `ROUNDS` makes each request longer, not the pool faster.
