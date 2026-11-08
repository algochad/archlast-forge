import {
  Worker,
  isMainThread,
  parentPort,
  workerData,
} from "node:worker_threads";
import {
  type Backend,
  type BackendName,
  defaultBackend,
  getBackend,
} from "./backend.ts";
import {
  type HeaderInit,
  HeaderBlock,
  type NativeOptions,
  type RawRequest,
  encodeOptions,
} from "./codec.ts";
import { type AppHandlers, LaneRuntime } from "./runtime.ts";
import type { FileReply } from "./file.ts";
import type { Stream } from "./stream.ts";

export type Body = string | Uint8Array | null;

/** A page for the engine to print: template `template` (see `registerTemplate`) with `data` (JSON text), printed on the I/O thread while this thread goes on to the next request. */
export class TemplateReply {
  constructor(
    readonly template: number,
    readonly data: string,
    readonly init: { status?: number; headers?: HeaderInit } = {},
  ) {}
}

/** Explicit response: use when you need a status code or headers. */
export class Reply {
  body: Body;
  status: number;
  headers: HeaderInit | null;
  /** Headers sent with the others, encoded ahead of time (see `HeaderBlock`). */
  block: HeaderBlock | null;
  constructor(
    body: Body = null,
    init: { status?: number; headers?: HeaderInit; block?: HeaderBlock } = {},
  ) {
    this.body = body;
    this.status = init.status ?? 200;
    if (
      !Number.isInteger(this.status) ||
      this.status < 200 ||
      this.status > 999
    ) {
      throw new RangeError(
        `invalid HTTP status ${this.status}: use an integer from 200 to 999 (1xx responses are not supported)`,
      );
    }
    this.headers = init.headers ?? null;
    this.block = init.block ?? null;
  }
}

/**
 * What a handler may return. string -> text/plain, Uint8Array -> octet-stream, Reply -> as given,
 * Stream/SseStream -> streamed body, FileReply (see `file()`) -> streamed from disk by Rust, Response -> converted (async), null/undefined -> empty 200,
 * anything else -> JSON.
 */
export type Result =
  | string
  | Uint8Array
  | Reply
  | Stream
  | FileReply
  | Response
  | object
  | number
  | boolean
  | null
  | undefined;
export type Dispatch = (req: RawRequest) => Result | Promise<Result>;

export interface Server {
  readonly port: number;
  readonly hostname: string;
  /** "https" when the server has `tls` options. */
  readonly protocol: "http" | "https";
  /** The unix-domain socket path, when listening on one (then `port` is 0). */
  readonly unix: string | undefined;
  readonly backend: BackendName;
  /** Number of JS threads handling requests (this one included). */
  readonly workers: number;
  /** Resolves once every worker thread is attached and serving. */
  readonly ready: Promise<void>;
  /** Sends to every WebSocket subscribed to `topic`, on any thread. */
  publish(topic: string, data: string | Uint8Array): void;
  /**
   * Drops the responses the engine kept because a handler sent `x-archlast-cache` (see `cacheHeader`): those carrying one of `tags`, or all of them
   * when there are none.
   */
  purgeCache(tags?: string[]): void;
  /** Reaches any open WebSocket by id (`ws.id`), from anywhere in the process, e.g. a timer or another handler. */
  readonly sockets: {
    send(id: number, data: string | Uint8Array): void;
    close(id: number, code?: number, reason?: string): void;
  };
  /** Requests handed to JS that have not been answered yet. */
  readonly pendingRequests: number;
  /** Open WebSocket connections. */
  readonly pendingWebSockets: number;
  /** Number of sockets subscribed to `topic`, across all threads. */
  subscriberCount(topic: string): number;
  /** Closes keep-alive connections that have no request in flight; returns how many. */
  closeIdleConnections(): number;
  /** Stops immediately, dropping every connection. */
  stop(): void;
  /**
   * Graceful shutdown: stop accepting, close WebSockets with 1012, let requests in flight finish, then stop. After
   * `timeoutMs` (default 10 s) whatever is left is dropped. Resolves when the server is down.
   */
  close(opts?: { timeoutMs?: number }): Promise<void>;
  ref(): void;
  unref(): void;
}

export interface StartOptions {
  port: number;
  hostname: string;
  threads: number;
  maxBody: number;
  statics: NativeOptions["statics"];
  wsRoutes: NativeOptions["wsRoutes"];
  wsMaxMessage: number;
  wsBackpressure: number;
  wsPingInterval: number;
  wsCloseOnBackpressure: boolean;
  wsPublishToSelf: boolean;
  idleTimeout: number;
  wsIdleTimeout: number;
  reusePort: boolean;
  ipv6Only: boolean;
  http2: boolean;
  unix: string;
  tls: NativeOptions["tls"];
  wsDeflate: NativeOptions["wsDeflate"];
  spinMicros: number;
  spinMaxConnections: number;
  workers: number;
  /** Script that workers re-run (it must call `listen` again). Default: the main script. */
  entry?: string;
  backend?: BackendName;
  app: AppHandlers;
  onError: (err: unknown) => void;
}

const TEXT = "text/plain;charset=utf-8";
const JSON_TYPE = "application/json;charset=utf-8";
const BINARY = "application/octet-stream";
export const NOT_FOUND = "Not Found";

function hasContentType(h: HeaderInit | null): boolean {
  if (h === null) return false;
  if (Array.isArray(h))
    return h.some(([k]) => k.toLowerCase() === "content-type");
  for (const k in h) if (k.toLowerCase() === "content-type") return true;
  return false;
}

/** Normalizes a handler result into a Reply with its default content-type filled in. */
export function toReply(v: Result): Reply {
  if (v instanceof Reply) {
    if (v.body !== null && !hasContentType(v.headers)) {
      const ct = typeof v.body === "string" ? TEXT : BINARY;
      const h: [string, string][] = Array.isArray(v.headers)
        ? [...v.headers]
        : Object.entries(v.headers ?? {});
      h.push(["content-type", ct]);
      return new Reply(v.body, { status: v.status, headers: h });
    }
    return v;
  }
  if (v === null || v === undefined) return new Reply(null);
  if (typeof v === "string")
    return new Reply(v, { headers: { "content-type": TEXT } });
  if (v instanceof Uint8Array)
    return new Reply(v, { headers: { "content-type": BINARY } });
  if (v instanceof Response)
    throw new Error("a Response cannot be used as a constant route");
  return new Reply(JSON.stringify(v), {
    headers: { "content-type": JSON_TYPE },
  });
}

/** Set in a worker thread that was spawned by `startServer`; tells `listen()` to attach instead of start. */
interface WorkerInfo {
  id: number;
  lane: number;
  backend: BackendName;
  port: number;
  workers: number;
  hostname: string;
  protocol: "http" | "https";
  unix: string | undefined;
}
const workerInfo: WorkerInfo | undefined = !isMainThread
  ? workerData?.__archlast
  : undefined;
let workerAttached = false;

const inertServer: Server = {
  port: 0,
  hostname: "",
  protocol: "http",
  unix: undefined,
  backend: "napi",
  workers: 0,
  ready: Promise.resolve(),
  publish() {},
  purgeCache() {},
  pendingRequests: 0,
  pendingWebSockets: 0,
  subscriberCount: () => 0,
  closeIdleConnections: () => 0,
  sockets: { send() {}, close() {} },
  stop() {},
  close: () => Promise.resolve(),
  ref() {},
  unref() {},
};
let warnedInert = false;

export function startServer(o: StartOptions): Server {
  if (!isMainThread && !workerInfo) {
    // A thread archlast did not create (e.g. a knitting worker re-importing your module): never bind a second server.
    if (!warnedInert) {
      warnedInert = true;
      console.warn(
        "archlast-serve: listen() ignored in a worker thread that archlast did not create (guard it with `isMain`)",
      );
    }
    return inertServer;
  }
  if (workerInfo) {
    if (workerAttached)
      throw new Error("only one multi-threaded server per app is supported");
    workerAttached = true;
    return attachWorker(workerInfo, o);
  }
  const backend = getBackend(o.backend ?? defaultBackend());
  const lanes = Math.max(1, Math.floor(o.workers));
  const { id, port } = backend.start(encodeOptions(o), lanes);
  return new MainServer(backend, id, port, lanes, o);
}

abstract class BaseServer implements Server {
  abstract readonly port: number;
  abstract readonly hostname: string;
  abstract readonly protocol: "http" | "https";
  abstract readonly unix: string | undefined;
  abstract readonly backend: BackendName;
  abstract readonly workers: number;
  abstract readonly ready: Promise<void>;
  protected abstract runtime: LaneRuntime;

  publish(topic: string, data: string | Uint8Array): void {
    this.runtime.publish(topic, data, 0);
  }
  purgeCache(tags?: string[]): void {
    this.runtime.purgeCache(tags);
  }
  get sockets() {
    const rt = this.runtime;
    return {
      send: (id: number, data: string | Uint8Array) => rt.wsSend(id, data),
      close: (id: number, code = 1000, reason = "") =>
        rt.wsClose(id, code, reason),
    };
  }
  get pendingRequests(): number {
    return this.stats()[0];
  }
  get pendingWebSockets(): number {
    return this.stats()[1];
  }
  protected stats(): [number, number, number] {
    return [0, 0, 0];
  }
  subscriberCount(_topic: string): number {
    return 0;
  }
  closeIdleConnections(): number {
    return 0;
  }
  abstract stop(): void;
  abstract close(opts?: { timeoutMs?: number }): Promise<void>;
  abstract ref(): void;
  abstract unref(): void;
}

class MainServer extends BaseServer {
  readonly port: number;
  readonly hostname: string;
  readonly protocol: "http" | "https";
  readonly unix: string | undefined;
  readonly backend: BackendName;
  readonly workers: number;
  readonly ready: Promise<void>;
  protected runtime: LaneRuntime;
  private be: Backend;
  private id: number;
  private threads: Worker[] = [];
  private stopped = false;

  constructor(
    be: Backend,
    id: number,
    port: number,
    lanes: number,
    o: StartOptions,
  ) {
    super();
    this.be = be;
    this.id = id;
    this.port = port;
    this.hostname = o.hostname;
    this.protocol = o.tls.length > 0 ? "https" : "http";
    this.unix = o.unix || undefined;
    this.backend = be.name;
    this.workers = lanes;
    this.runtime = new LaneRuntime(be, id, 0, o.app, o.onError, {
      softLimit: o.wsCloseOnBackpressure ? 0 : o.wsBackpressure,
      publishToSelf: o.wsPublishToSelf,
      spinMicros: o.spinMicros,
      spinMaxConnections: o.spinMaxConnections,
    });

    const entry = o.entry ?? Bun.main;
    const ready: Promise<void>[] = [];
    for (let lane = 1; lane < lanes; lane++) {
      const info: WorkerInfo = {
        id,
        lane,
        backend: be.name,
        port,
        workers: lanes,
        hostname: o.hostname,
        protocol: this.protocol,
        unix: this.unix,
      };
      const w = new Worker(entry, { workerData: { __archlast: info } });
      this.threads.push(w);
      ready.push(
        new Promise<void>((resolve, reject) => {
          w.on("message", (m) => m?.archlast === "ready" && resolve());
          w.once("error", (e) => {
            o.onError(e);
            reject(e);
          });
          w.once("exit", (code) => {
            if (this.stopped) return;
            // A worker that is gone must not keep receiving work.
            be.detachLane(id, lane);
            if (code !== 0)
              o.onError(
                new Error(
                  `archlast-serve worker ${lane} exited with code ${code}`,
                ),
              );
            reject(new Error(`worker ${lane} exited`));
          });
        }),
      );
    }
    this.ready = Promise.all(ready).then(() => {});
    this.ready.catch(() => {}); // surfaced through onError; awaiting `ready` still rejects
  }

  protected override stats(): [number, number, number] {
    return this.stopped ? [0, 0, 0] : this.be.stats(this.id);
  }
  override subscriberCount(topic: string): number {
    return this.stopped ? 0 : this.be.topicCount(this.id, topic);
  }
  override closeIdleConnections(): number {
    return this.stopped ? 0 : this.be.closeIdle(this.id);
  }

  stop(): void {
    if (this.stopped) return;
    this.stopped = true;
    this.runtime.closeSocketsAbruptly(); // sockets still open get their `close` handler (1001) before they are dropped
    this.runtime.stop();
    // Detach every lane (a barrier against in-flight native callbacks) before the workers are killed.
    this.be.stop(this.id);
    for (const w of this.threads) void w.terminate();
  }
  async close(opts: { timeoutMs?: number } = {}): Promise<void> {
    if (this.stopped) return;
    const deadline = Date.now() + (opts.timeoutMs ?? 10_000);
    if (this.be.drainBegin(this.id)) {
      // The JS threads keep running (they must answer the requests in flight); poll until the sockets are gone.
      while (this.be.openConnections(this.id) > 0 && Date.now() < deadline)
        await new Promise((r) => setTimeout(r, 10));
    }
    this.stop();
  }
  ref(): void {
    this.runtime.ref();
    for (const w of this.threads) w.ref();
  }
  unref(): void {
    this.runtime.unref();
    for (const w of this.threads) w.unref();
  }
}

class WorkerServer extends BaseServer {
  readonly port: number;
  readonly hostname: string;
  readonly protocol: "http" | "https";
  readonly unix: string | undefined;
  readonly backend: BackendName;
  readonly workers: number;
  readonly ready = Promise.resolve();
  protected runtime: LaneRuntime;

  constructor(info: WorkerInfo, runtime: LaneRuntime) {
    super();
    this.port = info.port;
    this.hostname = info.hostname;
    this.protocol = info.protocol;
    this.unix = info.unix;
    this.backend = info.backend;
    this.workers = info.workers;
    this.runtime = runtime;
  }
  stop(): void {
    this.runtime.stop();
  }
  async close(): Promise<void> {
    this.runtime.stop(); // a worker only leaves; the main thread owns the listener
  }
  ref(): void {
    this.runtime.ref();
  }
  unref(): void {
    this.runtime.unref();
  }
}

function attachWorker(info: WorkerInfo, o: StartOptions): Server {
  const be = getBackend(info.backend);
  const runtime = new LaneRuntime(be, info.id, info.lane, o.app, o.onError, {
    softLimit: o.wsCloseOnBackpressure ? 0 : o.wsBackpressure,
    publishToSelf: o.wsPublishToSelf,
    spinMicros: o.spinMicros,
    spinMaxConnections: o.spinMaxConnections,
  });
  // An uncaught error kills this thread; leave the lane first so Rust never calls into a dead VM.
  process.on("uncaughtException", (e) => {
    runtime.stop();
    console.error(e);
    process.exit(1);
  });
  parentPort?.postMessage({ archlast: "ready", lane: info.lane });
  return new WorkerServer(info, runtime);
}
