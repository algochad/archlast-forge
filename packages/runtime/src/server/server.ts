import type { HTMLBundle, Server, ServerWebSocket } from "bun";
import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { buildAdminApi } from "./admin-api";
import { KEY_ADMIN, type AdminInfo } from "./admin-ops";
import { CLIENT_IP_HEADER } from "./auth";
import { connectRedis, MemoryBus, RedisBus, type Bus } from "./bus";
import { MemoryCache, RedisCache } from "./cache";
import { loadConfig, type Config } from "./config";
import { ForgeError } from "../errors";
import type { FunctionKind, UserIdentity } from "../functions";
import type { CallHeaders, LogEntry } from "./executor";
import { log, setLogFormat } from "./logger";
import { Metrics } from "./metrics";
import type { Manifest } from "./project";
import { toPublicError } from "./public-error";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit";
import { buildRpc, errorResponse, type Rpc, type SocketData } from "./rpc";
import { FunctionRuntime } from "./runtime";
import { QueryRunner, SubscriptionManager } from "./subscriptions";
import { Tracer } from "./tracing";

/** A frontend the engine serves next to the API (framework mode). */
export interface AppHost {
  /**
   * Called for requests the engine has no route for: everything except /rpc, /api/auth, /http, /_admin, /_dashboard, /_cli,
   * /health, /ready and /metrics. Return undefined for the plain 404.
   */
  fetch(req: Request, env: AppEnv): Response | undefined | Promise<Response | undefined>;
  dispose?(): void | Promise<void>;
}

/** What an app host may do for one request. */
export interface AppEnv {
  requestId: string;
  dev: boolean;
  /** The caller's cookie and authorization headers, as functions see them. */
  headers: CallHeaders;
  /** Runs a public function in this process as the caller; queries go through the query cache. Fails like a client call: a ForgeError for ForgeErrors, else an Error with the public message. */
  call(name: string, kind: FunctionKind, args?: unknown): Promise<unknown>;
  /** The signed-in user, or null. */
  identity(): Promise<UserIdentity | null>;
  /** Seconds the caller must wait when over its rate limit, otherwise null. Pages call it before doing real work. */
  rateLimited(): Promise<number | null>;
  /** Long-lived responses (server-sent events) must opt out of the idle timeout. */
  keepAlive(): void;
}

export interface ServerOptions {
  forgeDir: string;
  dev?: boolean;
  env?: Record<string, string | undefined>;
  /** Bun HTML import of the dashboard, served at /_dashboard when enabled. */
  dashboard?: HTMLBundle;
  /** A frontend served for every path the engine doesn't own. */
  app?: AppHost;
}

export interface RunningServer {
  url: string;
  config: Config;
  runtime: FunctionRuntime;
  /** Restarts only the function runtime; HTTP/WS stay up and subscriptions re-run. */
  reload(): Promise<Manifest>;
  /** Graceful: stops accepting work, drains in-flight requests, asks clients to reconnect elsewhere. */
  stop(opts?: { graceful?: boolean }): Promise<void>;
}

const pickAuthHeaders = (get: (name: string) => string | null | undefined): CallHeaders => {
  const h: CallHeaders = {};
  for (const name of ["cookie", "authorization"]) {
    const value = get(name);
    if (value) h[name] = value;
  }
  return h;
};

const REQUEST_ID = /^[\w.-]{1,64}$/;
// Ids for requests that bring none: a random prefix per process and a counter, which costs far less than a UUID per request.
const idPrefix = crypto.randomUUID().slice(0, 8);
let idCount = 0;
const requestIdOf = (given: string | null | undefined) => (given && REQUEST_ID.test(given) ? given : `${idPrefix}-${(++idCount).toString(36)}`);

/**
 * The client address a trusted proxy saw. A proxy appends the address it got the request from, so the last entry is the one to believe:
 * the entries before it are whatever the client (or earlier hops) chose to send. A proxy that replaces the header leaves one entry.
 */
const lastForwarded = (header: string | null | undefined) => header?.split(",").at(-1)?.trim() || undefined;

const cookieValue = (cookie: string | null, name: string) =>
  cookie
    ?.split(";")
    .map((c) => c.trim().split("="))
    .find(([k]) => k === name)?.[1];

const sameSecret = (a: string, b: string) => {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};

/** Startup order: config → bus/cache → Bun.serve → function runtime (DB, migrations, modules, auth) → router. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const dev = opts.dev ?? false;
  const config = loadConfig(env, dev);
  setLogFormat(config.logFormat);
  const serverId = `${hostname()}:${process.pid}`;
  const ttl = config.cacheTtlMs;
  const bus: Bus = config.redisUrl ? await RedisBus.connect(config.redisUrl, { broadcastAll: ttl > 0 }) : new MemoryBus();
  const cache = ttl > 0 ? (config.redisUrl ? await RedisCache.connect(config.redisUrl) : new MemoryCache(10_000, config.cacheMaxBytes)) : undefined;
  const limiter: RateLimiter = config.redisUrl ? new RedisRateLimiter(await connectRedis(config.redisUrl), "archlast-forge:rl:") : new MemoryRateLimiter();

  const runtimeEnv = { ...env }; // gets the bound URL before the runtime starts
  const runtime = new FunctionRuntime({
    forgeDir: resolve(opts.forgeDir),
    env: runtimeEnv,
    dev,
    workers: config.runtimeWorkers,
    serverId,
    timeouts: { functionMs: config.limits.functionTimeoutMs, actionMs: config.limits.actionTimeoutMs },
    maxPending: config.limits.maxPendingCalls,
    inline: config.runtimeMode === "inline",
  });
  const metrics = new Metrics();
  const recentLogs: LogEntry[] = [];
  const logStreams = new Set<(e: LogEntry) => void>();
  runtime.onLog = (e) => {
    recentLogs.push(e);
    if (recentLogs.length > 2500) recentLogs.splice(0, recentLogs.length - 2000); // in steps of 500, not a copy of the array per entry
    if (e.level === "call") metrics.observe(e.name, e.durationMs ?? 0, e.ok ?? false);
    for (const send of logStreams) send(e);
  };
  runtime.onPublish = (topics) => void bus.publish(topics).catch((e) => log("error", "publish failed", { error: String(e) }));
  const queries = new QueryRunner(runtime, cache, ttl);
  const subs = new SubscriptionManager(bus, queries, (e, requestId = crypto.randomUUID()) => {
    const err = toPublicError(e, requestId, dev);
    return { error: err.message, data: err.data, requestId: err.requestId };
  });
  // Evicts cache entries, and lets subscriptions notice writes that overlapped their first read. A Redis bus only delivers every topic when caching.
  if (cache || !config.redisUrl) bus.subscribe("*", (topic) => queries.invalidated(topic));

  const tracer = Tracer.fromEnv(env);
  const rpcOpts = { dev, maxSubscriptionsPerConnection: config.limits.maxSubscriptionsPerConnection, tracer };
  // Rebuilt after each load; open sockets use whichever is current, so they see functions added by a reload.
  let rpc: Rpc = buildRpc({ functions: [], tables: {}, crons: [], storage: false }, runtime, queries, subs, rpcOpts);
  let loading: Promise<unknown> = Promise.resolve();
  const load = () => {
    const p = runtime.start().then(async (manifest) => {
      rpc = buildRpc(manifest, runtime, queries, subs, rpcOpts);
      await queries.reset().catch((e) => log("error", "cache reset failed", { error: String(e) })); // results from the old code are wrong
      subs.rerunAll();
      return manifest;
    });
    loading = p.catch(() => {});
    return p;
  };

  const reload = () => runtime.stop().then(load);
  let connections = 0;
  let shuttingDown = false;
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const admin = buildAdminApi({
    runtime,
    subs,
    recentLogs,
    serverInfo: () => ({ serverId, customFunctions: config.customFunctions, connections, subscriptions: subs.size, workers: config.runtimeWorkers, uptimeMs: Math.round(process.uptime() * 1000) }),
    reload: () => reload(),
    cache: () => ({ ...queries.snapshot(), backend: config.redisUrl ? "redis" : "memory", maxBytes: config.redisUrl ? null : config.cacheMaxBytes }),
    clearCache: () => queries.clear(),
    customFunctions: config.customFunctions,
  });
  const adminSessions = new Map<string, { admin: AdminInfo | null; at: number }>();
  async function adminOf(req: Request): Promise<AdminInfo | null> {
    const key = req.headers.get("x-admin-key");
    if (key && config.adminKey && sameSecret(key, config.adminKey)) return { email: KEY_ADMIN.email, role: KEY_ADMIN.role };
    const token = cookieValue(req.headers.get("cookie"), "afx_admin");
    if (!token) return null;
    const cached = adminSessions.get(token);
    if (cached && Date.now() - cached.at < 10_000) return cached.admin;
    const found = await runtime.admin<AdminInfo | null>("session", { token }, "system").catch(() => null);
    adminSessions.set(token, { admin: found, at: Date.now() });
    if (adminSessions.size > 1000) adminSessions.clear();
    return found;
  }
  const adminCookie = (token: string, maxAge: number) =>
    `afx_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.authUrl.startsWith("https://") ? "; Secure" : ""}`;

  const cors = (req: Request, res: Response) => {
    const origin = req.headers.get("origin");
    if (origin && config.trustedOrigins.includes(origin)) {
      res.headers.set("access-control-allow-origin", origin);
      res.headers.set("access-control-allow-credentials", "true");
      res.headers.append("vary", "origin");
    }
    return res;
  };

  /**
   * Browsers send an Origin with a WebSocket handshake and let any page open one to any host, with the visitor's cookies attached when
   * they are SameSite=None. So a browser's origin must be this server's own address, a trusted origin, or the host that was asked for.
   * Clients that are not browsers send no Origin and are not affected.
   */
  const originAllowed = (req: Request) => {
    const origin = req.headers.get("origin");
    if (!origin) return true;
    if (config.trustedOrigins.includes(origin)) return true;
    try {
      const host = new URL(origin);
      const asked = (config.trustProxy ? req.headers.get("x-forwarded-host") : null) ?? req.headers.get("host");
      return host.origin === new URL(config.authUrl).origin || host.host === asked;
    } catch {
      return false;
    }
  };

  const clientIp = (req: Request, srv: Server<SocketData>) =>
    (config.trustProxy && lastForwarded(req.headers.get("x-forwarded-for"))) || srv.requestIP(req)?.address || "unknown";
  /** Seconds to wait when this client is over its rate limit; with no limit configured, null at once and the client's address is never looked up. */
  const limited = (req: Request, srv: Server<SocketData>, prefix = ""): Promise<number | null> | null => {
    const max = config.limits.rateLimitPerMinute;
    if (!max) return null;
    return limiter.consume(prefix + clientIp(req, srv), { window: 60, max }).then((r) => (r.allowed ? null : r.retryAfter ?? 60));
  };
  const tooMany = (retryAfter: number) => Response.json({ message: "Too many requests" }, { status: 429, headers: { "retry-after": String(retryAfter) } });

  async function handleAdmin(req: Request, path: string, requestId: string): Promise<Response> {
    // A custom header can't be sent cross-site without a CORS preflight, which this API never grants.
    if (req.method !== "GET" && req.headers.get("x-forge-admin") !== "1") return Response.json({ message: "Missing x-forge-admin header" }, { status: 403 });
    if (path === "/_admin/login" && req.method === "POST") {
      const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string; key?: string };
      try {
        const out =
          body.key !== undefined
            ? config.adminKey && sameSecret(body.key, config.adminKey)
              ? await runtime.admin<{ token: string; admin: AdminInfo }>("keySession", {}, "system")
              : null
            : await runtime.admin<{ token: string; admin: AdminInfo }>("login", { email: body.email, password: body.password }, "system");
        if (!out) return Response.json({ message: "Invalid admin key" }, { status: 401 });
        log("info", "dashboard sign-in", { admin: out.admin.email, requestId });
        return Response.json(out.admin, { headers: { "set-cookie": adminCookie(out.token, 12 * 3600) } });
      } catch (e) {
        return Response.json({ message: (e as Error).message }, { status: 401 });
      }
    }
    if (path === "/_admin/logout" && req.method === "POST") {
      const token = cookieValue(req.headers.get("cookie"), "afx_admin");
      if (token) await runtime.admin("logout", { token }, "system").catch(() => {});
      if (token) adminSessions.delete(token);
      return new Response(null, { status: 204, headers: { "set-cookie": adminCookie("", 0) } });
    }
    const who = await adminOf(req);
    if (path === "/_admin/logs/stream") {
      if (!who) return new Response("Unauthorized", { status: 401 });
      let close = () => {};
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(`: connected\n\n`); // flushes headers, so the browser sees the stream open
          const send = (e: LogEntry) => controller.enqueue(`data: ${JSON.stringify(e)}\n\n`);
          const ping = setInterval(() => controller.enqueue(`: ping\n\n`), 15_000);
          logStreams.add(send);
          close = () => (clearInterval(ping), logStreams.delete(send));
        },
        cancel: () => close(),
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream", "cache-control": "no-store" } });
    }
    return admin(path.slice("/_admin/".length), req, { admin: who, requestId });
  }

  const server = Bun.serve<SocketData>({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: config.limits.maxRequestBytes,
    idleTimeout: Math.min(config.idleTimeoutSeconds, 255), // Bun's own ceiling
    // Dashboard bundling must match React's build: production under NODE_ENV=production (the engine image),
    // otherwise dev bundling so dashboard edits show on reload. HMR stays off: it rejects proxied Host headers.
    development: process.env.NODE_ENV === "production" ? false : { hmr: false },
    routes: opts.dashboard && config.dashboard ? { "/_dashboard": opts.dashboard } : {},
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const requestId = requestIdOf(req.headers.get("x-request-id"));
      const withId = (res: Response) => (res.headers.set("x-request-id", requestId), res);

      if (path === "/health") return Response.json({ ok: true });
      if (path === "/ready")
        return Response.json({ ready: !shuttingDown && Boolean(runtime.manifest) && !runtime.loadError, error: runtime.loadError }, { status: !shuttingDown && runtime.manifest && !runtime.loadError ? 200 : 503 });
      // The CLI's data commands. They run in the function runtime, which owns the database, so imports reach subscribers and nothing contends with the server for the write lock.
      if (path === "/_cli" && req.method === "POST") {
        const retry = await limited(req, srv, "cli:");
        if (retry) return withId(tooMany(retry));
        const key = req.headers.get("x-admin-key");
        if (!key || !config.adminKey || !sameSecret(key, config.adminKey)) return withId(Response.json({ message: "Invalid admin key" }, { status: 401 }));
        const body = (await req.json().catch(() => null)) as { cmd?: string; args?: Record<string, unknown> } | null;
        if (!body?.cmd) return withId(Response.json({ message: "Expected {cmd, args}" }, { status: 400 }));
        try {
          return withId(Response.json({ result: await runtime.admin("cli", { cmd: body.cmd, args: body.args ?? {} }, "cli") }));
        } catch (e) {
          return withId(Response.json({ message: (e as Error).message }, { status: 400 }));
        }
      }
      if (path === "/metrics") {
        const auth = req.headers.get("authorization")?.replace(/^Bearer /, "");
        const token = env.METRICS_TOKEN || config.adminKey;
        if (token ? !(auth && sameSecret(auth, token)) : !dev) return new Response("Not found", { status: 404 });
        return new Response(metrics.render({ subscriptions: subs.size, connections, workers: config.runtimeWorkers }, queries.snapshot()), { headers: { "content-type": "text/plain; version=0.0.4" } });
      }
      if (shuttingDown) return withId(Response.json({ message: "Server is shutting down" }, { status: 503, headers: { "retry-after": "1" } }));

      if (path === "/rpc" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!originAllowed(req)) return new Response("Origin not allowed. Add it to TRUSTED_ORIGINS.", { status: 403 });
        const retry = await limited(req, srv);
        if (retry) return tooMany(retry);
        const ip = config.limits.rateLimitPerMinute ? clientIp(req, srv) : undefined;
        const data: SocketData = { headers: pickAuthHeaders((n) => req.headers.get(n)), requestId, traceparent: req.headers.get("traceparent") ?? undefined, ip, live: new Map() };
        if (srv.upgrade(req, { data })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      // HTTP actions (forge/http.ts). Before the OPTIONS branch below, so a route can answer its own preflight and set its own headers.
      if (path === "/http" || path.startsWith("/http/")) {
        const retry = await limited(req, srv);
        if (retry) return withId(tooMany(retry));
        await loading;
        const body = req.method === "GET" ? undefined : await req.arrayBuffer();
        const routed = new URL(req.url);
        routed.pathname = path.slice("/http".length) || "/"; // the handler sees the path it registered
        try {
          const r = await runtime.http({ method: req.method, url: routed.href, headers: [...req.headers], body }, pickAuthHeaders((n) => req.headers.get(n)), requestId);
          // A body on a 204 or 304 is an error in a Response.
          return withId(new Response(r.body.byteLength ? r.body : null, { status: r.status, headers: r.headers }));
        } catch (e) {
          return withId(errorResponse(toPublicError(e, requestId, dev, { path })));
        }
      }
      if (req.method === "OPTIONS")
        return cors(
          req,
          new Response(null, {
            status: 204,
            headers: { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-request-id" },
          }),
        );
      if (path.startsWith("/rpc/") || path.startsWith("/api/auth")) {
        const retry = await limited(req, srv);
        if (retry) return cors(req, withId(tooMany(retry)));
      }
      if (path.startsWith("/rpc/")) {
        await loading;
        let name: string;
        try {
          name = decodeURIComponent(path.slice("/rpc/".length));
        } catch {
          return cors(req, withId(errorResponse({ message: "Malformed function name", code: "BAD_REQUEST", requestId })));
        }
        const headers = pickAuthHeaders((n) => req.headers.get(n));
        return cors(req, await rpc.call(name, req, url, { headers, requestId, traceparent: req.headers.get("traceparent") ?? undefined })); // sets x-request-id itself
      }
      if (path.startsWith("/api/auth")) {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
        try {
          const headers: [string, string][] = [...req.headers].filter(([k]) => k !== CLIENT_IP_HEADER);
          headers.push([CLIENT_IP_HEADER, clientIp(req, srv)]);
          const r = await runtime.auth({ method: req.method, url: req.url, headers, body });
          return cors(req, withId(new Response(r.body, { status: r.status, headers: r.headers })));
        } catch (e) {
          const err = toPublicError(e, requestId, dev, { path });
          return cors(req, withId(Response.json({ message: err.message }, { status: 503 })));
        }
      }
      if (path.startsWith("/_admin/")) {
        if (!config.dashboard) return new Response("Not found", { status: 404 });
        if (path === "/_admin/login") {
          const retry = await limited(req, srv, "admin:");
          if (retry) return withId(tooMany(retry));
        }
        return withId(await handleAdmin(req, path, requestId));
      }
      if (opts.app) {
        await loading;
        const headers = pickAuthHeaders((n) => req.headers.get(n));
        const publicError = (e: unknown) => {
          const err = toPublicError(e, requestId, dev, { path });
          return err.data !== undefined ? new ForgeError(err.data) : Object.assign(new Error(err.message), { code: err.code, requestId });
        };
        const res = await opts.app.fetch(req, {
          requestId,
          dev,
          headers,
          async call(name, kind, args) {
            try {
              if (kind === "query") {
                // A copy: the result may be the object the query cache keeps, and a page is free to change what it gets.
                const r = await queries.run(name, (args ?? {}) as Record<string, unknown>, headers, requestId);
                return r.json !== undefined ? JSON.parse(r.json) : structuredClone(r.value);
              }
              return (await runtime.call(name, kind, args ?? {}, headers, { requestId })).value;
            } catch (e) {
              throw publicError(e);
            }
          },
          identity: () => runtime.identity(headers).catch((e) => Promise.reject(publicError(e))),
          rateLimited: async () => (await limited(req, srv)) ?? null,
          keepAlive: () => srv.timeout(req, 0),
        });
        if (res) return res;
      }
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      maxPayloadLength: config.limits.maxRequestBytes,
      // A client that can't keep up is dropped; it reconnects and refetches, instead of buffering without bound.
      backpressureLimit: 4 * 1024 * 1024,
      closeOnBackpressureLimit: true,
      open(ws) {
        connections++;
        sockets.add(ws);
      },
      async message(ws, msg) {
        if (config.limits.rateLimitPerMinute) {
          const r = await limiter.consume(ws.data.ip ?? "unknown", { window: 60, max: config.limits.rateLimitPerMinute });
          if (!r.allowed) return ws.close(1008, "Too many requests");
        }
        await loading; // a socket can connect before the function runtime has loaded, as an HTTP request can
        if (typeof msg === "string") rpc.message(ws, msg);
      },
      close(ws) {
        connections--;
        sockets.delete(ws);
        rpc.close(ws);
      },
    },
  });

  // Bound to every interface, the local URL is the useful one (Better Auth's default origin, logs).
  const url = ["0.0.0.0", "::"].includes(config.hostname) ? `http://localhost:${server.port}` : server.url.href.replace(/\/$/, "");
  runtimeEnv.BETTER_AUTH_URL ??= url;
  // Started right after binding, so early requests wait for the runtime instead of failing.
  if (dev) await load().catch((e) => log("error", e.message));
  else
    await load().catch(async (e) => {
      server.stop(true);
      await bus.close();
      throw e;
    });

  // Subscription and connection counts over time, for the dashboard's charts.
  // The cache counters are totals since start; the chart wants what happened in each interval.
  let sampled = { hits: 0, misses: 0, coalesced: 0 };
  const sampler = setInterval(() => {
    if (!runtime.manifest || runtime.loadError) return;
    const c = queries.snapshot();
    const cache = c.enabled ? { cacheHits: c.hits - sampled.hits, cacheMisses: c.misses - sampled.misses, cacheCoalesced: c.coalesced - sampled.coalesced, cacheEntries: c.entries } : {};
    const previous = sampled;
    sampled = { hits: c.hits, misses: c.misses, coalesced: c.coalesced };
    void runtime.admin("recordMetric", { server: serverId, subscriptions: subs.size, connections, ...cache }, "system").catch(() => {
      sampled = previous; // not recorded: count it in the next sample instead
    });
  }, 30_000);

  return {
    url,
    config,
    runtime,
    reload,
    async stop({ graceful = true } = {}) {
      shuttingDown = true;
      clearInterval(sampler);
      // 1012 "service restart": clients reconnect (to another server, behind a load balancer) and refetch.
      for (const ws of sockets) ws.close(1012, "Server restarting");
      if (graceful) await Promise.race([server.stop(false), Bun.sleep(10_000)]);
      server.stop(true);
      await opts.app?.dispose?.();
      await runtime.stop();
      await bus.close();
      await cache?.close();
      await tracer?.close();
    },
  };
}
