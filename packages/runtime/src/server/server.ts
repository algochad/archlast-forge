import type { AnyRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getWSConnectionHandler } from "@trpc/server/adapters/ws";
import type { HTMLBundle, Server } from "bun";
import { timingSafeEqual } from "node:crypto";
import { hostname } from "node:os";
import { resolve } from "node:path";
import { KEY_ADMIN, type AdminInfo } from "./admin-ops";
import { connectRedis, MemoryBus, RedisBus, type Bus } from "./bus";
import { MemoryCache, RedisCache } from "./cache";
import { loadConfig, type Config } from "./config";
import type { CallHeaders, LogEntry } from "./executor";
import { log, setLogFormat } from "./logger";
import { Metrics } from "./metrics";
import type { Manifest } from "./project";
import { toPublicError } from "./public-error";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit";
import { buildAdminRouter, buildRouter, type Context } from "./router";
import { FunctionRuntime } from "./runtime";
import { QueryRunner, SubscriptionManager } from "./subscriptions";
import { Tracer } from "./tracing";
import { WsShim, type WsData } from "./ws";

export interface ServerOptions {
  convexDir: string;
  dev?: boolean;
  env?: Record<string, string | undefined>;
  /** Bun HTML import of the dashboard, served at /_dashboard when enabled. */
  dashboard?: HTMLBundle;
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
const requestIdOf = (given: string | null | undefined) => (given && REQUEST_ID.test(given) ? given : crypto.randomUUID());

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
  const cache = ttl > 0 ? (config.redisUrl ? await RedisCache.connect(config.redisUrl) : new MemoryCache()) : undefined;
  const limiter: RateLimiter = config.redisUrl ? new RedisRateLimiter(await connectRedis(config.redisUrl), "archlast-forge:rl:") : new MemoryRateLimiter();

  const runtimeEnv = { ...env }; // gets the bound URL before the runtime starts
  const runtime = new FunctionRuntime({
    convexDir: resolve(opts.convexDir),
    env: runtimeEnv,
    dev,
    workers: config.runtimeWorkers,
    serverId,
    timeouts: { functionMs: config.limits.functionTimeoutMs, actionMs: config.limits.actionTimeoutMs },
  });
  const metrics = new Metrics();
  const recentLogs: LogEntry[] = [];
  const logStreams = new Set<(e: LogEntry) => void>();
  runtime.onLog = (e) => {
    recentLogs.push(e);
    if (recentLogs.length > 2000) recentLogs.splice(0, recentLogs.length - 2000);
    if (e.level === "call") metrics.observe(e.name, e.durationMs ?? 0, e.ok ?? false);
    for (const send of logStreams) send(e);
  };
  runtime.onPublish = (topics) => void bus.publish(topics).catch((e) => log("error", "publish failed", { error: String(e) }));
  const queries = new QueryRunner(runtime, cache, ttl);
  const subs = new SubscriptionManager(bus, queries, (e, requestId = crypto.randomUUID()) => {
    const err = toPublicError(e, requestId, dev);
    return { error: err.message, data: err.data, requestId: err.requestId };
  });
  if (cache) bus.subscribe("*", (topic) => queries.invalidated(topic));

  const tracer = Tracer.fromEnv(env);
  const routerOpts = { dev, maxSubscriptionsPerConnection: config.limits.maxSubscriptionsPerConnection, tracer };
  let router: AnyRouter = buildRouter({ functions: [], tables: {}, crons: [], storage: false }, runtime, queries, subs, routerOpts);
  // tRPC only reads `_def`, so this stable handle lets open sockets see procedures added by a reload.
  const routerRef = { get _def() { return router._def; } } as AnyRouter;
  let loading: Promise<unknown> = Promise.resolve();
  const load = () => {
    const p = runtime.start().then((manifest) => {
      router = buildRouter(manifest, runtime, queries, subs, routerOpts);
      subs.rerunAll();
      return manifest;
    });
    loading = p.catch(() => {});
    return p;
  };

  const reload = () => runtime.stop().then(load);
  let connections = 0;
  let shuttingDown = false;
  const sockets = new Set<WsShim>();

  const admin = buildAdminRouter({
    runtime,
    subs,
    recentLogs,
    dev,
    serverInfo: () => ({ serverId, connections, subscriptions: subs.size, workers: config.runtimeWorkers, uptimeMs: Math.round(process.uptime() * 1000) }),
    reload: () => reload(),
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

  const wsHandler = getWSConnectionHandler({
    wss: undefined as never, // only applyWSSHandler uses it
    router: routerRef,
    createContext: ({ req }): Context => ({
      headers: pickAuthHeaders((n) => req.headers[n] as string | undefined),
      requestId: requestIdOf(req.headers["x-request-id"] as string | undefined),
      conn: { subscriptions: 0 },
      traceparent: req.headers.traceparent as string | undefined,
    }),
  });

  const cors = (req: Request, res: Response) => {
    const origin = req.headers.get("origin");
    if (origin && config.trustedOrigins.includes(origin)) {
      res.headers.set("access-control-allow-origin", origin);
      res.headers.set("access-control-allow-credentials", "true");
      res.headers.append("vary", "origin");
    }
    return res;
  };

  const clientIp = (req: Request, srv: Server<WsData>) =>
    (config.trustProxy && req.headers.get("x-forwarded-for")?.split(",")[0]?.trim()) || srv.requestIP(req)?.address || "unknown";
  const limited = async (ip: string) => {
    if (!config.limits.rateLimitPerMinute) return null;
    const r = await limiter.consume(ip, { window: 60, max: config.limits.rateLimitPerMinute });
    return r.allowed ? null : r.retryAfter ?? 60;
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
    return fetchRequestHandler({ endpoint: "/_admin", req, router: admin, createContext: () => ({ admin: who, requestId }) });
  }

  const server = Bun.serve<WsData>({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: config.limits.maxRequestBytes,
    // Bun's HMR dev server rejects unknown Host headers, which breaks the dashboard behind proxies.
    development: { hmr: false },
    routes: opts.dashboard && config.dashboard ? { "/_dashboard": opts.dashboard } : {},
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const requestId = requestIdOf(req.headers.get("x-request-id"));
      const withId = (res: Response) => (res.headers.set("x-request-id", requestId), res);

      if (path === "/health") return Response.json({ ok: true });
      if (path === "/ready")
        return Response.json({ ready: !shuttingDown && Boolean(runtime.manifest) && !runtime.loadError, error: runtime.loadError }, { status: !shuttingDown && runtime.manifest && !runtime.loadError ? 200 : 503 });
      if (path === "/metrics") {
        const auth = req.headers.get("authorization")?.replace(/^Bearer /, "");
        const token = env.METRICS_TOKEN || config.adminKey;
        if (token ? !(auth && sameSecret(auth, token)) : !dev) return new Response("Not found", { status: 404 });
        return new Response(metrics.render({ subscriptions: subs.size, connections, workers: config.runtimeWorkers }), { headers: { "content-type": "text/plain; version=0.0.4" } });
      }
      if (shuttingDown) return withId(Response.json({ message: "Server is shutting down" }, { status: 503, headers: { "retry-after": "1" } }));

      if (path === "/trpc" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const ip = clientIp(req, srv);
        const retry = await limited(ip);
        if (retry) return tooMany(retry);
        const headers = { ...Object.fromEntries(req.headers), "x-request-id": requestId };
        if (srv.upgrade(req, { data: { req: { url: path + url.search, headers }, ip } })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (req.method === "OPTIONS")
        return cors(
          req,
          new Response(null, {
            status: 204,
            headers: { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-request-id" },
          }),
        );
      if (path.startsWith("/trpc/") || path.startsWith("/api/auth")) {
        const retry = await limited(clientIp(req, srv));
        if (retry) return cors(req, withId(tooMany(retry)));
      }
      if (path.startsWith("/trpc/")) {
        await loading;
        return cors(
          req,
          withId(
            await fetchRequestHandler({
              endpoint: "/trpc",
              req,
              router: routerRef,
              createContext: ({ req }): Context => ({
                headers: pickAuthHeaders((n) => req.headers.get(n)),
                requestId,
                traceparent: req.headers.get("traceparent") ?? undefined,
              }),
            }),
          ),
        );
      }
      if (path.startsWith("/api/auth")) {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
        try {
          const r = await runtime.auth({ method: req.method, url: req.url, headers: [...req.headers], body });
          return cors(req, withId(new Response(r.body, { status: r.status, headers: r.headers })));
        } catch (e) {
          const err = toPublicError(e, requestId, dev, { path });
          return cors(req, withId(Response.json({ message: err.message }, { status: 503 })));
        }
      }
      if (path.startsWith("/_admin/")) {
        if (!config.dashboard) return new Response("Not found", { status: 404 });
        if (path === "/_admin/login") {
          const retry = await limited(`admin:${clientIp(req, srv)}`);
          if (retry) return withId(tooMany(retry));
        }
        return withId(await handleAdmin(req, path, requestId));
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
        ws.data.shim = new WsShim(ws as any);
        sockets.add(ws.data.shim);
        wsHandler(ws.data.shim as any, ws.data.req as any);
      },
      async message(ws, msg) {
        if (config.limits.rateLimitPerMinute && msg !== "PONG") {
          const r = await limiter.consume(ws.data.ip ?? "unknown", { window: 60, max: config.limits.rateLimitPerMinute });
          if (!r.allowed) return ws.close(1008, "Too many requests");
        }
        ws.data.shim?.emit("message", Buffer.from(msg), typeof msg !== "string"); // tRPC expects a Buffer
      },
      close(ws, code, reason) {
        connections--;
        if (!ws.data.shim) return;
        sockets.delete(ws.data.shim);
        ws.data.shim.readyState = 3;
        ws.data.shim.emit("close", code, reason);
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
  const sampler = setInterval(() => {
    if (runtime.manifest && !runtime.loadError)
      void runtime.admin("recordMetric", { server: serverId, subscriptions: subs.size, connections }, "system").catch(() => {});
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
      for (const s of sockets) s.close(1012, "Server restarting");
      if (graceful) await Promise.race([server.stop(false), Bun.sleep(10_000)]);
      server.stop(true);
      await runtime.stop();
      await bus.close();
      await cache?.close();
      await tracer?.close();
    },
  };
}
