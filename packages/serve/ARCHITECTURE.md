# archlast-serve: architecture

archlast-serve is an HTTP, SSE and WebSocket server for **Bun**. Its I/O runs in Rust, on its own threads. Your handlers run
in JavaScript on Bun's thread (or a few of them). The two sides talk through **batches in shared buffers**, not one call
per request.

The reason for the split: one JS thread can only do so much, and in Bun it also does all the socket work. Moving sockets,
HTTP parsing, TLS, WebSocket framing and pub/sub fan-out to other cores leaves the JS thread with the handler, which is the
part that cannot be moved. The cost is that every request crosses a thread boundary, so the design is mostly about making
that crossing cheap.

## 1. The big picture

```
                                clients (browsers, services)
                                            │  TCP / TLS / unix socket
                                            ▼
 ┌────────────────────────────────────────────────────────────────────────────────────────────┐
 │  RUST CORE  (crates/core)                         N I/O threads, one tokio runtime each    │
 │                                                                                            │
 │   listener ──accept──► connection task ── TLS (rustls: SNI, mTLS, ALPN h2 / http1.1)        │
 │                              │                                                              │
 │                              ├─ HTTP/1.1 and HTTP/2  ─ hyper ─►  http::handle()             │
 │                              │       static routes answered here (ETag, 304, HEAD)          │
 │                              │       files answered here (Range, validators)                │
 │                              │       everything else becomes a request record ─────────┐    │
 │                              │                                                         │    │
 │                              └─ WebSocket upgrade ─► wsconn task (one per connection)   │    │
 │                                    uWebSockets protocol layer: parse, unmask, frame     │    │
 │                                    permessage-deflate, ping/pong, close handshake       │    │
 │                                    messages for JS ────────────────────────────────┐    │    │
 │                                                                                    │    │    │
 │   ┌──────────────── shared state (Shared) ────────────────────────────────────┐    │    │    │
 │   │  global request queue ◄───────────────────────────────────────────────────┼────┼────┘    │
 │   │  per-lane event queues ◄──────────────────────────────────────────────────┼────┘         │
 │   │  scheduler: which JS lanes are awake / parked                             │              │
 │   │  socket registry, pub/sub topics, backpressure counters                   │              │
 │   │  per-I/O-thread inboxes: finished responses and WebSocket output ─────────┼──► back to   │
 │   └───────────────────────────────────────────────────────────────────────────┘    the I/O  │
 │                       ▲  drain(buf): events out              │ command(buf): replies in      │
 └───────────────────────┼──────────────────────────────────────┼─────────────────────────────┘
          two bindings: napi (Node-API) or bun:ffi — one call per BATCH
 ┌───────────────────────┼──────────────────────────────────────┼─────────────────────────────┐
 │  TYPESCRIPT LAYER  (src)                                     ▼                             │
 │                                                                                            │
 │   LaneRuntime  (one per JS thread, called a "lane")                                        │
 │     pump():  drain → decode events → run your handlers → flush replies in ONE command       │
 │     sockets · streams · request bodies · abort signals · latency-mode polling              │
 │                                                                                            │
 │   your code:   App / serve()  (native API)      or      serveCompat()  (Bun.serve-shaped)  │
 │                routes, Context, WebSocket class         fetch(), routes, error, websocket, │
 │                                                         reload, HTML bundles, dev server   │
 └────────────────────────────────────────────────────────────────────────────────────────────┘
```

Which thread does what:

| thread                                                | runs                                                                                                                   | never runs      |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- | --------------- |
| **I/O threads** (`archlast-io-N`, default 2)          | accept, TLS, HTTP parsing, WebSocket framing, file serving, static routes, pub/sub fan-out, idle timers, socket writes | your JavaScript |
| **JS lane 0** (Bun's main thread)                     | your handlers, the pump, `Request`/`Response` objects                                                                  | socket I/O      |
| **JS lanes 1..n** (`workers`, default one per two I/O threads, Bun `Worker`s) | the same script again, for stateless handlers                                                                          | socket I/O      |

A connection never changes I/O thread, and a WebSocket never changes lane. That keeps connection state single-threaded
(no locks on the hot path) and makes per-socket handler order trivial.

## 2. An HTTP request, end to end

```
 client        I/O thread (Rust)                       lane 0 (JS)                    I/O thread
   │                  │                                      │                            │
   │── request ──────►│ hyper parses                         │                            │
   │                  │ static route? ── yes ─► answer now   │                            │
   │                  │ build record: method, url, headers,  │                            │
   │                  │ small body (≤256 KiB inline)         │                            │
   │                  │ push on shared queue ───────────────►│                            │
   │                  │ (wake the lane only if it is parked) │                            │
   │                  │                                      │ pump(): drain(buf)         │
   │                  │                                      │  decode batch of requests  │
   │                  │                                      │  handler(req) ──► result   │
   │                  │                                      │  encode replies in a buffer│
   │                  │                                      │ command(buf)  (one call) ─►│
   │                  │◄──── responses, grouped per I/O thread, ONE wake per batch ─────────│
   │◄── response ─────│ write                                │                            │
```

Points that matter for speed:

- **Batching.** A busy lane loops `drain → handle all → one command`, and the I/O side sends it no wake-ups while it is
  awake. Under load the cost of the thread boundary is paid per batch, not per request.
- **Only the first wake costs.** A parked lane is woken through a coalesced thread-safe callback. The most recently parked lane is
  woken first, so light load stays on one or two hot threads.
- **Bodies.** Up to 256 KiB travel inside the request record. A bigger body arrives as chunk events with credit-based flow
  control (2 MiB window), so a slow handler pushes back on the client instead of filling memory. A body over the limit is
  answered 413.
- **Responses** are copied once into a command buffer. A stream (SSE, a `ReadableStream`) gets chunk commands and
  consumed-bytes acks back, so a slow client holds the producer back (about a 1 MiB window).
- **Latency mode.** After handling work, the JS thread and the I/O threads poll for a few microseconds (`spinMicros`, 30)
  instead of sleeping, so a lone request skips two sleep/wake cycles. It applies only while at most 4 connections are open;
  with more, threads are busy anyway.

## 3. A WebSocket message

```
 client ──frames──► wsconn task (I/O thread)                       lane (JS)
                      │ read into the thread's shared buffer
                      │ uWebSockets protocol layer: unmask in place, find frames
                      │ gather fragments · inflate if compressed · check UTF-8
                      │ ping → pong at once · close → close handshake
                      │ all messages of this read, serialized back to back ──► lane queue
                      │                                                         │ pump(): drain
                      │                                                         │  ws.message(...) in your code
                      │                                                         │  ws.send() / ws.publish() → command buffer
                      │                                          command(buf) ◄─┘
                      │◄── per-I/O-thread inbox (one wake per batch)
                      │ frame (deflate if negotiated), write everything queued in ONE write
 client ◄──frames────┘
```

- Framing is **uWebSockets' protocol layer** (Bun's copy, `crates/core/vendor/uws`), compiled through a small C++ shim.
  Everything around it — accepting, TLS, timers — stays on tokio. See `wsconn.rs` for the connection loop, which follows
  Bun's `WebSocketContext`.
- **Pub/sub** (`ws.subscribe`, `ws.publish`, `server.publish`) lives in Rust: a publish is looked up and queued on every
  subscriber's I/O thread without entering JS again.
- **Backpressure.** Bytes queued per socket are counted. Past the limit the socket is closed, or (Bun's default) `send`
  returns -1 and a `drain` event follows. A paused socket is not read at all, so TCP pushes back on the sender.

## 4. The wire protocol between the two sides

Two buffers per lane, both little-endian, documented at the top of `src/codec.ts`:

- **events** (Rust → JS, filled by `drain`): `[count] event*`, each event starts with a kind byte — request, WebSocket
  open/message/close/ping/pong/drain, stream closed/ack, request-body chunk/end/error/too-large, aborted.
- **commands** (JS → Rust, sent by `command`): `[count] command*` — respond, stream start/chunk/end/error, WebSocket
  send/close/ping/pong/terminate/pause/resume, subscribe/unsubscribe/publish, file, timeout, upgrade accept, body ack/cancel.

Startup is one **options blob** (ports, TLS entries, WebSocket limits, static routes, spin settings), parsed once in
`lib.rs`. Requests that JS has not taken yet wait in Rust; a client that leaves first is dropped without any JS work.

## 5. What is where

```
crates/core/src
  tpc.rs        I/O threads, accept loop, connection tasks, idle reaper, graceful drain, TLS/unix/TCP wrappers
  http.rs       request handler: static fast path, bodies, WebSocket handshake, reply mapping, stream bodies
  state.rs      lanes, queues, scheduler, drain/command, socket registry, pub/sub, inboxes
  wsconn.rs     one WebSocket connection (uses uws.rs)        uws.rs   FFI to the uWebSockets protocol shim
  file.rs       file responses (Range, ETag, Last-Modified)   tls.rs   rustls config: SNI, wildcard, mTLS, versions
  deflate.rs    permessage-deflate negotiation + state        wire.rs  header/option readers and writers
  lib.rs        server registry, options parsing, start/attach/stop
  vendor/uws    WebSocketProtocol.h, WebSocketHandshake.h and a C++ shim (no libstdc++ needed)
crates/ffi      the C ABI for bun:ffi            crates/napi    the Node-API addon (same functions)

src
  index.ts      App, serve(), listen(), ListenOptions         router.ts   routes, Context, toWebRequest
  server.ts     MainServer / WorkerServer, Worker threads     runtime.ts  LaneRuntime: the pump and everything it drives
  codec.ts      the wire protocol                             responder.ts  reply encoding
  websocket.ts  the ServerWebSocket-like class                stream.ts   Stream and SSE with flow control
  compat.ts     Bun.serve-shaped facade                       bundle.ts   HTML bundles + dev server (Bun.build, file watch)
  tls.ts deflate.ts file.ts reply.ts mime.ts    option helpers and small response types
```

## 6. Choices and their reasons

| choice                                                  | why                                                                                                                     |
| ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Rust I/O threads, JS handlers on Bun's thread           | the handler is the part that cannot leave the JS thread; everything else can leave it                                   |
| thread-per-core, no work stealing for connections       | no cross-thread task wake-ups; connection state needs no locks                                                          |
| batches, not calls per request                          | the thread boundary is the expensive part; batching amortizes it                                                        |
| two bindings (napi and `bun:ffi`) over one Rust core    | the same code runs through either; napi is the default, `ARCHLAST_BACKEND` switches                                     |
| uWebSockets for WebSocket framing, hyper/tokio for HTTP | Bun's own WebSocket implementation is uWebSockets; hyper gives HTTP/1.1, HTTP/2 and rustls TLS                          |
| the Bun.serve-shaped facade in `compat.ts`              | lets a project that calls `Bun.serve` switch engines with little change; `Reply` skips the Web-object cost on hot paths |
| latency mode only for few connections                   | polling helps a lone client and just burns CPU when many are connected                                                  |

## 7. Limits

Linux only. HTTP/2 only over TLS (no h2c, no WebSocket over HTTP/2). The `serveCompat` facade runs handlers on one JS thread;
`App` can use `workers` for stateless handlers. HTML bundles in development swap stylesheets in place and reload on script edits (keeping fields, focus and scroll), without module-level hot swap. Hot-path cost with Web `Request` and
`Response` objects is about 1.4 times Bun's CPU per request; returning `Reply` closes most of that (see the README).
