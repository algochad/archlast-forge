# Benchmarks

Numbers worth quoting come from the pinned containers; the host scripts are for profiling and quick A/B runs. Load generators:
`oha` (HTTP) and `bench/client` (WebSocket and SSE, `cargo build --release` inside it). The Forge RPC handler is imported from a
checkout of archlast-forge (`FORGE=<path to packages/runtime/src>`).

| script                                                                                                                      | what it does                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `container/build.sh`, `container/compare.sh`                                                                                | Bun.serve vs Tuyere in Docker: server on 4 physical cores and 2 GB, clients on other cores, CPU from the cgroup. `SECS`, `HTTP_CONNS`, `WS_CASES`, `SERVER_ENV` tune it |
| `ws-sat.sh engine conns pipeline`                                                                                           | saturated WebSocket throughput (pipelined clients) and server cores                                                                                                             |
| `http-ab.sh [conns] [rounds]`                                                                                               | alternating Bun / engine HTTP runs: req/s and CPU per request                                                                                                                   |
| `thread-split.sh`, `http-split.sh`, `static-split.sh`                                                                       | CPU per message / request, per thread (user and kernel)                                                                                                                         |
| `profile-ws.sh`                                                                                                             | samples the Rust threads with the in-engine profiler (build with `--features profile`); `fold-summary.py` reads the output                                                      |
| `servers/forge-rpc.ts`                                                                                                      | Forge's real `createRpc` handler on Bun.serve or the engine (`ENGINE=bun\|archlast`)                                                                                            |
| `servers/forge-rpc-reply.ts`, `servers/reply-vs-response.ts`, `servers/native-api.ts`                                       | what returning `Reply` instead of `Response`, and the native App API, are worth                                                                                                 |
| `servers/http-*.ts`, `static-*.ts`, `stream-*.ts`, `bun-*.ts`, `elysia-*.ts`, `sweep*.sh`, `cpu-*.sh`, `threads-at-rate.sh` | the original Bun / Elysia / engine comparison sweeps                                                                                                                            |

Notes: `perf`, `strace` and ptrace attach may be blocked on a host (the in-engine profiler and `/proc` per-thread counters
need neither). Client load needs `WS_PIPELINE=k` messages in flight per connection to saturate a server; a strict
request/response client leaves both servers idle half the time.
