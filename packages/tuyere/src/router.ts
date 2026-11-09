import type { RawRequest } from "./codec.ts";
import { type Body, NOT_FOUND, type Result, Reply, toReply } from "./server.ts";
import { FileReply } from "./file.ts";
import { Stream } from "./stream.ts";
import {
  UpgradeReply,
  type UpgradeOptions,
  type WsHandlers,
} from "./websocket.ts";

export type Method =
  | "GET"
  | "POST"
  | "PUT"
  | "DELETE"
  | "PATCH"
  | "HEAD"
  | "OPTIONS"
  | "TRACE"
  | "CONNECT"
  | (string & {});
export type Handler = (ctx: Context) => Result | Promise<Result>;
/** A function is a JS handler; any other value is a constant that the Rust side answers by itself. */
export type RouteValue =
  Handler | Exclude<Result, Response | ((...args: never[]) => unknown)>;

export interface SetState {
  status?: number;
  headers: Record<string, string>;
}

const textDecoder = new TextDecoder();

/** Per-request context handed to route handlers. Everything except `method`/`path` is lazy. */
export class Context {
  readonly raw: RawRequest;
  readonly method: string;
  readonly path: string;
  params: Record<string, string>;
  private _set: SetState | null = null;
  private _query: Record<string, string> | null = null;
  private _headers: Headers | null = null;

  constructor(raw: RawRequest, path: string, params: Record<string, string>) {
    this.raw = raw;
    this.method = raw.method;
    this.path = path;
    this.params = params;
  }

  /** Client address and port, or null if unknown. */
  requestIP(): {
    address: string;
    family: "IPv4" | "IPv6";
    port: number;
  } | null {
    const address = this.raw.ip;
    if (address === null) return null;
    return {
      address,
      family: this.raw.ipKind === 4 ? "IPv4" : "IPv6",
      port: this.raw.port ?? 0,
    };
  }

  /** Aborted when the client disconnects before the response is sent. */
  get signal(): AbortSignal {
    return this.raw.signal;
  }

  /** Overrides this connection's idle timeout until the response is sent; 0 disables it (long polls, slow uploads). */
  timeout(seconds: number): void {
    this.raw.setTimeout(seconds);
  }

  /** Path plus query string. */
  get url(): string {
    return this.raw.url;
  }

  get query(): Record<string, string> {
    if (this._query === null) {
      this._query = Object.fromEntries(new URLSearchParams(this.raw.search));
    }
    return this._query;
  }

  get headers(): Headers {
    if (this._headers === null) {
      const h = new Headers();
      const p = this.raw.headerPairs();
      for (let i = 0; i < p.length; i += 2) h.append(p[i], p[i + 1]);
      this._headers = h;
    }
    return this._headers;
  }

  header(name: string): string | null {
    return this.raw.header(name);
  }

  /** True when the body is larger than the inline limit and arrives as a stream (see `bodyStream`, `readBytes`). */
  get bodyStreamed(): boolean {
    return this.raw.bodyStreamed;
  }

  /** The body as a stream; null when there is none or it was small enough to arrive whole. */
  get bodyStream(): ReadableStream<Uint8Array> | null {
    return this.raw.bodyStream;
  }

  private requireWhole(): void {
    if (this.raw.bodyStreamed)
      throw new Error(
        "this request body is streamed (it is large): use `await ctx.readBytes()` / `ctx.readText()` or `ctx.bodyStream`",
      );
  }

  /** The whole body, for both small and streamed bodies (waits for the rest to arrive). */
  readBytes(): Promise<Uint8Array> {
    // Cached, so it can be called more than once (a stream can only be read once).
    return (this.whole ??= this.readAll());
  }

  private whole: Promise<Uint8Array> | null = null;

  private async readAll(): Promise<Uint8Array> {
    const stream = this.raw.bodyStream;
    if (!stream) return this.raw.body ?? new Uint8Array(0);
    const parts: Uint8Array[] = [];
    let size = 0;
    for await (const chunk of stream as unknown as AsyncIterable<Uint8Array>) {
      parts.push(chunk);
      size += chunk.length;
    }
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of parts) (out.set(p, at), (at += p.length));
    return out;
  }

  async readText(): Promise<string> {
    return textDecoder.decode(await this.readBytes());
  }

  /** Synchronous; throws for streamed (large) bodies, which need `readBytes()`. */
  bytes(): Uint8Array {
    this.requireWhole();
    return this.raw.body ?? new Uint8Array(0);
  }

  text(): string {
    this.requireWhole();
    return this.raw.body === null ? "" : textDecoder.decode(this.raw.body);
  }

  json<T = unknown>(): T {
    return JSON.parse(this.text()) as T;
  }

  /** Parsed according to content-type: JSON -> value, text/* and forms -> string, otherwise bytes. */
  get body(): unknown {
    this.requireWhole();
    if (this.raw.body === null) return undefined;
    const ct = this.raw.header("content-type") ?? "";
    if (ct.includes("json")) return this.json();
    if (ct.startsWith("text/") || ct.includes("urlencoded")) return this.text();
    return this.raw.body;
  }

  /** Mutate to change the status or headers of an otherwise plain return value. */
  get set(): SetState {
    return (this._set ??= { headers: {} });
  }

  /** `set` if it was touched, without allocating it. */
  get touchedSet(): SetState | null {
    return this._set;
  }

  /** A full Web `Request` (built on demand; costs an allocation). */
  get request(): Request {
    return toWebRequest(this.raw);
  }
}

export function toWebRequest(raw: RawRequest): Request {
  const headers = new Headers();
  const p = raw.headerPairs();
  let host = "localhost";
  for (let i = 0; i < p.length; i += 2) {
    headers.append(p[i], p[i + 1]);
    if (p[i] === "host") host = p[i + 1]; // names are lower-case: no second lookup through Headers
  }
  const noBody = raw.method === "GET" || raw.method === "HEAD";
  const stream = raw.bodyStream;
  const init: RequestInit & { duplex?: "half" } = {
    method: raw.method,
    headers,
    body: (stream ?? (noBody ? undefined : raw.body)) as
      BodyInit | null | undefined,
  };
  if (stream) init.duplex = "half"; // the body is a stream that is still arriving
  return new Request(
    `${raw.secure ? "https" : "http"}://${host}${raw.url}`,
    init,
  );
}

interface ParamRoute {
  segments: string[];
  handler: Handler;
}

function mergeSet(v: Result, s: SetState): Result {
  if (v instanceof Response || v instanceof Stream) return v; // status/headers of these are their own
  if (v instanceof FileReply) {
    const h: [string, string][] = Array.isArray(v.headers)
      ? [...v.headers]
      : Object.entries(v.headers ?? {});
    for (const k in s.headers) h.push([k, s.headers[k]]);
    return Object.assign(
      new FileReply(v.path, {
        status: s.status ?? v.status,
        headers: h,
        contentType: v.contentType ?? undefined,
        range: v.range,
      }),
    );
  }
  const r = toReply(v);
  const headers: [string, string][] = Array.isArray(r.headers)
    ? [...r.headers]
    : Object.entries(r.headers ?? {});
  for (const k in s.headers) headers.push([k, s.headers[k]]);
  return new Reply(r.body as Body, { status: s.status ?? r.status, headers });
}

export class Router {
  private exact = new Map<string, Map<string, Handler>>();
  private params = new Map<string, ParamRoute[]>();
  /** Constant routes, handed to the native side as static responses. */
  readonly statics: { method: string; path: string; value: Result }[] = [];
  fallback: ((raw: RawRequest) => Result | Promise<Result>) | null = null;
  /** WebSocket endpoints by exact path, and by prefix (a path registered with a trailing `*`). */
  readonly wsRoutes = new Map<string, WsHandlers<any>>();
  readonly wsPrefixes: [string, WsHandlers<any>][] = [];

  addWs(path: string, handlers: WsHandlers<any>): void {
    if (path.endsWith("*")) this.wsPrefixes.push([path.slice(0, -1), handlers]);
    else this.wsRoutes.set(path, handlers);
  }

  private matchWs(path: string): WsHandlers<any> | undefined {
    const exact = this.wsRoutes.get(path);
    if (exact) return exact;
    for (const [prefix, h] of this.wsPrefixes)
      if (path.startsWith(prefix)) return h;
    return undefined;
  }

  /** Runs a route's `upgrade` hook (if any) and turns its answer into an accepted upgrade or a refusal. */
  private upgradeRoute(
    raw: RawRequest,
    path: string,
    handlers: WsHandlers<any>,
  ): Result | Promise<Result> {
    const ctx = new Context(raw, path, EMPTY);
    const accept = (d: unknown): Result => {
      if (d === false) return new Reply("Upgrade refused", { status: 403 });
      if (d instanceof Reply || d instanceof Response) return d; // a refusal with its own status/headers
      const o: UpgradeOptions<any> =
        d && typeof d === "object" ? (d as UpgradeOptions<any>) : {};
      const offered =
        raw.header("sec-websocket-protocol")?.split(",")[0].trim() ?? "";
      return new UpgradeReply(handlers, {
        data: o.data !== undefined ? o.data : handlers.data?.(ctx),
        headers: o.headers,
        protocol: o.protocol ?? offered,
      });
    };
    const decision = handlers.upgrade ? handlers.upgrade(ctx) : true;
    return decision instanceof Promise
      ? decision.then(accept)
      : accept(decision);
  }

  add(method: string, path: string, value: RouteValue): void {
    const isParam = path.includes(":") || path.includes("*");
    if (
      typeof value !== "function" &&
      !isParam &&
      method !== "*" &&
      !(value instanceof FileReply)
    ) {
      this.statics.push({ method, path, value: value as Result });
      return;
    }
    const handler: Handler =
      typeof value === "function" ? (value as Handler) : () => value as Result;
    if (isParam) {
      const list = this.params.get(method) ?? [];
      list.push({ segments: path.split("/"), handler });
      this.params.set(method, list);
    } else {
      let m = this.exact.get(method);
      if (!m) this.exact.set(method, (m = new Map()));
      m.set(path, handler);
    }
  }

  /**
   * Constant routes the native side may answer by itself. A constant GET that shares its path with a dynamic HEAD
   * route stays in JS, so the HEAD route is not shadowed by the native HEAD-from-GET fallback.
   */
  nativeStatics(): { method: string; path: string; value: Result }[] {
    const head = this.exact.get("HEAD");
    if (!head) return this.statics;
    return this.statics.filter((st) => {
      if (st.method === "GET" && head.has(st.path)) {
        this.add("GET", st.path, () => st.value);
        return false;
      }
      return true;
    });
  }

  /** Routes with `:params` or `*`: a linear scan (exact routes are found in the maps before this runs). */
  private matchParams(
    method: string,
    path: string,
  ): { handler: Handler; params: Record<string, string> } | null {
    const parts = path.split("/");
    for (const list of [this.params.get(method), this.params.get("*")]) {
      if (!list) continue;
      for (const r of list) {
        const params = matchSegments(r.segments, parts);
        if (params) return { handler: r.handler, params };
      }
    }
    return null;
  }

  dispatch = (raw: RawRequest): Result | Promise<Result> => {
    const path = raw.path;
    if (raw.upgradeable) {
      const ws = this.matchWs(path);
      if (ws) return this.upgradeRoute(raw, path, ws);
    }
    let method = raw.method;
    let h = this.exact.get(method)?.get(path) ?? this.exact.get("*")?.get(path);
    let params = EMPTY;
    if (h === undefined && method === "HEAD") {
      // HEAD falls back to the GET route; the native side drops the body.
      method = "GET";
      h = this.exact.get("GET")?.get(path);
    }
    if (h === undefined) {
      const hit = this.params.size > 0 ? this.matchParams(method, path) : null;
      if (hit === null) {
        if (this.fallback) return this.fallback(raw);
        return new Reply(NOT_FOUND, { status: 404 });
      }
      h = hit.handler;
      params = hit.params;
    }
    // A handler that declares no parameter cannot use the context, so none is built.
    if (h.length === 0) return (h as () => Result | Promise<Result>)();
    const ctx = new Context(raw, path, params);
    const out = h(ctx);
    if (out instanceof Promise) {
      return out.then((v) => {
        const s = ctx.touchedSet;
        return s === null ? v : mergeSet(v, s);
      });
    }
    const s = ctx.touchedSet;
    return s === null ? out : mergeSet(out, s);
  };
}

const EMPTY: Record<string, string> = Object.freeze({}) as Record<
  string,
  string
>;

function matchSegments(
  pattern: string[],
  parts: string[],
): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const p = pattern[i];
    if (p === "*") {
      params["*"] = parts.slice(i).join("/");
      return params;
    }
    if (i >= parts.length) return null;
    if (p.startsWith(":")) params[p.slice(1)] = decodeURIComponent(parts[i]);
    else if (p !== parts[i]) return null;
  }
  return pattern.length === parts.length ? params : null;
}
