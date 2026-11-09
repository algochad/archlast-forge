import type { HeaderInit } from "./codec.ts";
import type { Context } from "./router.ts";
import type { Reply } from "./server.ts";

/** What a lane provides to a socket. */
export interface WsHost {
  /** Queues a message and returns its size in bytes. */
  wsSend(id: number, data: string | Uint8Array): number;
  wsClose(id: number, code: number, reason: string): void;
  wsSubscribe(id: number, topic: string): void;
  wsUnsubscribe(id: number, topic: string): void;
  publish(topic: string, data: string | Uint8Array, excludeId: number): void;
  wsPing(id: number, data: Uint8Array): void;
  wsPong(id: number, data: Uint8Array): void;
  wsTerminate(id: number): void;
  wsPause(id: number): void;
  wsResume(id: number): void;
  /** Bytes queued for the socket (0 if unknown). */
  wsBuffered(id: number): number;
  /** Registers a socket whose `localPending` counter must be reset when this lane next flushes. */
  markDirty(ws: { localPending: number }): void;
  /** In non-closing backpressure mode: the limit above which `send` reports -1. 0 when slow sockets are dropped instead. */
  readonly softLimit: number;
  readonly publishToSelf: boolean;
}

export type BinaryType = "nodebuffer" | "arraybuffer" | "uint8array" | "blob";
type BufferSourceLike = ArrayBuffer | SharedArrayBuffer | ArrayBufferView;
type Sendable = string | BufferSourceLike | Blob;

function toBytes(data: string | BufferSourceLike): string | Uint8Array {
  if (typeof data === "string" || data instanceof Uint8Array) return data;
  if (
    data instanceof ArrayBuffer ||
    (typeof SharedArrayBuffer !== "undefined" &&
      data instanceof SharedArrayBuffer)
  )
    return new Uint8Array(data);
  const view = data as ArrayBufferView;
  return new Uint8Array(view.buffer, view.byteOffset, view.byteLength);
}

/** Converts a received binary frame to the type the socket's `binaryType` asks for. */
export function convertBinary(
  u8: Uint8Array,
  type: BinaryType,
): Buffer | ArrayBuffer | Uint8Array | Blob {
  switch (type) {
    case "nodebuffer":
      return Buffer.from(u8.buffer, u8.byteOffset, u8.byteLength);
    case "arraybuffer":
      return u8.buffer.slice(
        u8.byteOffset,
        u8.byteOffset + u8.byteLength,
      ) as ArrayBuffer;
    case "blob":
      return new Blob([u8 as BlobPart]);
    default:
      return u8;
  }
}

/** A WebSocket connection, shaped like Bun's `ServerWebSocket` (plus a few extras: `id`, `url`, `header()`). */
export class WebSocket<D = unknown> {
  readonly id: number;
  /** Path plus query string of the upgrade request. */
  readonly url: string;
  data: D;
  closed = false;
  /** Client address of the upgrade request. */
  ip: string | null = null;
  /** The subprotocol that was negotiated ("" if none). */
  subprotocol = "";
  /** How binary messages are delivered to `message` handlers. */
  binaryType: BinaryType = "uint8array";
  private host: WsHost;
  private headers: string[];
  private topics = new Set<string>();
  private closing = false;
  private paused = false;
  /** Bytes passed to `send` in this turn that the engine has not been told about yet (reset on flush). */
  localPending = 0;
  /** Upper estimate of this socket's unsent bytes since the engine was last asked, and sends since then. */
  private estimate = 0;
  private sends = 0;

  constructor(
    host: WsHost,
    id: number,
    url: string,
    headers: string[],
    data: D,
  ) {
    this.host = host;
    this.id = id;
    this.url = url;
    this.headers = headers;
    this.data = data;
  }

  /** 1 open, 2 closing (a close was requested), 3 closed. */
  get readyState(): 0 | 1 | 2 | 3 {
    return this.closed ? 3 : this.closing ? 2 : 1;
  }

  /** Alias of `ip`, as on Bun's ServerWebSocket. */
  get remoteAddress(): string {
    return this.ip ?? "";
  }

  /** Header of the upgrade request (names are matched case-insensitively). */
  header(name: string): string | null {
    const n = name.toLowerCase();
    for (let i = 0; i < this.headers.length; i += 2)
      if (this.headers[i] === n) return this.headers[i + 1];
    return null;
  }

  /**
   * Queues a message. Returns the number of bytes queued, 0 if the socket is closed (dropped), or -1 when the
   * socket's backlog is over the limit (in the non-closing backpressure mode; the message is still queued and a
   * `drain` event follows).
   */
  send(data: Sendable, _compress?: boolean): number {
    if (data instanceof Blob) return this.sendBlob(data);
    if (this.closed || this.closing) return 0;
    const d = toBytes(data);
    const n = this.host.wsSend(this.id, d);
    if (this.host.softLimit === 0) return n;
    if (this.localPending === 0) this.host.markDirty(this);
    this.localPending += n;
    // Asking the engine for the backlog is a native call: do it only when the bytes sent since the last answer
    // could matter, and every 64 sends in case other publishers fill this socket's queue.
    this.estimate += n;
    if (this.estimate <= this.host.softLimit >> 1 && (++this.sends & 63) !== 0)
      return n;
    this.sends = 0;
    this.estimate = Math.max(0, this.host.wsBuffered(this.id));
    return this.estimate + this.localPending > this.host.softLimit ? -1 : n;
  }

  sendText(data: string, compress?: boolean): number {
    return this.send(data, compress);
  }

  sendBinary(data: BufferSourceLike | Blob, compress?: boolean): number {
    return this.send(data, compress);
  }

  private sendBlob(b: Blob): number {
    if (this.closed || this.closing) return 0;
    void b.arrayBuffer().then((buf) => void this.send(buf)); // asynchronous: later sends may overtake it
    return b.size;
  }

  close(code = 1000, reason = ""): void {
    if (this.closed || this.closing) return;
    this.closing = true;
    this.host.wsClose(this.id, code, truncateReason(reason));
  }

  /** Drops the connection immediately, without a closing handshake. */
  terminate(): void {
    if (this.closed) return;
    this.closing = true;
    this.host.wsTerminate(this.id);
  }

  ping(data?: string | BufferSourceLike): number {
    if (this.closed) return 0;
    const d = data === undefined ? new Uint8Array(0) : toBytes(data);
    this.host.wsPing(
      this.id,
      typeof d === "string" ? new TextEncoder().encode(d) : d,
    );
    return typeof d === "string" ? Buffer.byteLength(d) : d.length;
  }

  pong(data?: string | BufferSourceLike): number {
    if (this.closed) return 0;
    const d = data === undefined ? new Uint8Array(0) : toBytes(data);
    this.host.wsPong(
      this.id,
      typeof d === "string" ? new TextEncoder().encode(d) : d,
    );
    return typeof d === "string" ? Buffer.byteLength(d) : d.length;
  }

  /** Messages are batched per event-loop turn already; `cork` just runs the callback. */
  cork<R>(callback: (ws: this) => R): R {
    return callback(this);
  }

  /** Returns true if the topic was newly subscribed. */
  subscribe(topic: string): boolean {
    if (this.closed) return false;
    if (this.topics.has(topic)) return true;
    this.topics.add(topic);
    this.host.wsSubscribe(this.id, topic);
    return true;
  }

  /** Returns true if the topic was subscribed. */
  unsubscribe(topic: string): boolean {
    if (this.closed || !this.topics.delete(topic)) return false;
    this.host.wsUnsubscribe(this.id, topic);
    return true;
  }

  isSubscribed(topic: string): boolean {
    return this.topics.has(topic);
  }

  get subscriptions(): string[] {
    return [...this.topics];
  }

  /** Sends to every subscriber of `topic` on any thread; the sender is excluded unless `publishToSelf` is on. */
  publish(
    topic: string,
    data: string | BufferSourceLike,
    _compress?: boolean,
  ): number {
    const d = toBytes(data);
    this.host.publish(topic, d, this.host.publishToSelf ? 0 : this.id);
    return typeof d === "string" ? Buffer.byteLength(d) : d.length;
  }

  publishText(topic: string, data: string, compress?: boolean): number {
    return this.publish(topic, data, compress);
  }

  publishBinary(
    topic: string,
    data: BufferSourceLike,
    compress?: boolean,
  ): number {
    return this.publish(topic, data, compress);
  }

  /** Bytes queued for this socket that the network has not taken yet. */
  getBufferedAmount(): number {
    return this.closed
      ? 0
      : Math.max(0, this.host.wsBuffered(this.id)) + this.localPending;
  }

  /** Stops reading from the socket: the peer is held back by TCP flow control until `resume()`. */
  pause(): void {
    if (this.closed || this.paused) return;
    this.paused = true;
    this.host.wsPause(this.id);
  }

  resume(): void {
    if (this.closed || !this.paused) return;
    this.paused = false;
    this.host.wsResume(this.id);
  }

  get isPaused(): boolean {
    return this.paused;
  }
}

/** What an `upgrade` hook may return to accept the connection. */
export interface UpgradeOptions<D = unknown> {
  /** Becomes `ws.data`. */
  data?: D;
  /** Extra headers on the 101 response. */
  headers?: HeaderInit;
  /** Subprotocol to answer with; default: the first one the client offered. */
  protocol?: string;
}

type Msg = string | Buffer | ArrayBuffer | Uint8Array | Blob;

export interface WsHandlers<D = unknown> {
  /**
   * Decides, before the handshake completes, whether to accept the upgrade. Return `true` (or nothing) or
   * `{ data, headers, protocol }` to accept; return a `Reply`/`Response` (e.g. 403, 429) to refuse.
   */
  upgrade?: (
    ctx: Context,
  ) =>
    | boolean
    | void
    | UpgradeOptions<D>
    | Reply
    | Response
    | Promise<boolean | void | UpgradeOptions<D> | Reply | Response>;
  /** Builds `ws.data` from the upgrade request when `upgrade` does not supply it. */
  data?: (ctx: Context) => D;
  open?: (ws: WebSocket<D>) => unknown;
  /** Text arrives as a string; binary as the type of `ws.binaryType` (default Uint8Array). */
  message?: (ws: WebSocket<D>, message: Msg) => unknown;
  close?: (ws: WebSocket<D>, code: number, reason: string) => unknown;
  /** The socket's backlog cleared after `send` returned -1 (non-closing backpressure mode). */
  drain?: (ws: WebSocket<D>) => unknown;
  /** A ping frame arrived (the reply was already sent). */
  ping?: (ws: WebSocket<D>, data: Buffer) => unknown;
  pong?: (ws: WebSocket<D>, data: Buffer) => unknown;
  /** A handler of this socket threw. Without it the engine's error callback gets the error. */
  error?: (error: Error, ws: WebSocket<D>) => unknown;
}

/** The result that accepts a WebSocket upgrade; returned by the router, or from `server.upgrade()`'s fetch handler. */
export class UpgradeReply {
  handlers: WsHandlers<any>;
  data: unknown;
  headers: HeaderInit | null;
  protocol: string;
  constructor(handlers: WsHandlers<any>, opts: UpgradeOptions<any> = {}) {
    this.handlers = handlers;
    this.data = opts.data;
    this.headers = opts.headers ?? null;
    this.protocol = opts.protocol ?? "";
  }
}

/** A close reason may take 123 bytes; cut at a character boundary so the frame stays valid UTF-8. */
function truncateReason(reason: string): string {
  if (reason.length <= 41) return reason; // at most 3 bytes a UTF-16 unit
  const b = Buffer.from(reason);
  if (b.length <= 123) return reason;
  let end = 123;
  while (end > 0 && (b[end] & 0xc0) === 0x80) end--;
  return b.subarray(0, end).toString();
}
