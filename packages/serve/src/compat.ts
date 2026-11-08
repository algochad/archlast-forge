/**
 * A `Bun.serve`-shaped front for the engine, so code written against `Bun.serve` (Forge's server) can run on it
 * unchanged: `fetch(req, server)`, `routes`, `error`, `websocket` handlers and the `Server` object.
 *
 * It runs on one JS thread (handlers keep their single-threaded assumptions); the Rust side still does all the I/O
 * on its own threads.
 *
 * HTML bundle routes are built in-process with `Bun.build` and served natively; `development` adds file watching,
 * live reload and console forwarding over the engine's own WebSocket (see bundle.ts).
 */
import type { BackendName } from "./backend.ts";
import { type RawRequest } from "./codec.ts";
import {
  directoryHandler,
  isDirectoryRoute,
  type DirectoryRoute,
} from "./dir.ts";
import { FileReply } from "./file.ts";
import { type ListenOptions, listen } from "./index.ts";
import { Router, toWebRequest } from "./router.ts";
import { Reply, type Server, TemplateReply } from "./server.ts";
import { UpgradeReply, type WebSocket, type WsHandlers } from "./websocket.ts";
import type { TlsOptions } from "./tls.ts";
import type { PerMessageDeflate } from "./deflate.ts";
import { bodyless, inferContentType } from "./mime.ts";
import {
  BundleHost,
  DEV,
  DEV_TOPIC,
  type DevelopmentOption,
  isHtmlBundle,
  printBrowserConsole,
} from "./bundle.ts";

export type CompatSocket<D> = WebSocket<D> & { data: D };
type Msg = string | Buffer | ArrayBuffer | Uint8Array | Blob;

export interface CompatWebSocketHandler<D> {
  /** Type hint for `ws.data` (not read at runtime). */
  data?: D;
  open?(ws: CompatSocket<D>): void | Promise<void>;
  /** Text arrives as a string, binary as `ws.binaryType` says (default Buffer, like Bun). */
  message?(ws: CompatSocket<D>, message: Msg): void | Promise<void>;
  drain?(ws: CompatSocket<D>): void | Promise<void>;
  close?(
    ws: CompatSocket<D>,
    code: number,
    reason: string,
  ): void | Promise<void>;
  ping?(ws: CompatSocket<D>, data: Buffer): void | Promise<void>;
  pong?(ws: CompatSocket<D>, data: Buffer): void | Promise<void>;
  error?(error: Error, ws: CompatSocket<D>): void | Promise<void>;
  /** Messages larger than this close the socket with 1009. Default 16 MiB. */
  maxPayloadLength?: number;
  /** Bytes queued for a socket before `send` reports backpressure (or the socket is dropped). Default 4 MiB. */
  backpressureLimit?: number;
  /** Drop the client at the limit (default false, like Bun: `send` returns -1 and `drain` follows). */
  closeOnBackpressureLimit?: boolean;
  /** Seconds without traffic or pongs before the socket is closed. Default 120. */
  idleTimeout?: number;
  /** Send transport pings (default true). */
  sendPings?: boolean;
  /** Whether `ws.publish` also reaches the sender (default false). */
  publishToSelf?: boolean;
  /**
   * permessage-deflate: `true` (each message compressed on its own), or `{ compress: "dedicated" | "3KB" … "256KB" }` for a
   * per-socket context. Messages under 64 bytes are never compressed; the per-call `compress` argument of `send` is
   * accepted but the size rule decides.
   */
  perMessageDeflate?: PerMessageDeflate;
}

/** A `Request` with the extras Bun adds to requests matched by `routes`. */
export type BunRequest = Request & {
  readonly params: Record<string, string>;
  readonly cookies: Bun.CookieMap;
};
type Handler<D> = (
  req: BunRequest,
  server: CompatServer<D>,
) => Response | undefined | void | Promise<Response | undefined | void>;
type MethodMap<D> = Partial<
  Record<string, Handler<D> | Response | Blob | false>
>;
export type CompatRoutes<D> = Record<
  string,
  | Response
  | Blob
  | false
  | Handler<D>
  | MethodMap<D>
  | Bun.HTMLBundle
  | DirectoryRoute
>;

export interface CompatOptions<D = undefined> {
  port?: number;
  hostname?: string;
  /** Serve HTTPS (PEM `key`/`cert`, optional `ca`, `serverName` for SNI, an array for several certificates, `requestCert` for mutual TLS). */
  tls?: TlsOptions | TlsOptions[];
  /** Listen on a unix-domain socket instead of a TCP port. */
  unix?: string;
  reusePort?: boolean;
  ipv6Only?: boolean;
  /** Negotiate HTTP/2 on HTTPS connections (default true). */
  http2?: boolean;
  /** Latency mode, see `ListenOptions.spinMicros` (default 30; 0 = off). */
  spinMicros?: number;
  spinMaxConnections?: number;
  /** Largest request body in bytes; larger ones get a 413. Bodies above 256 KiB are streamed to the handler. */
  maxRequestBodySize?: number;
  /** Seconds a connection may stay silent (default 10, like Bun; 0 = never). */
  idleTimeout?: number;
  /** `true` / `{ hmr, console }` turns on the bundler's dev server for HTML bundle routes (HMR, browser console forwarding). */
  development?: DevelopmentOption;
  id?: string | null;
  /**
   * Matched before `fetch`: exact paths, `:param` segments (`req.params`), trailing-`*` wildcards, method maps,
   * static `Response`s (served with an ETag, 304 on revalidation), `BunFile`s (streamed natively with ranges),
   * `false` (matches nothing, falls through to `fetch`).
   */
  routes?: CompatRoutes<D>;
  fetch?(
    req: Request,
    server: CompatServer<D>,
  ): Response | undefined | Promise<Response | undefined>;
  /** Turns an exception from a handler into a response. */
  error?(
    err: unknown,
  ): Response | undefined | void | Promise<Response | undefined | void>;
  websocket?: CompatWebSocketHandler<D>;
  backend?: BackendName;
  /** Rust I/O threads (see ListenOptions.threads). */
  threads?: number;
}

export interface CompatServer<D = undefined> {
  readonly port: number;
  readonly hostname: string;
  readonly url: URL;
  readonly protocol: "http" | "https";
  /** The unix-domain socket path, when listening on one. */
  readonly unix?: string;
  readonly id: string | null;
  readonly development: boolean;
  /** Requests handed to a handler that have not been answered yet. */
  readonly pendingRequests: number;
  readonly pendingWebSockets: number;
  /** Accepts the upgrade of `req` (which must be a WebSocket handshake); `fetch` should then return undefined. */
  upgrade(req: Request, options?: { data?: D; headers?: HeadersInit }): boolean;
  requestIP(
    req: Request,
  ): { address: string; family: "IPv4" | "IPv6"; port: number } | null;
  /** Overrides the idle timeout of this request's connection until it completes (0 disables it). */
  timeout(req: Request, seconds: number): void;
  /** `true` drops everything now; otherwise stops accepting and lets requests in flight finish (10 s at most). */
  stop(closeActiveConnections?: boolean): Promise<void>;
  /** Closes keep-alive connections that have no request in flight; returns how many. */
  closeIdleConnections(): number;
  /** Swaps `fetch`, `routes`, `error` and `websocket` handlers without restarting. */
  reload(
    options: Pick<CompatOptions<D>, "fetch" | "routes" | "error" | "websocket">,
  ): CompatServer<D>;
  /** Runs a request through the handlers in-process (no network); WebSocket upgrades are not possible this way. */
  fetch(request: Request | string): Promise<Response>;
  publish(
    topic: string,
    data: string | ArrayBufferView | ArrayBuffer | SharedArrayBuffer | Blob,
    compress?: boolean,
  ): number;
  subscriberCount(topic: string): number;
  /** Drops the responses kept for handlers that sent `x-archlast-cache` (see `cacheHeader`): those with one of `tags`, or all of them. */
  purgeCache(tags?: string[]): void;
  ref(): void;
  unref(): void;
  [Symbol.dispose](): void;
  /** The engine's own server object (sockets by id, backend, ...). */
  readonly engine: Server;
}

interface Entry<D> {
  /** For a static `Response(Bun.file())`: the native file response to repeat (null: not a file). */
  file?: FileReply | null;
  static?: {
    status: number;
    headers: [string, string][];
    body: Uint8Array;
    etag: string;
  };
  value: Handler<D> | Response | Blob;
}
interface CompiledRoute<D> {
  pattern: string;
  /** Path segments of a pattern with `:params` (and, with `wildcard`, the segments before the `*`). */
  segments: string[] | null;
  /** For a pattern ending in `*`: the text before it. */
  wildcardPrefix: string | null;
  methods: Map<string, Entry<D>> | null; // null: `any` holds the value
  any: Entry<D> | null;
  /** `false` in the routes: matches this path and sends it to `fetch` without trying the other routes. */
  skip: boolean;
}

/** `decodeURIComponent` that turns invalid escapes into U+FFFD instead of throwing, like Bun. */
function safeDecode(s: string): string {
  if (!s.includes("%")) return s;
  try {
    return decodeURIComponent(s);
  } catch {
    const bytes: number[] = [];
    for (let i = 0; i < s.length; i++) {
      if (s[i] === "%" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
        bytes.push(parseInt(s.slice(i + 1, i + 3), 16));
        i += 2;
      } else bytes.push(...Buffer.from(s[i]));
    }
    return new TextDecoder().decode(new Uint8Array(bytes));
  }
}

function compileRoutes<D>(
  routes: CompatRoutes<D>,
  bundleHandler: (pattern: string) => Handler<D>,
): {
  exact: Map<string, CompiledRoute<D>>;
  params: CompiledRoute<D>[];
  wild: CompiledRoute<D>[];
} {
  const exact = new Map<string, CompiledRoute<D>>();
  const params: CompiledRoute<D>[] = [];
  const wild: CompiledRoute<D>[] = [];
  for (const [pattern, raw] of Object.entries(routes)) {
    const c: CompiledRoute<D> = {
      pattern,
      segments: null,
      wildcardPrefix: null,
      methods: null,
      any: null,
      skip: raw === false,
    };
    if (raw !== false) {
      // An HTML bundle is answered by the engine's bundler; the route only has to match.
      const value = isHtmlBundle(raw)
        ? bundleHandler(pattern)
        : isDirectoryRoute(raw)
          ? (directoryHandler(pattern, raw) as unknown as Handler<D>)
          : raw;
      const isMap =
        typeof value === "object" &&
        !(value instanceof Response) &&
        !(value instanceof Blob) &&
        value !== null;
      if (isMap) {
        c.methods = new Map();
        for (const [m, v] of Object.entries(value as MethodMap<D>))
          if (v !== false && v !== undefined)
            c.methods.set(m.toUpperCase(), { value: v });
      } else {
        if (
          value instanceof Blob &&
          !(value instanceof Response) &&
          typeof (value as Blob & { name?: unknown }).name !== "string"
        ) {
          throw new TypeError(
            `route ${pattern}: a Blob that is not a Bun.file() cannot be served; wrap it in a Response`,
          );
        }
        if (
          typeof value !== "function" &&
          !(value instanceof Response) &&
          !(value instanceof Blob)
        )
          throw new TypeError(
            `route ${pattern}: expected a function, a Response, a BunFile or a method map`,
          );
        c.any = { value: value as Entry<D>["value"] };
      }
    }
    const star = pattern.indexOf("*");
    if (star !== -1) {
      c.wildcardPrefix = pattern.slice(0, star);
      if (c.wildcardPrefix.includes(":"))
        c.segments = c.wildcardPrefix.split("/");
      wild.push(c);
    } else if (pattern.includes(":")) {
      c.segments = pattern.split("/");
      params.push(c);
    } else {
      exact.set(pattern, c); // "/a" and "/a/" are different routes
    }
  }
  params.sort(
    (a, b) =>
      b.segments!.filter((s) => !s.startsWith(":")).length -
      a.segments!.filter((s) => !s.startsWith(":")).length,
  );
  wild.sort((a, b) => b.wildcardPrefix!.length - a.wildcardPrefix!.length);
  return { exact, params, wild };
}

type Match<D> =
  { entry: Entry<D>; params: Record<string, string> } | { skip: true } | null;

function matchPath<D>(
  table: ReturnType<typeof compileRoutes<D>>,
  path: string,
  method: string,
): Match<D> {
  const pick = (c: CompiledRoute<D>) =>
    c.any
      ? c.any
      : (c.methods!.get(method) ??
        (method === "HEAD" ? c.methods!.get("GET") : undefined) ??
        null);
  const e = table.exact.get(path);
  if (e) {
    if (e.skip) return { skip: true };
    const entry = pick(e);
    if (entry) return { entry, params: {} };
  }
  if (table.params.length > 0) {
    const parts = path.split("/");
    for (const c of table.params) {
      const seg = c.segments!;
      if (seg.length !== parts.length) continue;
      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < seg.length && ok; i++) {
        if (seg[i].startsWith(":"))
          params[seg[i].slice(1)] = safeDecode(parts[i]);
        else ok = seg[i] === parts[i];
      }
      const entry = ok ? pick(c) : null;
      if (entry) return { entry, params };
    }
  }
  for (const c of table.wild) {
    if (!path.startsWith(c.wildcardPrefix!)) {
      if (!c.segments) continue;
    }
    let params: Record<string, string> = {};
    if (c.segments) {
      // `/z/:a/*`: the segments before the star may be parameters.
      const seg = c.segments,
        parts = path.split("/");
      if (parts.length < seg.length) continue;
      let ok = true;
      for (let i = 0; i < seg.length - 1 && ok; i++) {
        if (seg[i].startsWith(":"))
          params[seg[i].slice(1)] = safeDecode(parts[i]);
        else ok = seg[i] === parts[i];
      }
      if (!ok || !parts[seg.length - 1].startsWith(seg[seg.length - 1]))
        continue;
    }
    if (c.skip) return { skip: true };
    const entry = pick(c);
    if (entry) return { entry, params };
  }
  return null;
}

/** Cookie jars handed out as `req.cookies`: what a handler set on one goes out as Set-Cookie. */
const jars = new WeakMap<Request, Bun.CookieMap>();

function asBunRequest(
  req: Request,
  params: Record<string, string>,
): BunRequest {
  Object.defineProperty(req, "params", {
    value: params,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(req, "cookies", {
    get: () => {
      let jar = jars.get(req);
      if (!jar)
        jars.set(
          req,
          (jar = new Bun.CookieMap(req.headers.get("cookie") ?? "")),
        );
      return jar;
    },
    enumerable: false,
    configurable: true,
  });
  return req as BunRequest;
}

/** Appends the cookies a handler set on `req.cookies` to its response. */
function withCookies<T extends Response | Reply | FileReply | UpgradeReply>(
  req: Request,
  out: T,
): T {
  const jar = jars.get(req);
  if (!jar) return out;
  const set = (
    jar as unknown as { toSetCookieHeaders(): string[] }
  ).toSetCookieHeaders();
  if (set.length === 0) return out;
  if (out instanceof Response) {
    try {
      for (const c of set) out.headers.append("set-cookie", c);
      return out;
    } catch {
      const copy = new Response(out.body, out); // an immutable Response (one fetch() returned)
      for (const c of set) copy.headers.append("set-cookie", c);
      return copy as T;
    }
  }
  if (out instanceof Reply) {
    const h: [string, string][] = Array.isArray(out.headers)
      ? [...out.headers]
      : Object.entries(out.headers ?? {});
    for (const c of set) h.push(["set-cookie", c]);
    return new Reply(out.body, { status: out.status, headers: h }) as T;
  }
  return out;
}

const NOT_A_RESPONSE = "Expected a Response object, but received";

/** Bun's checks on `Bun.serve` options. */
function validateOptions(opts: CompatOptions<any>): void {
  if (
    opts.fetch === undefined &&
    opts.routes === undefined &&
    opts.websocket === undefined
  ) {
    throw new TypeError(
      'Bun.serve() needs either:\n\n  - A routes object:\n     Bun.serve({\n       routes: {\n         "/path": Response.json({ hi: 1 })\n       }\n     })\n\n  - Or a fetch handler:\n     Bun.serve({\n       fetch(req) {\n         return new Response("Hello World")\n       }\n     })',
    );
  }
  if (opts.fetch !== undefined && typeof opts.fetch !== "function")
    throw new TypeError("Expected fetch() to be a function");
  if (opts.error !== undefined && typeof opts.error !== "function")
    throw new TypeError("Expected error() to be a function");
  if (
    opts.idleTimeout !== undefined &&
    (!Number.isInteger(opts.idleTimeout) ||
      opts.idleTimeout < 0 ||
      opts.idleTimeout > 255)
  ) {
    throw new TypeError(
      "idleTimeout must be an integer between 0 and 255 seconds",
    );
  }
  if (
    opts.port !== undefined &&
    (!Number.isInteger(Number(opts.port)) ||
      Number(opts.port) < 0 ||
      Number(opts.port) > 65535)
  ) {
    throw new RangeError(
      `port must be an integer between 0 and 65535, got ${String(opts.port)}`,
    );
  }
  if (opts.unix !== undefined && opts.hostname !== undefined)
    throw new TypeError("Cannot specify both hostname and unix");
}

/** The port when none is given: BUN_PORT, PORT, NODE_PORT, else 3000 (as Bun does). */
function defaultPort(): number {
  for (const v of [
    process.env.BUN_PORT,
    process.env.PORT,
    process.env.NODE_PORT,
  ]) {
    const n = v === undefined || v === "" ? NaN : Number(v);
    if (Number.isInteger(n) && n >= 0 && n <= 65535) return n;
  }
  return 3000;
}

export function serveCompat<D = undefined>(
  opts: CompatOptions<D>,
): CompatServer<D> {
  validateOptions(opts);
  const router = new Router();
  const requests = new WeakMap<Request, RawRequest>();
  let engine: Server;
  const bundles = new BundleHost(opts.development, {
    publish: (topic, data) => engine.publish(topic, data),
  });
  const bundleHandler = (pattern: string) =>
    (async (req: Request) => {
      if (bundles.pending) await bundles.pending;
      return bundles.page(pattern, req);
    }) as unknown as Handler<D>;
  /** Compiles `routes`, handing the HTML bundles in them to the private bundler server. */
  const syncBundles = (routes: CompatRoutes<D>) => {
    const html: Record<string, unknown> = {};
    for (const [pattern, v] of Object.entries(routes))
      if (isHtmlBundle(v)) html[pattern] = v;
    bundles.setRoutes(html);
    return compileRoutes<D>(routes, bundleHandler);
  };
  let cfg = {
    fetch: opts.fetch,
    error: opts.error,
    ws: opts.websocket ?? {},
    table: syncBundles(opts.routes ?? {}),
  };

  // One handler object for every socket; it reads the current config, so `reload()` takes effect at once.
  const handlers: WsHandlers<D> = {
    open: (ws) => {
      if (ws.data === DEV) return void ws.subscribe(DEV_TOPIC);
      ws.binaryType = "nodebuffer"; // Bun's default
      return cfg.ws.open?.(ws as CompatSocket<D>);
    },
    message: (ws, m) =>
      ws.data === DEV
        ? printBrowserConsole(m as string | Uint8Array)
        : cfg.ws.message?.(ws as CompatSocket<D>, m as Msg),
    drain: (ws) =>
      ws.data === DEV ? undefined : cfg.ws.drain?.(ws as CompatSocket<D>),
    close: (ws, code, reason) =>
      ws.data === DEV
        ? undefined
        : cfg.ws.close?.(ws as CompatSocket<D>, code, reason),
    ping: (ws, data) =>
      ws.data === DEV ? undefined : cfg.ws.ping?.(ws as CompatSocket<D>, data),
    pong: (ws, data) =>
      ws.data === DEV ? undefined : cfg.ws.pong?.(ws as CompatSocket<D>, data),
    error: (err, ws) =>
      cfg.ws.error
        ? cfg.ws.error(err, ws as CompatSocket<D>)
        : void console.error(err),
  };

  const serveStatic = async (
    res: Response,
    entry: Entry<D>,
    req: Request,
  ): Promise<Response | Reply | FileReply> => {
    if (entry.file === undefined) entry.file = asFile(res);
    if (entry.file)
      return new FileReply(entry.file.path, {
        status: entry.file.status,
        headers: entry.file.headers ?? undefined,
        contentType: entry.file.contentType ?? undefined,
      });
    if (!entry.static) {
      const body = new Uint8Array(await res.clone().arrayBuffer());
      const headers: [string, string][] = [];
      res.headers.forEach((v, k) => headers.push([k, v]));
      const etag =
        res.headers.get("etag") ?? `"${Bun.hash(body).toString(16)}"`;
      if (
        body.length > 0 &&
        !bodyless(res.status) &&
        !res.headers.has("content-type")
      )
        headers.push(["content-type", inferContentType(body)]);
      entry.static = { status: res.status, headers, body, etag };
    }
    const st = entry.static;
    const inm = req.headers.get("if-none-match");
    if (
      st.status === 200 &&
      inm &&
      inm
        .split(",")
        .some(
          (t) => t.trim().replace(/^W\//, "") === st.etag.replace(/^W\//, ""),
        )
    )
      return new Reply(null, { status: 304, headers: [["etag", st.etag]] });
    const headers = st.headers.some(([k]) => k === "etag")
      ? st.headers
      : [...st.headers, ["etag", st.etag] as [string, string]];
    return new Reply(st.body.length === 0 ? null : st.body, {
      status: st.status,
      headers,
    });
  };

  const isDev =
    typeof opts.development === "object"
      ? true
      : (opts.development ?? process.env.NODE_ENV !== "production");
  const escapeHtml = (t: string) =>
    t.replace(
      /[&<>"]/g,
      (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
    );

  /** What a client gets when nothing handled an exception: Bun's text in production, the message and stack in development. */
  const defaultError = (err: unknown): Reply => {
    console.error(err);
    if (!isDev)
      return new Reply("Something went wrong!", {
        status: 500,
        headers: [["content-type", "text/plain;charset=utf-8"]],
      });
    const e = err instanceof Error ? err : new Error(String(err));
    const page = `<!doctype html><meta charset="utf-8"><title>${escapeHtml(e.name)}</title><body style="font:14px ui-monospace,monospace;padding:24px"><h2>${escapeHtml(e.name)}: ${escapeHtml(e.message)}</h2><pre>${escapeHtml(e.stack ?? "")}</pre>`;
    return new Reply(page, {
      status: 500,
      headers: [["content-type", "text/html;charset=utf-8"]],
    });
  };

  /**
   * A static route value `new Response(Bun.file(path))` is served by the engine itself (length, Range, validators,
   * read from disk per request). The body is told from a stream by asking a clone for its blob: for a file that is
   * answered at once and names the path. Only route values are asked, because they are finite by definition; a
   * handler's Response could be a stream, and asking would read the stream through.
   */
  const asFile = (res: Response): FileReply | null => {
    if (res.body === null || res.bodyUsed) return null;
    let blobPromise: Promise<Blob>;
    try {
      blobPromise = res.clone().blob();
    } catch {
      return null;
    }
    const peeked = Bun.peek(blobPromise);
    if (peeked instanceof Promise) {
      blobPromise.catch(() => {});
      return null;
    }
    const b = peeked as Blob & { name?: unknown };
    if (typeof b.name !== "string" || b.name === "") return null;
    if (Bun.file(b.name).size !== b.size) return null; // a slice of a file: not representable natively
    const headers: [string, string][] = [];
    res.headers.forEach((v, k) => headers.push([k, v]));
    return new FileReply(b.name, {
      status: res.status,
      headers,
      contentType: res.headers.get("content-type") ?? undefined,
    });
  };

  /** A handler's return value, checked the way Bun does. */
  const checked = (
    out: unknown,
    req: Request,
  ): Response | Reply | FileReply | UpgradeReply => {
    if (out instanceof Response) {
      if (out.type === "error" || out.status === 0)
        throw new Error(
          "Cannot send a Response with status 0: Response.error() is not a response that can be sent",
        );
      return withCookies(req, out);
    }
    if (out instanceof TemplateReply) return out as unknown as Reply; // printed by the engine; cookies set on req.cookies do not apply to it
    if (
      out instanceof Reply ||
      out instanceof FileReply ||
      out instanceof UpgradeReply
    )
      return withCookies(req, out);
    console.error(`${NOT_A_RESPONSE} '${out === null ? "null" : typeof out}'`);
    return isDev
      ? new Reply("Welcome to Bun! To get started, return a Response object.", {
          status: 200,
          headers: [["content-type", "text/plain;charset=utf-8"]],
        })
      : new Reply(null, { status: 204 });
  };

  const respond = async (
    req: Request,
    raw: RawRequest | null,
  ): Promise<Response | Reply | FileReply | UpgradeReply | undefined> => {
    try {
      // The engine already has the path; parsing the whole URL for it is a measurable cost per request.
      const pathname = raw
        ? raw.url.slice(0, (raw.url.indexOf("?") + 1 || raw.url.length + 1) - 1)
        : new URL(req.url).pathname;
      const hit = matchPath(cfg.table, pathname, req.method);
      if (hit && "entry" in hit) {
        const v = hit.entry.value;
        if (v instanceof Response) return await serveStatic(v, hit.entry, req);
        if (typeof v !== "function")
          return new FileReply((v as Blob & { name: string }).name); // a BunFile
        const out = await (
          v as (this: unknown, ...a: unknown[]) => unknown
        ).call(server, asBunRequest(req, hit.params), server);
        if (raw?.accepted) return acceptedUpgrade(raw);
        if (out !== undefined) return checked(out, req);
      }
      if (!hit || !("skip" in hit)) {
        if (bundles.active) {
          const url = { pathname };
          // The dev server's WebSocket (live reload, console): an ordinary engine socket on a shared topic.
          if (raw?.upgradeable && bundles.isDevSocket(url.pathname)) {
            raw.accepted = { handlers, data: DEV };
            return acceptedUpgrade(raw);
          }
          if (bundles.pending) await bundles.pending;
          const owned = bundles.asset(url.pathname, req);
          if (owned) return owned;
        }
      }
      if (!cfg.fetch) return new Reply("Not Found", { status: 404 });
      const res = await (
        cfg.fetch as (this: unknown, ...a: unknown[]) => unknown
      ).call(server, asBunRequest(req, {}), server);
      if (raw?.accepted) return acceptedUpgrade(raw);
      return checked(res, req);
    } catch (err) {
      if (cfg.error) {
        try {
          const r = await (
            cfg.error as (this: unknown, e: unknown) => unknown
          ).call(server, err);
          if (r instanceof Response) return withCookies(req, r);
        } catch (inner) {
          return defaultError(inner);
        }
      }
      return defaultError(err);
    }
  };
  const acceptedUpgrade = (raw: RawRequest) =>
    new UpgradeReply(handlers, {
      data: raw.accepted!.data,
      headers: raw.accepted!.headers,
      protocol: raw.accepted!.protocol,
    });

  const server: CompatServer<D> = {
    get port() {
      return engine.port;
    },
    get hostname() {
      return engine.hostname;
    },
    get url() {
      if (engine.unix) return new URL(`unix://${engine.unix}`);
      return new URL(
        `${server.protocol}://${engine.hostname.includes(":") ? `[${engine.hostname}]` : engine.hostname}:${engine.port}/`,
      );
    },
    get protocol() {
      return engine.protocol;
    },
    get unix() {
      return engine.unix;
    },
    id: opts.id ?? null,
    development: isDev,
    get pendingRequests() {
      return engine.pendingRequests;
    },
    get pendingWebSockets() {
      return engine.pendingWebSockets;
    },
    upgrade(req, options) {
      const raw = requests.get(req);
      if (!raw || !raw.upgradeable || raw.accepted) return false; // not an upgrade request, or already upgraded
      // Any HeadersInit (Headers, array, record). Bun echoes the first subprotocol the client offered unless the
      // headers name one.
      const given = options?.headers ? new Headers(options.headers) : null;
      const chosen =
        given?.get("sec-websocket-protocol") ??
        req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
      given?.delete("sec-websocket-protocol");
      raw.accepted = {
        handlers,
        data: options?.data,
        headers: given ? ([...given] as [string, string][]) : undefined,
        protocol: chosen || undefined,
      };
      return true;
    },
    requestIP(req) {
      const raw = requests.get(req);
      const address = raw?.ip;
      if (!raw || address == null) return null;
      return {
        address,
        family: raw.ipKind === 4 ? "IPv4" : "IPv6",
        port: raw.port ?? 0,
      };
    },
    timeout(req, seconds) {
      requests.get(req)?.setTimeout(seconds);
    },
    stop(closeActive = false) {
      if (closeActive) {
        engine.stop();
        bundles.stop();
        return Promise.resolve();
      }
      return engine.close({ timeoutMs: 10_000 }).finally(() => bundles.stop());
    },
    closeIdleConnections: () => engine.closeIdleConnections(),
    reload(o) {
      cfg = {
        fetch: o.fetch ?? cfg.fetch,
        error: o.error ?? cfg.error,
        ws: o.websocket ?? cfg.ws,
        table: o.routes ? syncBundles(o.routes) : cfg.table,
      };
      return server;
    },
    async fetch(request) {
      const req = typeof request === "string" ? new Request(request) : request;
      const out = await respond(req, null);
      if (out instanceof Response) return out;
      if (out instanceof Reply)
        return new Response(out.body as BodyInit | null, {
          status: out.status,
          headers: out.headers as HeadersInit | undefined,
        });
      return new Response("Not Found", { status: 404 });
    },
    publish(topic, data) {
      const bytes =
        typeof data === "string"
          ? data
          : data instanceof Blob
            ? new Uint8Array()
            : data instanceof ArrayBuffer || data instanceof SharedArrayBuffer
              ? new Uint8Array(data)
              : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      if (engine.subscriberCount(topic) === 0) return 0;
      engine.publish(topic, bytes);
      return typeof bytes === "string"
        ? Buffer.byteLength(bytes)
        : bytes.length;
    },
    subscriberCount: (topic) => engine.subscriberCount(topic),
    purgeCache: (tags) => engine.purgeCache(tags),
    ref: () => engine.ref(),
    unref: () => engine.unref(),
    [Symbol.dispose]() {
      void server.stop(true);
    },
    get engine() {
      return engine;
    },
  };

  router.fallback = async (raw) => {
    let req: Request;
    try {
      req = toWebRequest(raw);
    } catch {
      return new Reply("Bad Request", { status: 400 });
    }
    requests.set(req, raw);
    let signal: AbortSignal | undefined;
    Object.defineProperty(req, "signal", {
      get: () => (signal ??= raw.signal),
      configurable: true,
    }); // aborts when the client leaves
    return (await respond(req, raw)) as never;
  };

  const ws = opts.websocket ?? {};
  const listenOpts: ListenOptions & { error?: (e: unknown) => void } = {
    port: opts.unix !== undefined ? 0 : Number(opts.port ?? defaultPort()),
    hostname: opts.hostname,
    tls: opts.tls,
    unix: opts.unix,
    reusePort: opts.reusePort,
    ipv6Only: opts.ipv6Only,
    http2: opts.http2,
    spinMicros: opts.spinMicros,
    spinMaxConnections: opts.spinMaxConnections,
    backend: opts.backend,
    threads: opts.threads,
    workers: 1,
    maxRequestBodySize: opts.maxRequestBodySize,
    idleTimeout: opts.idleTimeout ?? 10,
    wsIdleTimeout: ws.idleTimeout ?? 120,
    wsMaxPayload: ws.maxPayloadLength,
    wsBackpressureLimit: ws.backpressureLimit ?? 16 * 1024 * 1024,
    wsCloseOnBackpressureLimit: ws.closeOnBackpressureLimit ?? false,
    wsPublishToSelf: ws.publishToSelf ?? false,
    wsPerMessageDeflate: ws.perMessageDeflate,
    wsPingInterval: ws.sendPings === false ? 0 : 30,
    wsAny: true,
    error: () => {},
  };
  try {
    engine = listen(router, listenOpts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (/in use|bind/i.test(msg)) {
      throw Object.assign(
        new Error(`Failed to start server. Is port ${listenOpts.port} in use?`),
        { code: "EADDRINUSE", syscall: "listen", errno: 98 },
      );
    }
    throw e;
  }
  return server;
}
