import type { AnyRouter } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { getWSConnectionHandler } from "@trpc/server/adapters/ws";
import type { HTMLBundle } from "bun";
import { resolve } from "node:path";
import { MemoryBus, RedisBus, type Bus } from "./bus";
import { MemoryCache, RedisCache } from "./cache";
import { loadConfig, type Config } from "./config";
import type { CallHeaders, LogEntry } from "./executor";
import type { Manifest } from "./project";
import { buildAdminRouter, buildRouter } from "./router";
import { FunctionRuntime } from "./runtime";
import { QueryRunner, SubscriptionManager } from "./subscriptions";
import { WsShim, type WsData } from "./ws";

export interface ServerOptions {
  convexDir: string;
  dev?: boolean;
  env?: Record<string, string | undefined>;
  /** Bun HTML import of the dashboard, served at /_dashboard. */
  dashboard?: HTMLBundle;
}

export interface RunningServer {
  url: string;
  config: Config;
  runtime: FunctionRuntime;
  /** Restarts only the function runtime; HTTP/WS stay up and subscriptions re-run. */
  reload(): Promise<Manifest>;
  stop(): Promise<void>;
}

const pickAuthHeaders = (get: (name: string) => string | null | undefined): CallHeaders => {
  const h: CallHeaders = {};
  for (const name of ["cookie", "authorization"]) {
    const value = get(name);
    if (value) h[name] = value;
  }
  return h;
};

/** Startup order: config → bus/cache → function runtime (DB, migrations, modules, auth) → router → Bun.serve. */
export async function startServer(opts: ServerOptions): Promise<RunningServer> {
  const env = opts.env ?? process.env;
  const dev = opts.dev ?? false;
  const config = loadConfig(env, dev);
  // Dev reloads code often, so the result cache is off unless asked for.
  const ttl = dev && env.CACHE_TTL_MS === undefined ? 0 : config.cacheTtlMs;
  const bus: Bus = config.redisUrl ? await RedisBus.connect(config.redisUrl) : new MemoryBus();
  const cache = ttl > 0 ? (config.redisUrl ? await RedisCache.connect(config.redisUrl) : new MemoryCache()) : undefined;

  const runtimeEnv = { ...env }; // gets the bound URL before the runtime starts
  const runtime = new FunctionRuntime({ convexDir: resolve(opts.convexDir), env: runtimeEnv, dev });
  const logs: LogEntry[] = [];
  runtime.onLog = (e) => {
    logs.push(e);
    if (logs.length > 2000) logs.splice(0, logs.length - 2000);
  };
  runtime.onPublish = (topics) => void bus.publish(topics).catch((e) => console.error("publish failed:", e));
  const queries = new QueryRunner(runtime, cache, ttl);
  const subs = new SubscriptionManager(bus, queries);
  bus.subscribe("*", (topic) => queries.invalidated(topic));

  let router: AnyRouter = buildRouter({ functions: [], tables: {}, crons: [], storage: false }, runtime, queries, subs);
  // tRPC only reads `_def`, so this stable handle lets open sockets see procedures added by a reload.
  const routerRef = { get _def() { return router._def; } } as AnyRouter;
  let loading: Promise<unknown> = Promise.resolve();
  const load = () => {
    const p = runtime.start().then((manifest) => {
      router = buildRouter(manifest, runtime, queries, subs);
      subs.rerunAll();
      return manifest;
    });
    loading = p.catch(() => {});
    return p;
  };
  const admin = buildAdminRouter({ adminKey: config.adminKey, runtime, subs, logs });
  const wsHandler = getWSConnectionHandler({
    wss: undefined as never, // only applyWSSHandler uses it
    router: routerRef,
    createContext: ({ req }) => ({ headers: pickAuthHeaders((n) => req.headers[n] as string | undefined) }),
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

  const server = Bun.serve<WsData>({
    port: config.port,
    // Bun's HMR dev server rejects unknown Host headers, which breaks the dashboard behind proxies.
    development: { hmr: false },
    routes: opts.dashboard ? { "/_dashboard": opts.dashboard } : {},
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path === "/trpc" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        const headers = Object.fromEntries(req.headers);
        if (srv.upgrade(req, { data: { req: { url: path + url.search, headers } } })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      if (req.method === "OPTIONS")
        return cors(
          req,
          new Response(null, {
            status: 204,
            headers: { "access-control-allow-methods": "GET, POST, OPTIONS", "access-control-allow-headers": "content-type, authorization, x-admin-key" },
          }),
        );
      if (path.startsWith("/trpc/")) {
        await loading;
        return cors(
          req,
          await fetchRequestHandler({
            endpoint: "/trpc",
            req,
            router: routerRef,
            createContext: ({ req }) => ({ headers: pickAuthHeaders((n) => req.headers.get(n)) }),
          }),
        );
      }
      if (path.startsWith("/api/auth")) {
        const body = req.method === "GET" || req.method === "HEAD" ? undefined : await req.text();
        try {
          const r = await runtime.auth({ method: req.method, url: req.url, headers: [...req.headers], body });
          return cors(req, new Response(r.body, { status: r.status, headers: r.headers }));
        } catch (e) {
          return cors(req, Response.json({ message: (e as Error).message }, { status: 503 }));
        }
      }
      if (path.startsWith("/_admin/"))
        return fetchRequestHandler({ endpoint: "/_admin", req, router: admin, createContext: ({ req }) => ({ adminKey: req.headers.get("x-admin-key") }) });
      if (path === "/health") return Response.json({ ok: Boolean(runtime.manifest) && !runtime.loadError });
      return new Response("Not found", { status: 404 });
    },
    websocket: {
      open(ws) {
        ws.data.shim = new WsShim(ws as any);
        wsHandler(ws.data.shim as any, ws.data.req as any);
      },
      message(ws, msg) {
        ws.data.shim?.emit("message", Buffer.from(msg), typeof msg !== "string"); // tRPC expects a Buffer
      },
      close(ws, code, reason) {
        if (!ws.data.shim) return;
        ws.data.shim.readyState = 3;
        ws.data.shim.emit("close", code, reason);
      },
    },
  });

  const url = server.url.href.replace(/\/$/, "");
  runtimeEnv.BETTER_AUTH_URL ??= url;
  // Started right after binding, so early requests wait for the runtime instead of failing.
  if (dev) await load().catch((e) => console.error(`\n✗ ${e.message}\n`));
  else
    await load().catch(async (e) => {
      server.stop(true);
      await bus.close();
      throw e;
    });

  return {
    url,
    config,
    runtime,
    async reload() {
      await runtime.stop();
      return load();
    },
    async stop() {
      server.stop(true);
      await runtime.stop();
      await bus.close();
      await cache?.close();
    },
  };
}
