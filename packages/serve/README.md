# archlast-serve

A **Bun-only** HTTP / SSE / WebSocket server whose I/O core is Rust (axum + hyper + tokio) and whose handlers
run on **several Bun threads** at once. Two interchangeable native backends load the same Rust core:

| backend | how Bun loads it |
|---|---|
| `napi` | Node-API addon (`.node`), supported by Bun |
| `bun-ffi` | plain C ABI through `bun:ffi` |

```ts
import { App, sse } from "archlast-serve";

const app = new App()
  .get("/", "hello")                                   // constant: answered by Rust, never enters JS
  .get("/json", { ok: true, n: 42 })                   // constant
  .get("/user/:id", (c) => ({ id: c.params.id, q: c.query }))
  .post("/echo", async (c) => c.body)
  .get("/events", () => sse((s) => {                   // Server-Sent Events
    const t = setInterval(() => s.send({ now: Date.now() }, { event: "tick" }), 1000);
    return () => clearInterval(t);                     // runs when the client disconnects
  }))
  .ws("/chat", {                                       // WebSocket
    open: (ws) => ws.subscribe("room"),
    message: (ws, m) => ws.publish("room", m),         // fan-out happens in Rust, across threads
  });

const server = app.listen({ port: 3000, workers: 4 }); // 4 JS threads sharing one listener
```

`serve({ routes, ws, fetch })` offers a `Bun.serve`-shaped alternative, and `archlast-serve/compat` exports `serveCompat`, a
full `Bun.serve`-shaped facade (`fetch`, `routes`, `error`, `websocket`, `reload`, TLS, HTML bundles).

## How it works

Sockets, HTTP, TLS, WebSocket framing and pub/sub run on Rust threads (hyper, tokio, rustls, and uWebSockets' WebSocket
protocol layer); your handlers run in JavaScript on Bun's thread. The two sides exchange batches of events and replies through
shared buffers, one native call per batch. Read [ARCHITECTURE.md](ARCHITECTURE.md) for the diagrams, the request and message
paths, the wire protocol and the reasons behind each choice.

* `workers: n` re-runs the main script in `n-1` `Worker`s; each `listen()` call there attaches to the same Rust server
  instead of starting a new one. Code outside `listen` therefore runs once per thread, and in-memory state is per thread (use
  WebSocket topics, a database, or `SharedArrayBuffer` to share).
* Constant routes (`.get("/", "hello")`) and WebSocket pub/sub never touch JS at all.
* A worker that dies is taken out of rotation; the others keep serving.

## Options (`listen` / `serve`)

| option | default | |
|---|---|---|
| `port`, `hostname` | 3000, `0.0.0.0` | `port: 0` picks a free port (see `server.port`) |
| `workers` | 1 | JS threads running handlers |
| `threads` | 2 | Rust I/O threads, one single-threaded runtime each. 2 is cheapest per request; raise for peak throughput (4: ~590k req/s, 6 + 2 JS workers: ~750k) |
| `backend` | `napi` | `"napi"` or `"bun-ffi"`; env `ARCHLAST_BACKEND` overrides |
| `entry` | `Bun.main` | script the workers re-run |
| `maxRequestBodySize` | 128 MiB | larger bodies get a 413 |
| `spinMicros` | 30 | latency mode: after work, poll this long (JS thread between event-loop turns, I/O threads between non-blocking socket polls) before sleeping. A lone request/response pair skips the sleep/wake cycles: in the container, single-connection WebSocket goes 48k to 78k msg/s (Bun 81k; p50 20 to 12 µs) and HTTP 24k to 34k req/s, at about 1.2 more cores while traffic flows. Only used while at most `spinMaxConnections` (4) connections are open; 0 turns it off |
| `tls` | off | PEM `key`/`cert` (string, Buffer or `Bun.file`), optional `ca`, `serverName` (SNI, `*.` wildcards), `requestCert` / `rejectUnauthorized` (mutual TLS); an array adds more certificates, the first is the default. Encrypted keys (`passphrase`) are rejected: decrypt to PEM first |
| `http2` | true | offer HTTP/2 (ALPN `h2`) on HTTPS connections; HTTP/1.1 clients are still served. Cleartext stays HTTP/1.1 |
| `wsPerMessageDeflate` | off | WebSocket compression (RFC 7692): `true` (each message on its own), `{ compress: "dedicated" \| "3KB"…"256KB" }` (context per socket). Messages under 64 bytes are never compressed; the `compress` argument of `send` is accepted and ignored. Incoming compressed messages are inflated with a size cap (1009) |
| `unix` | off | listen on a unix-domain socket path instead of TCP (stale socket file replaced, removed on stop) |
| `reusePort`, `ipv6Only` | false | per-thread SO_REUSEPORT sockets; IPv6-only for `::` |

## WebSocket implementation

WebSockets run on uWebSockets' protocol layer, as in Bun: `crates/core/vendor/uws/WebSocketProtocol.h` (Bun's copy of
uWebSockets, with its strict masking/RSV/opcode/close checks) parses and unmasks frames in place and formats outgoing ones,
and `WebSocketHandshake.h` makes the accept key. They are compiled through a small C++ shim (no libstdc++ needed) and driven
by `wsconn.rs`, one tokio task per connection that follows Bun's `WebSocketContext`: fragments are gathered, compressed
messages inflated, text checked for UTF-8, pings answered automatically, close handled to completion, and everything a pass
produces leaves in one write. uWebSockets' own App and sockets need their own event loop, so HTTP (hyper, TLS, HTTP/2),
accepting and timers stay on axum, hyper and tokio.

## Returning `Reply` instead of `Response`

The facade accepts the engine's own `Reply` wherever a handler returns a `Response`, and it skips the Web-object machinery
on the way out: reading a `Response` body goes through a `ReadableStream`, which the engine cannot avoid for an arbitrary
`Response` (a stream-backed one must not be consumed). Measured with Forge's real RPC handler on the engine, replacing
`new Response(json, init)` with `new Reply(json, init)` takes HTTP from 104k to 140k req/s and from 12.7 to 9.9 µs of CPU
per request (Bun.serve: 88k, 9.4 µs). A handler that can name its answer as a string or bytes plus status and headers should
return `Reply`; `bench/servers/forge-rpc-reply.ts` shows the substitution. The native `App` API, which also skips the Web
`Request`, reaches 304k req/s at 6.7 µs for a trivial handler (`bench/servers/native-api.ts`).

## Benchmarks (Forge's RPC handler, pinned containers)

`bench/container/build.sh` builds an image with Bun, the native libraries, Forge's `createRpc` handler and the load tools;
`bench/container/compare.sh` runs the server in a container on 4 physical cores (`--cpuset-cpus=0-3 --memory=2g`) and the
load generators (`oha`, and `bench/client` for WebSocket) in another on separate cores. Server CPU comes from the cgroup.
Forge's handler alone costs about 0.55 µs per WebSocket message and 2.4 µs per HTTP request on one JS thread, so those
are the ceilings for any engine that keeps the handler on one thread.

| case | Bun.serve | archlast-serve |
|---|---|---|
| HTTP c=64 | 91k req/s, 0.83 cores | **110k**, 1.36 cores |
| HTTP c=16 | 91k | **103k** |
| HTTP c=256 | 88k | **103k** |
| HTTP c=1 | **40k** | 34k |
| WebSocket c=16 (request/response) | 201k msg/s, 0.71 cores | **310k**, 1.59 cores |
| WebSocket c=512, 32 pipelined | 820k, 0.95 cores | **949k**, 1.73 cores |
| WebSocket c=256, 16 pipelined | 742k | 744k (level) |
| WebSocket c=1 | 81k, p50 12 µs | 78k, p50 12 µs (level) |

Where it wins, it wins on throughput of the single JS thread, with I/O on other cores. It costs more total CPU per request
(WebSocket about 1.3 to 1.5 times Bun's at saturation, HTTP about 1.4 times with Web `Request`/`Response` objects and about
equal when the handler returns `Reply`, see above). At one connection the latency mode (`spinMicros`, on by default while at
most 4 connections are open) matches Bun's round trip by polling instead of sleeping, at about 1.9 cores; with more
connections it switches itself off. Reproduce with
`SECS=6 bench/container/compare.sh`; `bench/ws-sat.sh`, `bench/http-split.sh` and `bench/thread-split.sh` give per-thread
CPU on the host, and `--features profile` builds a sampling profiler (`ARCHLAST_PROFILE=file:seconds`).

## Layout

* `crates/core` — the hyper/tokio server, lanes, streaming, WebSockets (uWebSockets framing), pub/sub
* `crates/ffi`, `crates/napi` — the two thin bindings
* `src/` — TypeScript: `index.ts` (API), `runtime.ts` (per-thread engine), `server.ts` (threads), `codec.ts` (wire formats)
* `test/` — `bun test` (both backends); `bench/` — load tests and the container comparison ([bench/README.md](bench/README.md))

Build: `./build.sh` (Linux). Test: `bun test`. Typecheck: `bun run typecheck`. Lint: `cargo clippy --release`.

## Limits

Linux only · HTTP/2 only over TLS (no h2c, no WebSocket over HTTP/2) · encrypted private keys (`passphrase`) and `{dir}`
directory routes are not supported · HTML-bundle routes and `development` exist in the `serveCompat` facade only, and give
stylesheet swaps and state-keeping reloads, not module-level hot swap · the facade runs handlers on one JS thread (`App` can use `workers` for stateless
handlers) · static routes take strings, objects, bytes or `Reply` (the facade also takes `Response` and `Bun.file`).

## Tuning / debugging knobs (environment)

| variable | default | |
|---|---|---|
| `ARCHLAST_BACKEND` | `napi` | `napi` or `bun-ffi` |
| `ARCHLAST_SPIN_US` | 30 | default for `spinMicros` (latency mode); 0 turns it off |
| `ARCHLAST_RCVBUF` | 1048576 | receive buffer of listening sockets; 0 leaves it to the kernel |
| `ARCHLAST_PROFILE` | off | `file:seconds`: sample the Rust threads (needs a build with `--features profile`) |
| `ARCHLAST_REUSEPORT` | off | `1` gives each I/O thread its own SO_REUSEPORT socket (then other SO_REUSEPORT servers can share the port) |
| `ARCHLAST_BACKLOG` | 8 | wake another JS thread when more than this many requests wait per awake thread |
| `ARCHLAST_STATS` | off | `1` prints per-thread batch statistics every 2 s |
