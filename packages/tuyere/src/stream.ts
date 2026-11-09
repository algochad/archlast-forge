import type { HeaderInit } from "./codec.ts";

/** What a lane provides to a stream once the response head has been sent. */
export interface StreamHost {
  streamChunk(id: number, chunk: string | Uint8Array): void;
  streamEnd(id: number): void;
  streamError(id: number): void;
}

/** Written but unacknowledged bytes a stream allows before `drained()` makes the producer wait. */
const STREAM_WINDOW = 1024 * 1024;

/**
 * A chunked response whose body you write over time. Return it from a handler; writes made before the
 * handler returns are buffered. `onClose` fires when the client disconnects or the server stops.
 */
export class Stream {
  status: number;
  headers: HeaderInit | null;
  closed = false;
  private host: StreamHost | null = null;
  private id = 0;
  private pending: (string | Uint8Array)[] = [];
  private ended = false;
  private failed = false;
  private closeHandlers: (() => void)[] = [];
  /** Bytes written and bytes the engine has reported as sent to the client (flow control, see `drained`). */
  private sent = 0;
  private acked = 0;
  private waiting: (() => void)[] = [];

  constructor(init: { status?: number; headers?: HeaderInit } = {}) {
    this.status = init.status ?? 200;
    this.headers = init.headers ?? null;
  }

  /** Returns false if the stream is already closed or ended. */
  write(chunk: string | Uint8Array): boolean {
    if (this.closed || this.ended) return false;
    this.sent += chunk.length;
    if (this.host === null) this.pending.push(chunk);
    else this.host.streamChunk(this.id, chunk);
    return true;
  }

  /**
   * Resolves when the client has taken most of what was written (or the stream is closed). A producer that can
   * outrun the client awaits this after each write, so a slow reader never makes the server buffer the whole body.
   */
  drained(): Promise<void> {
    if (this.closed || this.sent - this.acked <= STREAM_WINDOW)
      return Promise.resolve();
    return new Promise((res) => this.waiting.push(res));
  }

  /** Called by the lane when that many bytes have been handed to the connection. */
  _ack(bytes: number): void {
    this.acked = Math.min(this.sent, this.acked + bytes);
    if (this.sent - this.acked <= STREAM_WINDOW && this.waiting.length > 0) {
      const w = this.waiting;
      this.waiting = [];
      for (const r of w) r();
    }
  }

  end(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    if (this.host !== null) this.host.streamEnd(this.id);
  }

  /** Aborts the response: the client sees a broken stream (not a clean end), which is how a failed producer must look. */
  error(): void {
    if (this.closed || this.ended) return;
    this.ended = true;
    this.failed = true;
    this.pending = [];
    if (this.host !== null) this.host.streamError(this.id);
  }

  onClose(fn: () => void): this {
    if (this.closed) queueMicrotask(fn);
    else this.closeHandlers.push(fn);
    return this;
  }

  /** Called by the lane after it has sent the response head. */
  _bind(host: StreamHost, id: number): void {
    this.host = host;
    this.id = id;
    for (const c of this.pending) host.streamChunk(id, c);
    this.pending = [];
    if (this.failed) host.streamError(id);
    else if (this.ended) host.streamEnd(id);
  }

  /** Called by the lane when the client went away or the server is stopping. */
  _closed(): void {
    if (this.closed) return;
    this.closed = true;
    for (const r of this.waiting.splice(0)) r();
    const hs = this.closeHandlers;
    this.closeHandlers = [];
    for (const h of hs) {
      try {
        h();
      } catch (e) {
        console.error(e);
      }
    }
  }
}

export interface SseOptions {
  event?: string;
  id?: string | number;
  retry?: number;
}

function frame(data: unknown, o?: SseOptions): string {
  let s = "";
  if (o?.event !== undefined) s += `event: ${o.event}\n`;
  if (o?.id !== undefined) s += `id: ${o.id}\n`;
  if (o?.retry !== undefined) s += `retry: ${o.retry}\n`;
  const d = typeof data === "string" ? data : JSON.stringify(data);
  if (d.includes("\n") || d.includes("\r"))
    for (const line of d.split(/\r\n|\r|\n/)) s += `data: ${line}\n`;
  else s += `data: ${d}\n`;
  return s + "\n";
}

/** Server-Sent Events stream. */
export class SseStream extends Stream {
  constructor(init: { status?: number; headers?: HeaderInit } = {}) {
    const base: [string, string][] = [
      ["content-type", "text/event-stream;charset=utf-8"],
      ["cache-control", "no-cache"],
      ["x-accel-buffering", "no"],
    ];
    const extra = init.headers ?? [];
    super({
      status: init.status,
      headers: [
        ...base,
        ...(Array.isArray(extra) ? extra : Object.entries(extra)),
      ],
    });
  }

  /** Sends one event; objects are JSON-encoded and multi-line strings become several `data:` lines. */
  send(data: unknown, o?: SseOptions): boolean {
    return this.write(frame(data, o));
  }

  /** Sends a comment line (useful as a keep-alive). */
  comment(text = ""): boolean {
    return this.write(`: ${text}\n\n`);
  }
}

/**
 * Creates an SSE response. `setup` runs immediately with the stream; it may return a cleanup function
 * that runs when the client disconnects.
 */
export function sse(
  setup?: (s: SseStream) => void | (() => void),
  init?: { status?: number; headers?: HeaderInit },
): SseStream {
  const s = new SseStream(init);
  const cleanup = setup?.(s);
  if (typeof cleanup === "function") s.onClose(cleanup);
  return s;
}
