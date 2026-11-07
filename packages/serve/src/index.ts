import { availableParallelism } from "node:os";
import type { BackendName } from "./backend.ts";
import type { StaticEntry } from "./codec.ts";
import { encoder } from "./codec.ts";
import {
  type Handler,
  type Method,
  type RouteValue,
  Router,
  toWebRequest,
} from "./router.ts";
import {
  Reply,
  type Result,
  type Server,
  startServer,
  toReply,
} from "./server.ts";
import type { WsHandlers } from "./websocket.ts";
import { type PerMessageDeflate, deflateOptions } from "./deflate.ts";
import { type TlsOptions, tlsEntries } from "./tls.ts";
export type { PerMessageDeflate } from "./deflate.ts";
export type { TlsOptions } from "./tls.ts";

export { Context, type Handler, type RouteValue } from "./router.ts";
export { Reply, type Result, type Server } from "./server.ts";
export { html, json, noContent, redirect, status, text } from "./reply.ts";
export { SseStream, Stream, sse, type SseOptions } from "./stream.ts";
export { FileReply, file } from "./file.ts";
export {
  UpgradeReply,
  WebSocket,
  type UpgradeOptions,
  type WsHandlers,
} from "./websocket.ts";
export type { BackendName } from "./backend.ts";

export interface ListenOptions {
  port?: number;
  hostname?: string;
  /**
   * Rust I/O threads (HTTP parsing, sockets, static routes, WebSocket fan-out), one single-threaded runtime each.
   * Default: 2. Fewer threads batch better and cost less CPU per request (measured 5.6 us vs 7.1 us at 300k req/s for
   * 2 vs 4); raise it for peak throughput (2 threads: ~350k req/s, 4: ~590k, 6 with 2 JS workers: ~750k).
   */
  threads?: number;
  /**
   * JS threads running your handlers (default 1). With n > 1 the main script is re-run in n-1 worker
   * threads, so everything outside `listen` runs once per thread and in-memory state is per thread.
   */
  workers?: number;
  /** Script the workers re-run. Default: the main script (`Bun.main`). */
  entry?: string;
  /** Seconds without traffic before a connection is closed (default 60; 0 = never). `ctx.timeout(0)` opts a request out. */
  idleTimeout?: number;
  /** Same for upgraded WebSocket connections (default 120; 0 = never). */
  wsIdleTimeout?: number;
  /** Offer EVERY WebSocket upgrade request to the handler (used by the Bun.serve-shaped facade). */
  wsAny?: boolean;
  /** Largest WebSocket message in bytes; a bigger one closes the socket with 1009 (default 16 MiB). */
  wsMaxPayload?: number;
  /** Bytes queued for one socket before a client that cannot keep up is dropped (default 4 MiB). */
  wsBackpressureLimit?: number;
  /** Seconds between transport pings on idle sockets (default 30; 0 = off). */
  wsPingInterval?: number;
  /** Drop a client whose backlog exceeds the limit (default true). When false, `send` returns -1 beyond it and `drain` follows. */
  wsCloseOnBackpressureLimit?: boolean;
  /** WebSocket compression (permessage-deflate, RFC 7692), negotiated per connection. See `PerMessageDeflate`. */
  wsPerMessageDeflate?: PerMessageDeflate;
  /**
   * Latency mode: after handling work, keep polling for this many microseconds (one event-loop turn at a time on the JS
   * thread, between non-blocking socket polls on the I/O threads) before sleeping. A lone request/response pair then
   * skips the sleep and wake-up cycles on both threads: single-connection WebSocket round trips drop from about 20 to 12
   * microseconds, level with Bun.serve. It costs CPU while traffic flows (about 1.2 cores at one busy connection) and
   * is only used while at most `spinMaxConnections` connections are open: with more, threads are busy anyway.
   * Default 30; 0 turns it off.
   */
  spinMicros?: number;
  /** Latency mode applies while at most this many connections are open (default 4). */
  spinMaxConnections?: number;
  /** Whether `ws.publish` also delivers to the sender (default false). */
  wsPublishToSelf?: boolean;
  /** Serve HTTPS. An array adds SNI entries (`serverName`, wildcards ok); the first is the default. See `TlsOptions`. */
  tls?: TlsOptions | TlsOptions[];
  /** Negotiate HTTP/2 (ALPN `h2`) on HTTPS connections; HTTP/1.1 clients are still served (default true). */
  http2?: boolean;
  /** Listen on a unix-domain socket instead of TCP (a stale socket file is replaced, and removed again on stop). */
  unix?: string;
  /** Give every I/O thread its own SO_REUSEPORT socket so several processes can share the port. */
  reusePort?: boolean;
  /** For an IPv6 hostname such as `::`: accept IPv6 only (default false: dual-stack). */
  ipv6Only?: boolean;
  /** Maximum request body / WebSocket message in bytes. Larger bodies get a 413. */
  maxRequestBodySize?: number;
  /** "napi" (Node-API addon loaded by Bun) or "bun-ffi". Env ARCHLAST_BACKEND overrides the default. */
  backend?: BackendName;
}

export interface ServeOptions extends ListenOptions {
  /**
   * path -> handler | constant | { GET: ..., POST: ... }. Constants (string, object, Uint8Array, Reply) are served
   * entirely by the Rust side without entering JS.
   */
  routes?: Record<string, RouteValue | Partial<Record<Method, RouteValue>>>;
  /** WebSocket endpoints by exact path. */
  ws?: Record<string, WsHandlers<any>>;
  /** Bun.serve-style fallback for requests no route matched. */
  fetch?: (req: Request, server: Server) => Response | Promise<Response>;
  /** Called when a handler throws; the client gets a 500. */
  error?: (err: unknown) => void;
}

/** Method names recognised as keys of a `routes` entry ({ GET: ..., PURGE: ... }). */
const METHOD_KEYS = new Set([
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
  "PURGE",
  "PROPFIND",
  "PROPPATCH",
  "MKCOL",
  "COPY",
  "MOVE",
  "LOCK",
  "UNLOCK",
  "REPORT",
  "SEARCH",
  "LINK",
  "UNLINK",
  "QUERY",
]);

function toStatic(method: string, path: string, value: Result): StaticEntry {
  const r = toReply(value);
  const headers: [string, string][] = Array.isArray(r.headers)
    ? r.headers
    : Object.entries(r.headers ?? {});
  const body =
    typeof r.body === "string"
      ? encoder.encode(r.body)
      : (r.body ?? new Uint8Array(0));
  return {
    method,
    path,
    status: r.status,
    headers: headers.map(([k, v]) => [k.toLowerCase(), v]),
    body,
  };
}

function defaultThreads(): number {
  return Math.min(2, availableParallelism());
}

export function listen(
  router: Router,
  o: ListenOptions & { error?: (e: unknown) => void },
): Server {
  return startServer({
    port: o.port ?? 3000,
    hostname: o.hostname ?? "0.0.0.0",
    threads: o.threads ?? defaultThreads(),
    maxBody: o.maxRequestBodySize ?? 128 * 1024 * 1024,
    workers: o.workers ?? 1,
    entry: o.entry,
    backend: o.backend,
    statics: router
      .nativeStatics()
      .map((s) => toStatic(s.method, s.path, s.value)),
    wsRoutes: [
      ...(o.wsAny ? [{ kind: 2 as const, path: "" }] : []),
      ...[...router.wsRoutes.keys()].map((path) => ({
        kind: 0 as const,
        path,
      })),
      ...router.wsPrefixes.map(([path]) => ({ kind: 1 as const, path })),
    ],
    wsMaxMessage: o.wsMaxPayload ?? 16 * 1024 * 1024,
    wsBackpressure: o.wsBackpressureLimit ?? 4 * 1024 * 1024,
    wsPingInterval: o.wsPingInterval ?? 30,
    wsCloseOnBackpressure: o.wsCloseOnBackpressureLimit ?? true,
    wsPublishToSelf: o.wsPublishToSelf ?? false,
    idleTimeout: o.idleTimeout ?? 60,
    wsIdleTimeout: o.wsIdleTimeout ?? 120,
    reusePort: o.reusePort ?? false,
    ipv6Only: o.ipv6Only ?? false,
    http2: o.http2 ?? true,
    unix: o.unix ?? "",
    tls: tlsEntries(o.tls),
    wsDeflate: deflateOptions(o.wsPerMessageDeflate),
    spinMicros: o.spinMicros ?? Number(process.env.ARCHLAST_SPIN_US ?? 30),
    spinMaxConnections: o.spinMaxConnections ?? 4,
    app: { dispatch: router.dispatch },
    onError: o.error ?? ((e) => console.error(e)),
  });
}

/** Bun.serve-style entry point. */
export function serve(o: ServeOptions): Server {
  const router = new Router();
  for (const [path, v] of Object.entries(o.routes ?? {})) {
    const byMethod =
      typeof v === "object" &&
      v !== null &&
      !(v instanceof Uint8Array) &&
      !(v instanceof Reply) &&
      Object.keys(v).length > 0 &&
      Object.keys(v).every((k) => METHOD_KEYS.has(k));
    if (byMethod)
      for (const [m, h] of Object.entries(v))
        router.add(m, path, h as RouteValue);
    else router.add("GET", path, v as RouteValue);
  }
  for (const [path, h] of Object.entries(o.ws ?? {})) router.addWs(path, h);
  if (o.fetch) {
    const fetchFn = o.fetch;
    router.fallback = (raw) => fetchFn(toWebRequest(raw), server);
  }
  const server: Server = listen(router, o);
  return server;
}

/** Elysia-style chainable app. */
export class App {
  private router = new Router();
  private errorHandler: ((e: unknown) => void) | undefined;

  /** Any method, including ones without a shortcut: `app.on("PURGE", "/cache/:key", ...)`. */
  on(method: string, path: string, value: RouteValue): this {
    this.router.add(method.toUpperCase(), path, value);
    return this;
  }

  get(path: string, v: RouteValue): this {
    return this.on("GET", path, v);
  }
  post(path: string, v: RouteValue): this {
    return this.on("POST", path, v);
  }
  put(path: string, v: RouteValue): this {
    return this.on("PUT", path, v);
  }
  delete(path: string, v: RouteValue): this {
    return this.on("DELETE", path, v);
  }
  patch(path: string, v: RouteValue): this {
    return this.on("PATCH", path, v);
  }
  head(path: string, v: RouteValue): this {
    return this.on("HEAD", path, v);
  }
  options(path: string, v: RouteValue): this {
    return this.on("OPTIONS", path, v);
  }
  trace(path: string, v: RouteValue): this {
    return this.on("TRACE", path, v);
  }
  connect(path: string, v: RouteValue): this {
    return this.on("CONNECT", path, v);
  }
  /** Every method (a method-specific route on the same path wins). */
  all(path: string, h: Handler): this {
    return this.on("*", path, h);
  }

  /** WebSocket endpoint on an exact path. */
  ws<D = unknown>(path: string, handlers: WsHandlers<D>): this {
    this.router.addWs(path, handlers);
    return this;
  }

  onError(fn: (e: unknown) => void): this {
    this.errorHandler = fn;
    return this;
  }

  listen(portOrOptions: number | ListenOptions = 3000): Server {
    const o =
      typeof portOrOptions === "number"
        ? { port: portOrOptions }
        : portOrOptions;
    return listen(this.router, { ...o, error: this.errorHandler });
  }
}
