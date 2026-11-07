import { type Backend, type LaneBinding } from "./backend.ts";
import {
  type EventSink,
  type RawRequest,
  type SignalHost,
  decodeEvents,
} from "./codec.ts";
import { CT_TEXT, Responder } from "./responder.ts";
import { Stream, type StreamHost } from "./stream.ts";
import { Context } from "./router.ts";
import { type Dispatch, Reply, type Result } from "./server.ts";
import { bodyless, inferContentType } from "./mime.ts";
import {
  UpgradeReply,
  WebSocket,
  type WsHandlers,
  type WsHost,
  convertBinary,
} from "./websocket.ts";

/** Empty polls before a lane parks (each is a cheap in-process call), and the longest uninterrupted busy spell. */
const SPIN = Number(process.env.ARCHLAST_SPIN ?? 0); // empty polls inside the pump before parking (starves this thread's event loop: leave at 0)
const MAX_BUSY_MS = 4;
/** A fetch-style Response body bigger than this is streamed instead of buffered. */
const STREAM_THRESHOLD = 1 << 20;
const STATS = process.env.ARCHLAST_STATS === "1";

export interface AppHandlers {
  dispatch: Dispatch;
}

/**
 * The per-thread engine: pulls events for one lane out of Rust, runs handlers, and sends commands back
 * in batches. One instance per JS thread (the main thread is lane 0, workers are lanes 1..n).
 */
export class LaneRuntime implements StreamHost, WsHost, SignalHost {
  readonly lane: number;
  readonly softLimit: number;
  readonly publishToSelf: boolean;
  private backend: Backend;
  private serverId: number;
  private binding: LaneBinding | null = null;
  private inbox = new Uint8Array(256 * 1024);
  private rs = new Responder(64 * 1024);
  private stopped = false;
  private flushQueued = false;
  private streams = new Map<number, Stream>();
  private signals = new Map<number, AbortController>();
  private abortedIds = new Set<number>();
  /** Streamed request bodies still arriving, by request id. */
  private bodies = new Map<
    number,
    {
      c: ReadableStreamDefaultController<Uint8Array> | null;
      unacked: number;
      done: boolean;
    }
  >();
  /** Streamed requests whose body passed the size limit: they are answered 413 whatever the handler does. */
  private tooLarge = new Set<number>();
  /** Accepted upgrades waiting for their ws-open event, by upgrade request id. */
  private pendingUpgrades = new Map<number, UpgradeReply>();
  private sockets = new Map<
    number,
    { ws: WebSocket<any>; h: WsHandlers<any> }
  >();
  private app: AppHandlers;
  private onError: (err: unknown) => void;
  private keepAlive: ReturnType<typeof setInterval>;
  /** Debug counters, printed every 2 s when ARCHLAST_STATS=1. */
  private stats = { pumps: 0, events: 0, commands: 0 };

  constructor(
    backend: Backend,
    serverId: number,
    lane: number,
    app: AppHandlers,
    onError: (err: unknown) => void,
    wsOpts: {
      softLimit: number;
      publishToSelf: boolean;
      spinMicros?: number;
      spinMaxConnections?: number;
    } = { softLimit: 0, publishToSelf: false },
  ) {
    this.backend = backend;
    this.serverId = serverId;
    this.softLimit = wsOpts.softLimit;
    this.publishToSelf = wsOpts.publishToSelf;
    this.spinUs = wsOpts.spinMicros ?? 0;
    this.spinMaxConns = wsOpts.spinMaxConnections ?? 4;
    this.lane = lane;
    this.app = app;
    this.onError = onError;
    this.binding = backend.attach(serverId, lane, this.pump);
    queueMicrotask(this.pump); // pick up anything queued before this lane attached
    // Native threads hold no handle on the Bun event loop, so keep it alive explicitly (like Bun.serve).
    this.keepAlive = setInterval(() => {}, 0x7fffffff);
    if (STATS) {
      let last = { pumps: 0, events: 0, commands: 0 };
      setInterval(() => {
        const s = this.stats;
        const d = {
          pumps: s.pumps - last.pumps,
          events: s.events - last.events,
          commands: s.commands - last.commands,
        };
        last = { ...s };
        if (d.events > 0)
          console.error(
            `[lane ${this.lane}] pumps/s=${d.pumps / 2} events/s=${d.events / 2} avg-batch=${(d.events / Math.max(1, d.pumps)).toFixed(1)} flushes/s=${d.commands / 2}`,
          );
      }, 2000).unref();
    }
  }

  ref(): void {
    this.keepAlive.ref();
  }
  unref(): void {
    this.keepAlive.unref();
  }

  /**
   * Ends every open WebSocket the way Bun's `stop(true)` does: the `close` handler runs (code 1001, "Server closed") and
   * the socket is marked closed, then the connections are dropped by `stop`.
   */
  closeSocketsAbruptly(): void {
    for (const [id, s] of [...this.sockets]) {
      this.sockets.delete(id);
      s.ws.closed = true;
      if (s.h.close)
        this.guardWs(s.ws, s.h, () => s.h.close!(s.ws, 1001, "Server closed"));
    }
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    clearInterval(this.keepAlive);
    for (const s of this.streams.values()) s._closed();
    this.streams.clear();
    this.sockets.clear();
    this.binding?.detach();
  }

  // ---------- inbound ----------

  private sink: EventSink = {
    request: (r) => {
      r.host = this;
      if (r.bodyStreamed) this.attachBody(r);
      this.run(r);
    },
    bodyChunk: (id, data) => {
      const e = this.bodies.get(id);
      if (!e || e.done) return;
      e.unacked += data.length;
      e.c!.enqueue(data);
    },
    bodyEnd: (id) => {
      const e = this.bodies.get(id);
      if (!e) return;
      e.done = true;
      this.bodies.delete(id);
      e.c!.close();
    },
    bodyError: (id) => {
      const e = this.bodies.get(id);
      if (!e) return;
      e.done = true;
      this.bodies.delete(id);
      e.c!.error(
        new Error(
          "the request body failed: the client disconnected or the body exceeded the size limit",
        ),
      );
    },
    bodyTooLarge: (id) => {
      // Like Bun.serve: whatever the handler makes of the failed read, the client gets a 413.
      if (this.tooLarge.size > 4096) this.tooLarge.clear();
      this.tooLarge.add(id);
      const e = this.bodies.get(id);
      if (!e) return;
      e.done = true;
      this.bodies.delete(id);
      e.c!.error(new Error("the request body exceeded the size limit"));
    },
    wsOpen: (id, r) => this.wsOpen(id, r),
    wsMessage: (id, binary, data) => this.wsMessage(id, data),
    wsClose: (id, code, reason) => this.wsClosed(id, code, reason),
    wsPing: (id, data) => this.wsControl(id, "ping", data),
    wsPong: (id, data) => this.wsControl(id, "pong", data),
    wsDrain: (id) => this.wsControl(id, "drain"),
    aborted: (id) => {
      const c = this.signals.get(id);
      if (c) {
        this.signals.delete(id);
        c.abort();
        if (this.abortedIds.size > 4096) this.abortedIds.clear();
        this.abortedIds.add(id); // a later read of `signal` must see it aborted, not make a fresh live one
      } else {
        if (this.abortedIds.size > 4096) this.abortedIds.clear(); // bounded: only matters for late `signal` reads
        this.abortedIds.add(id);
      }
    },
    streamAck: (id, bytes) => this.streams.get(id)?._ack(bytes),
    streamClosed: (id) => {
      this.streams.get(id)?._closed();
      this.streams.delete(id);
    },
  };

  /**
   * Runs when the native side wakes this lane. While requests keep arriving it stays in this loop: Rust sends
   * no further wake-ups until we `park`, so a busy lane pays for one notification per burst, not per request.
   * After a short idle spin it parks (race-free: park re-checks the queue under the lane lock).
   */
  private lastWork = 0;
  /** Latency mode: poll this many microseconds after work before parking (see ListenOptions.spinMicros). */
  private readonly spinUs: number;
  private readonly spinMaxConns: number;
  /** Whether few enough connections are open for latency mode; re-read at most every 20 ms (it is a native call). */
  private spinConnsOk = true;
  private spinCheckedAt = 0;

  private spinAllowed(now: number): boolean {
    if (now - this.spinCheckedAt > 20) {
      this.spinCheckedAt = now;
      this.spinConnsOk =
        this.backend.openConnections(this.serverId) <= this.spinMaxConns;
    }
    return this.spinConnsOk;
  }

  private pump = (): void => {
    const binding = this.binding;
    if (this.stopped || binding === null) return;
    const started = performance.now();
    let idle = 0;
    for (;;) {
      const n = binding.drain(this.inbox);
      if (n < 0) {
        this.inbox = new Uint8Array(Math.max(-n, this.inbox.length * 2)); // one event outgrew the inbox
        continue;
      }
      if (n > 0) {
        if (STATS) {
          this.stats.pumps++;
          this.stats.events += new DataView(
            this.inbox.buffer,
            this.inbox.byteOffset,
          ).getUint32(0, true);
        }
        // Requests keep views into the batch, so they get their own copy (one per batch, not per request).
        decodeEvents(this.inbox, n, this.sink, true);
        if (this.spinUs > 0) this.lastWork = performance.now();
        this.flush();
        if (this.stopped) return;
        idle = 0;
        // Give timers and I/O on this thread a turn; the immediate keeps the lane awake (no wake-ups meanwhile).
        if (performance.now() - started > MAX_BUSY_MS) {
          setImmediate(this.pump);
          return;
        }
        continue;
      }
      if (++idle < SPIN) continue;
      if (
        this.spinUs > 0 &&
        performance.now() - this.lastWork < this.spinUs / 1000 &&
        this.spinAllowed(performance.now())
      ) {
        // Poll again after the event loop has had a turn (timers, immediates and I/O on this thread are not starved).
        setImmediate(this.pump);
        return;
      }
      if (binding.park()) {
        idle = 0;
        continue;
      }
      return;
    }
  };

  /** Gives a request whose body is larger than the inline limit a stream for the rest of it. */
  private attachBody(r: RawRequest): void {
    const id = r.id;
    const entry: {
      c: ReadableStreamDefaultController<Uint8Array> | null;
      unacked: number;
      done: boolean;
    } = { c: null, unacked: 0, done: false };
    const first = r.body?.slice();
    r.bodyStream = new ReadableStream<Uint8Array>(
      {
        start: (c) => {
          entry.c = c;
          if (first) c.enqueue(first);
        },
        // The consumer wants more: tell Rust it may send what we have already taken in.
        pull: () => {
          if (entry.unacked > 0 && !this.stopped) {
            this.bodyCommand(14, id, entry.unacked);
            entry.unacked = 0;
          }
        },
        cancel: () => {
          if (entry.done) return;
          entry.done = true;
          this.bodies.delete(id);
          if (!this.stopped) this.bodyCommand(15, id);
        },
      },
      new ByteLengthQueuingStrategy({ highWaterMark: 1 << 20 }),
    );
    this.bodies.set(id, entry);
  }

  private bodyCommand(kind: 14 | 15, id: number, n = 0): void {
    const w = this.rs.out;
    w.u8(kind);
    w.u32(id);
    if (kind === 14) w.u32(n);
    this.rs.count++;
    this.scheduleFlush();
  }

  timeout(id: number, seconds: number): void {
    if (this.stopped) return;
    const w = this.rs.out;
    w.u8(11);
    w.u32(id);
    w.u16(Math.min(65535, Math.max(0, Math.floor(seconds))));
    this.rs.count++;
    this.scheduleFlush();
  }

  signalFor(id: number): AbortSignal {
    if (this.abortedIds.has(id)) return AbortSignal.abort();
    let c = this.signals.get(id);
    if (!c) this.signals.set(id, (c = new AbortController()));
    return c.signal;
  }

  private run(req: RawRequest): void {
    let r: Result | Promise<Result>;
    try {
      r = this.app.dispatch(req);
    } catch (e) {
      this.fail(req.id, e);
      return;
    }
    if (r instanceof Promise) {
      r.then(
        (v) => this.settle(req.id, v),
        (e) => this.fail(req.id, e),
      );
    } else {
      this.settle(req.id, r, true);
    }
  }

  /** Writes a result; `inBatch` means the caller flushes afterwards. */
  private settle(id: number, v: Result, inBatch = false): void {
    if (this.stopped) return;
    if (this.tooLarge.size > 0 && this.tooLarge.delete(id))
      v = new Reply("Payload Too Large", { status: 413 });
    if (this.signals.size > 0) this.signals.delete(id);
    if (this.bodies.size > 0) this.bodies.delete(id); // answered: Rust stops reading the rest of the body by itself
    try {
      if (v instanceof Response) {
        this.writeFetchResponse(id, v).catch((e) => this.fail(id, e));
        return;
      }
      if (v instanceof UpgradeReply) {
        this.putUpgrade(id, v);
      } else if (v instanceof Stream) {
        this.startStream(id, v);
      } else {
        this.rs.writeResult(id, v);
      }
    } catch (e) {
      this.fail(id, e);
      return;
    }
    if (!inBatch) this.scheduleFlush();
  }

  private fail(id: number, err: unknown): void {
    if (this.stopped) return;
    if (this.tooLarge.size > 0 && this.tooLarge.delete(id)) {
      this.rs.put(id, 413, CT_TEXT, null, "Payload Too Large");
      this.scheduleFlush();
      return;
    }
    try {
      this.onError(err);
    } catch {}
    this.rs.put(id, 500, CT_TEXT, null, "Internal Server Error");
    this.scheduleFlush();
  }

  // ---------- responses ----------

  private async writeFetchResponse(id: number, res: Response): Promise<void> {
    if (res.body === null) {
      this.finishFetchH(id, res);
      return;
    }
    // A finished body is available immediately; a producer that is still working is not. Read while data is ready
    // right now: if the body ends, send it whole (with a length); otherwise switch to streaming.
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    const eventStream =
      res.headers.get("content-type")?.startsWith("text/event-stream") === true;
    let streaming = eventStream;
    // The read that loses the race below stays pending and will receive the next chunk: it must be kept and used
    // first, or that chunk is lost.
    type ReadResult = ReadableStreamReadResult<Uint8Array>;
    let pending: Promise<ReadResult> | null = null;
    let ended = false;
    while (!streaming) {
      pending ??= reader.read() as Promise<ReadResult>;
      // An in-memory body (string, bytes, JSON) has its chunk, and its end, ready at once or after one microtask
      // turn: look without waiting. Only a producer that is really still working takes the slower race below.
      let ready = Bun.peek(pending) as ReadResult | Promise<ReadResult>;
      if (ready instanceof Promise) {
        await null;
        ready = Bun.peek(pending) as ReadResult | Promise<ReadResult>;
      }
      const next: ReadResult | "later" =
        ready instanceof Promise
          ? await Promise.race([
              pending,
              new Promise<"later">((r) => setImmediate(() => r("later"))),
            ])
          : (ready as ReadResult);
      if (next === "later") streaming = true;
      else {
        pending = null;
        if (next.done) {
          ended = true;
          break;
        }
        chunks.push(next.value);
        size += next.value.length;
        if (size > STREAM_THRESHOLD) streaming = true;
      }
    }
    if (!streaming) {
      this.finishFetchH(
        id,
        res,
        chunks.length === 1 ? chunks[0] : Buffer.concat(chunks),
      );
      return;
    }
    void ended;
    const headers: [string, string][] = [];
    res.headers.forEach((value, key) => headers.push([key, value]));
    const s = new Stream({ status: res.status, headers });
    for (const c of chunks) s.write(c);
    this.startStream(id, s);
    this.scheduleFlush();
    s.onClose(() => void reader.cancel().catch(() => {}));
    try {
      for (
        let r = await (pending ?? reader.read());
        !r.done;
        r = await reader.read()
      ) {
        if (!s.write(r.value)) break;
        await s.drained(); // a client that reads slowly holds the producer back instead of filling memory
      }
      s.end();
    } catch {
      s.error(); // the producer failed: break the connection instead of ending the body cleanly
    }
  }

  /** Sends a buffered fetch-style response: headers are encoded straight from the `Headers` object. */
  private finishFetchH(
    id: number,
    res: Response,
    body: Uint8Array | null = null,
  ): void {
    if (this.stopped) return;
    this.rs.putFetched(
      id,
      res.status,
      res.headers,
      body,
      bodyless(res.status) ? null : inferContentType,
    );
    this.scheduleFlush();
  }

  private putUpgrade(id: number, up: UpgradeReply): void {
    const w = this.rs.out;
    w.u8(13);
    w.u32(id);
    const hcAt = w.pos;
    w.u16(0);
    w.setU16(hcAt, this.rs.writeHeaders(null, up.headers));
    w.str16(up.protocol);
    this.rs.count++;
    if (this.pendingUpgrades.size > 10_000) this.pendingUpgrades.clear(); // clients that vanished before the handshake finished
    this.pendingUpgrades.set(id, up);
  }

  // ---------- streaming (StreamHost) ----------

  private startStream(id: number, s: Stream): void {
    const w = this.rs.out;
    w.u8(2);
    w.u32(id);
    w.u16(s.status);
    const hcAt = w.pos;
    w.u16(0);
    w.setU16(hcAt, this.rs.writeHeaders(null, s.headers));
    this.rs.count++;
    this.streams.set(id, s);
    s._bind(this, id);
  }

  // Position bookkeeping for merging back-to-back chunks of one stream into a single command.
  private lastChunkId = -1;
  private lastChunkLenAt = 0;
  private lastChunkEnd = -1;

  streamChunk(id: number, chunk: string | Uint8Array): void {
    if (this.stopped) return;
    const w = this.rs.out;
    if (id === this.lastChunkId && w.pos === this.lastChunkEnd) {
      // The previous command is a chunk of this same stream: extend it instead of adding a command.
      const added =
        typeof chunk === "string"
          ? w.utf8(chunk)
          : (w.bytes(chunk), chunk.length);
      const b = w.buf,
        at = this.lastChunkLenAt;
      w.setU32(
        at,
        ((b[at] | (b[at + 1] << 8) | (b[at + 2] << 16) | (b[at + 3] << 24)) >>>
          0) +
          added,
      );
      this.lastChunkEnd = w.pos;
      return;
    }
    w.u8(3);
    w.u32(id);
    const lenAt = w.pos;
    w.u32(0);
    let len: number;
    if (typeof chunk === "string") len = w.utf8(chunk);
    else {
      w.bytes(chunk);
      len = chunk.length;
    }
    w.setU32(lenAt, len);
    this.rs.count++;
    this.lastChunkId = id;
    this.lastChunkLenAt = lenAt;
    this.lastChunkEnd = w.pos;
    this.scheduleFlush();
  }

  streamError(id: number): void {
    if (this.stopped) return;
    this.rs.out.u8(12);
    this.rs.out.u32(id);
    this.rs.count++;
    this.streams.delete(id);
    this.scheduleFlush();
  }

  streamEnd(id: number): void {
    if (this.stopped) return;
    this.rs.out.u8(4);
    this.rs.out.u32(id);
    this.rs.count++;
    this.streams.delete(id);
    this.scheduleFlush();
  }

  // ---------- WebSockets (WsHost) ----------

  private wsOpen(id: number, r: RawRequest): void {
    const up = this.pendingUpgrades.get(r.reqId);
    this.pendingUpgrades.delete(r.reqId);
    if (!up) {
      this.wsClose(id, 1008, "no handler");
      return;
    }
    const ws = new WebSocket(this, id, r.url, r.headerPairs(), up.data);
    ws.ip = r.ip;
    ws.subprotocol = up.protocol;
    const handlers = up.handlers;
    this.sockets.set(id, { ws, h: handlers });
    if (handlers.open) this.guardWs(ws, handlers, () => handlers.open!(ws));
    this.scheduleFlush();
  }

  private wsMessage(id: number, data: string | Uint8Array): void {
    const s = this.sockets.get(id);
    if (!s) return;
    if (s.h.message) {
      const msg =
        typeof data === "string" ? data : convertBinary(data, s.ws.binaryType);
      try {
        const r = s.h.message(s.ws, msg);
        if (r instanceof Promise) r.catch((e) => this.wsFail(s.ws, s.h, e));
      } catch (e) {
        this.wsFail(s.ws, s.h, e);
      }
    }
    this.scheduleFlush();
  }

  private wsControl(
    id: number,
    kind: "ping" | "pong" | "drain",
    data?: Uint8Array,
  ): void {
    const s = this.sockets.get(id);
    if (!s) return;
    if (kind === "drain") {
      if (s.h.drain) this.guardWs(s.ws, s.h, () => s.h.drain!(s.ws));
    } else if (s.h[kind] && data) {
      const buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
      this.guardWs(s.ws, s.h, () => s.h[kind]!(s.ws, buf));
    }
    this.scheduleFlush();
  }

  private wsClosed(id: number, code: number, reason: string): void {
    const s = this.sockets.get(id);
    if (!s) return;
    this.sockets.delete(id);
    s.ws.closed = true;
    if (s.h.close)
      this.guardWs(s.ws, s.h, () => s.h.close!(s.ws, code, reason));
    this.scheduleFlush();
  }

  /** Runs a socket handler; an error goes to the handlers' `error` callback, else to the engine's. */
  private guardWs(
    ws: WebSocket<any>,
    h: WsHandlers<any>,
    fn: () => unknown,
  ): void {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((e) => this.wsFail(ws, h, e));
    } catch (e) {
      this.wsFail(ws, h, e);
    }
  }

  private wsFail(ws: WebSocket<any>, h: WsHandlers<any>, e: unknown): void {
    if (h.error) {
      try {
        const r = h.error(e instanceof Error ? e : new Error(String(e)), ws);
        if (r instanceof Promise) r.catch((e2) => this.onError(e2));
      } catch (e2) {
        this.onError(e2);
      }
    } else this.onError(e);
  }

  /** Runs a user callback so that neither a throw nor a rejection can break the batch being processed. */
  private guard(fn: () => unknown): void {
    try {
      const r = fn();
      if (r instanceof Promise) r.catch((e) => this.onError(e));
    } catch (e) {
      this.onError(e);
    }
  }

  private dirtySockets: { localPending: number }[] = [];

  markDirty(ws: { localPending: number }): void {
    this.dirtySockets.push(ws);
  }

  wsBuffered(id: number): number {
    return this.backend.wsBuffered(this.serverId, id);
  }

  private wsFrameCommand(kind: 16 | 17, id: number, data: Uint8Array): void {
    if (this.stopped) return;
    const w = this.rs.out;
    w.u8(kind);
    w.u32(id);
    w.u32(data.length);
    w.bytes(data);
    this.rs.count++;
    this.scheduleFlush();
  }
  wsPing(id: number, data: Uint8Array): void {
    this.wsFrameCommand(16, id, data);
  }
  wsPong(id: number, data: Uint8Array): void {
    this.wsFrameCommand(17, id, data);
  }
  private wsSimpleCommand(kind: 18 | 19 | 20, id: number): void {
    if (this.stopped) return;
    this.rs.out.u8(kind);
    this.rs.out.u32(id);
    this.rs.count++;
    this.scheduleFlush();
  }
  wsTerminate(id: number): void {
    this.wsSimpleCommand(18, id);
  }
  wsPause(id: number): void {
    this.wsSimpleCommand(19, id);
  }
  wsResume(id: number): void {
    this.wsSimpleCommand(20, id);
  }

  /** Queues a message; returns its length in bytes. */
  wsSend(id: number, data: string | Uint8Array): number {
    if (this.stopped) return 0;
    const w = this.rs.out;
    w.u8(5);
    w.u32(id);
    w.u8(typeof data === "string" ? 0 : 1);
    const lenAt = w.pos;
    w.u32(0);
    let len: number;
    if (typeof data === "string") len = w.utf8(data);
    else {
      w.bytes(data);
      len = data.length;
    }
    w.setU32(lenAt, len);
    this.rs.count++;
    this.scheduleFlush();
    return len;
  }

  wsClose(id: number, code: number, reason: string): void {
    if (this.stopped) return;
    const w = this.rs.out;
    w.u8(6);
    w.u32(id);
    w.u16(code);
    w.str16(reason);
    this.rs.count++;
    this.scheduleFlush();
  }

  wsSubscribe(id: number, topic: string): void {
    this.topicCommand(7, id, topic);
  }

  wsUnsubscribe(id: number, topic: string): void {
    this.topicCommand(8, id, topic);
  }

  private topicCommand(kind: number, id: number, topic: string): void {
    if (this.stopped) return;
    this.rs.out.u8(kind);
    this.rs.out.u32(id);
    this.rs.out.str16(topic);
    this.rs.count++;
    this.scheduleFlush();
  }

  publish(topic: string, data: string | Uint8Array, excludeId = 0): void {
    if (this.stopped) return;
    const w = this.rs.out;
    w.u8(9);
    w.str16(topic);
    w.u8(typeof data === "string" ? 0 : 1);
    const lenAt = w.pos;
    w.u32(0);
    let len: number;
    if (typeof data === "string") len = w.utf8(data);
    else {
      w.bytes(data);
      len = data.length;
    }
    w.setU32(lenAt, len);
    w.u32(excludeId);
    this.rs.count++;
    this.scheduleFlush();
  }

  // ---------- outbound batching ----------

  private scheduleFlush(): void {
    if (this.flushQueued) return;
    this.flushQueued = true;
    queueMicrotask(() => {
      this.flushQueued = false;
      this.flush();
    });
  }

  private flush(): void {
    if (this.rs.count === 0 || this.stopped) return;
    const w = this.rs.out;
    w.setU32(0, this.rs.count);
    if (STATS) this.stats.commands++;
    try {
      this.binding!.command(w.buf, w.pos);
    } catch (e) {
      // A malformed batch must not take the process down (it would surface from a microtask): drop it, report it.
      this.onError(e);
    }
    if (this.dirtySockets.length > 0) {
      for (const d of this.dirtySockets) d.localPending = 0; // the engine knows about those bytes now
      this.dirtySockets.length = 0;
    }
    w.pos = 4;
    this.rs.count = 0;
    this.lastChunkId = -1;
  }
}
