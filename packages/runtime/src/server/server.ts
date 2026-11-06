import type { HTMLBundle, Server, ServerWebSocket } from "bun";
import { brotliCompressSync } from "node:zlib";
import { timingSafeEqual } from "node:crypto";
import { mkdirSync, rmSync } from "node:fs";
import { availableParallelism, hostname } from "node:os";
import { extname, join, relative, resolve } from "node:path";
import { buildAdminApi } from "./admin-api";
import { KEY_ADMIN, type AdminInfo } from "./admin-ops";
import { CLIENT_IP_HEADER } from "./auth";
import { claimPrefix, connectRedis, MemoryBus, RedisBus, type Bus } from "./bus";
import { MemoryCache, RedisCache } from "./cache";
import { docsRouting, type ApiDocsPageConfig, type ApiDocsRouting } from "../api-docs";
import { ConfigError, loadConfig, redisOwnerOf, reservedPathOf, runtimeWorkersFor, telemetryPath, type Config } from "./config";
import { matchRoute } from "./http";
import { RESET_TOPIC } from "./docstore";
import { checkValue, liveEnv, readStoredSettings, SETTING, SETTINGS, validateSettings, withSettings } from "./settings";
import { dashboardHost } from "./dashboard-host";
import { CSP_REPORT_PATH, parseOverrides, SecurityHeaders, type SecurityOverrides } from "./security-headers";
import { createStorage, LocalStorage, serveLocalStorage } from "./storage";
import { ForgeError } from "../errors";
import type { FunctionKind, UserIdentity } from "../functions";
import type { CallHeaders, LogEntry } from "./executor";
import { log, setLogFormat } from "./logger";
import { Metrics, type LoopDelays } from "./metrics";
import type { Manifest } from "./project";
import { toPublicError } from "./public-error";
import { MemoryRateLimiter, RedisRateLimiter, type RateLimiter } from "./ratelimit";
import { buildRpc, errorResponse, HttpError, readBytes, readText, type Rpc, type SocketData } from "./rpc";
import { FunctionRuntime } from "./runtime";
import { QueryRunner, SubscriptionManager, type QueryObserver } from "./subscriptions";
import { TelemetryClient } from "./telemetry/client";
import { Firewall, settingsOf, type TestRequest } from "./waf/firewall";
import { now as clock } from "./telemetry/context";
import { OtlpExporter } from "./telemetry/export";
import { telemetryForwarder } from "./telemetry/forward";
import { spanId as newSpanId } from "./telemetry/ids";
import { failureOf } from "./telemetry/outcome";
import { normalizePath, Telemetry } from "./telemetry/recorder";
import { processSampler } from "./telemetry/sampler";
import type { Span, TelemetryBatch } from "./telemetry/types";

// Next to this module, like child.ts: the telemetry store's thread.
/** The firewall's form on the dashboard, and the setting each field is saved as. */
const WAF_FIELDS = [
  ["enabled", "WAF"],
  ["mode", "WAF_MODE"],
  ["paranoia", "WAF_PARANOIA"],
  ["workers", "WAF_WORKERS"],
  ["maxBodyKb", "WAF_MAX_BODY_KB"],
  ["ignorePaths", "WAF_IGNORE_PATHS"],
  ["disabledRules", "WAF_DISABLED_RULES"],
] as const;
const WAF_WORKER = new URL(import.meta.url.endsWith(".ts") ? "./waf/worker.ts" : "./waf/worker.js", import.meta.url);
const TELEMETRY_WORKER = new URL(import.meta.url.endsWith(".ts") ? "./telemetry/worker.ts" : "./telemetry/worker.js", import.meta.url);

/** A socket of the RPC protocol, or of a Nest gateway under /http (`gateway`), whose events go to the function runtime. */
type ServerSocket = SocketData & { gateway?: { sid: string; path: string; headers: [string, string][] } };

/** The first subprotocol a client asks for, echoed back: clients such as graphql-ws refuse a handshake without it. */
const subprotocol = (req: Request) => {
  const wanted = req.headers.get("sec-websocket-protocol")?.split(",")[0]?.trim();
  return wanted ? { "sec-websocket-protocol": wanted } : undefined;
};

/** The root addresses of Better Auth's metadata (RFC 8414, and OpenID Connect's form of it), for the issuer <origin>/api/auth. */
const WELL_KNOWN_AUTH = /^\/\.well-known\/(oauth-authorization-server|openid-configuration)\/api\/auth\/?$/;

/** A frontend the engine serves next to the API (framework mode). */
export interface AppHost {
  /**
   * Called for requests the engine has no route for: everything except /rpc, /api/auth, /http, /_admin, /_dashboard, /_cli,
   * /health, /ready and /metrics. Return undefined for the plain 404.
   */
  fetch(req: Request, env: AppEnv): Response | undefined | Promise<Response | undefined>;
  dispose?(): void | Promise<void>;
  /** Whether one of the app's own routes takes this path (a page, not a catch-all); undefined while the app isn't built yet. The engine checks the API docs' paths against it. */
  matches?(path: string): boolean | undefined;
  /**
   * Whether a GET of this path is answered with one of the app's files (its built assets, a file in public/) and no app code. The web
   * application firewall leaves those alone; anything else, a static-looking path included, is inspected.
   */
  serves?(path: string): boolean | Promise<boolean>;
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
  /** Names the route this request matched (`/posts/:id`), so the dashboard groups its requests by route rather than by URL. */
  route?(pattern: string): void;
  /**
   * This response's Content-Security-Policy nonce, when the app's policy limits scripts: inline scripts the page renders (its state, React's
   * streaming scripts, the app's own) must carry it, or the browser won't run them.
   */
  nonce?: string;
}

export interface ServerOptions {
  forgeDir: string;
  dev?: boolean;
  env?: Record<string, string | undefined>;
  /** Bun HTML import of the dashboard, served at /_dashboard when enabled. */
  dashboard?: HTMLBundle;
  /** A frontend served for every path the engine doesn't own. */
  app?: AppHost;
  /** The API docs page and its request builder, at the docs' path when they are on (the OpenAPI document is the engine's own). */
  apiDocs?: ApiDocsHost;
  /**
   * Stops this server and starts it again in the same process, so settings saved from the dashboard apply. Given by hosts that can (the CLI);
   * without it the dashboard asks for a restart of the process.
   */
  restart?: () => Promise<void>;
}

/**
 * Serves the API docs page: `base`, `base/`, `base/_docs/*` and `explorerPath`, and null for anything else, which then goes to the app.
 * The same interface as DocsHost in @archlast/forge-dashboard's api-docs/contract.ts.
 */
export interface ApiDocsHost {
  serve(
    req: Request,
    opts: { base: string; publicBase: string; openapiUrl: string; explorerPath: string | null; dev: boolean; forgeDir: string; page: ApiDocsPageConfig },
  ): Promise<Response | null>;
  paths?(opts: { base: string; explorerPath: string | null }): { exact: string[]; prefixes: string[] };
}

/** `body` compressed for this request: brotli or gzip when the client takes them, else as it is. */
export function compressed(req: Request, body: string | Uint8Array<ArrayBuffer>, headers: Record<string, string>) {
  const accepts = req.headers.get("accept-encoding") ?? "";
  const bytes: Uint8Array<ArrayBuffer> = typeof body === "string" ? new TextEncoder().encode(body) : body;
  const vary = { ...headers, vary: "accept-encoding" };
  if (/\bbr\b/.test(accepts)) return new Response(brotliCompressSync(bytes), { headers: { ...vary, "content-encoding": "br" } });
  if (/\bgzip\b/.test(accepts)) return new Response(Bun.gzipSync(bytes), { headers: { ...vary, "content-encoding": "gzip" } });
  return new Response(bytes, { headers: vary });
}

export interface RunningServer {
  url: string;
  config: Config;
  runtime: FunctionRuntime;
  /** Restarts only the function runtime; HTTP/WS stay up and subscriptions re-run. */
  reload(): Promise<Manifest>;
  /** Graceful: stops accepting work, drains in-flight requests, asks clients to reconnect elsewhere. `keepApp` leaves the app host running, for a restart. */
  stop(opts?: { graceful?: boolean; keepApp?: boolean }): Promise<void>;
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

const SOURCE_FILES = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".mts", ".cts"]);

/**
 * Lines around `line` of a source file named in a stack trace, for the dashboard's error view. Only the project's own code: files under
 * the directory that holds forge/ (so a full-stack app's app/ too), not dependencies, and only source files.
 */
async function sourceContext(forgeDir: string, file: string, line: number, around = 6) {
  const root = resolve(forgeDir, "..");
  const path = resolve(root, file.replace(/^file:\/\//, ""));
  const rel = relative(root, path);
  if (rel.startsWith("..") || rel.split(/[\\/]/).includes("node_modules") || !SOURCE_FILES.has(extname(path))) return null;
  const f = Bun.file(path);
  if (!(await f.exists()) || f.size > 2_000_000) return null;
  const lines = (await f.text()).split("\n");
  const start = Math.max(1, line - around);
  return { file: rel.replaceAll("\\", "/"), line, start, lines: lines.slice(start - 1, Math.min(lines.length, line + around)) };
}

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
  const baseEnv = opts.env ?? process.env;
  const dev = opts.dev ?? false;
  const boot = loadConfig(baseEnv, dev); // the environment alone must make a working configuration
  // Settings saved from the dashboard, under the process environment. If they don't make a valid configuration any more, the engine starts
  // without them rather than not at all, and says why.
  let stored: Record<string, string> = {};
  let storedError: string | undefined;
  try {
    stored = await readStoredSettings(boot);
  } catch (e) {
    storedError = `couldn't read the settings saved from the dashboard: ${(e as Error).message}`;
  }
  let env = withSettings(baseEnv, stored);
  let config: Config;
  try {
    config = loadConfig(env, dev);
  } catch (e) {
    storedError = `ignoring the settings saved from the dashboard: ${(e as Error).message}`;
    env = baseEnv;
    config = boot;
    stored = {};
  }
  setLogFormat(config.logFormat);
  if (storedError) log("error", storedError);
  const startedWith = stored;

  // Security headers (Helmet) for the REST API, the app's pages and the dashboard: presets, the code's options (each load), and the
  // dashboard's HELMET and HELMET_CONFIG (live settings: the environment's win).
  const storageOrigins = [...new Set([config.s3?.publicEndpoint, config.s3?.endpoint].filter((u): u is string => Boolean(u)).map((u) => new URL(u).origin))];
  const security = new SecurityHeaders({ dev, https: config.authUrl.startsWith("https://"), storageOrigins, reports: true });
  const securityOf = (all: Record<string, string>) => {
    const live = liveEnv(baseEnv, all);
    return { enabled: !["0", "false", "off", "no"].includes((live.HELMET ?? "on").toLowerCase()), overrides: parseOverrides(live.HELMET_CONFIG) };
  };
  try {
    security.configure(securityOf(stored));
  } catch (e) {
    // A bad HELMET_CONFIG in the environment stops the start; one saved from the dashboard is set aside, as other bad saved settings are.
    if (baseEnv.HELMET_CONFIG) throw new ConfigError((e as Error).message);
    log("error", `ignoring the security headers saved from the dashboard: ${(e as Error).message}`);
    security.configure(securityOf({ ...stored, HELMET_CONFIG: "" }));
  }
  const dashboardPage = opts.dashboard && config.dashboard && !config.dashboardUrl ? dashboardHost(opts.dashboard as unknown as { index: string }) : undefined;
  /** Admin API answers are private: never kept by a cache, and with the dashboard's headers. */
  const adminResponse = (res: Response) => {
    const out = security.apply("dashboard", res);
    if (!out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
    return out;
  };
  /** How the pool's size was worked out, for the Settings page: from the start, then from each change applied without a restart. */
  let pool = runtimeWorkersFor(env);
  const serverId = `${hostname()}:${process.pid}`;
  const ttl = config.cacheTtlMs;
  const bus: Bus = config.redisUrl ? await RedisBus.connect(config.redisUrl, { broadcastAll: ttl > 0, prefix: config.redisPrefix }) : new MemoryBus();
  const cache = ttl > 0 ? (config.redisUrl ? await RedisCache.connect(config.redisUrl, config.redisPrefix) : new MemoryCache(10_000, config.cacheMaxBytes)) : undefined;
  const limiterRedis = config.redisUrl ? await connectRedis(config.redisUrl) : undefined;
  const limiter: RateLimiter = limiterRedis ? new RedisRateLimiter(limiterRedis, `${config.redisPrefix}rl:`) : new MemoryRateLimiter();
  // Two apps with one prefix on one Redis would share a cache and wake each other: say so at the start, instead of serving the wrong data silently.
  if (limiterRedis && (await claimPrefix(limiterRedis, config.redisPrefix, redisOwnerOf(config))))
    log("warn", `another app already uses the Redis prefix "${config.redisPrefix}" (it was written with a different BETTER_AUTH_SECRET): apps that share a Redis need their own OTEL_SERVICE_NAME or REDIS_PREFIX, or they share a cache and wake each other's subscriptions. If you just rotated the secret, this goes away once every server has restarted.`);

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
  // Telemetry: the store's worker when it is on, and an exporter when a collector is configured; either needs the recorder.
  // A microservice keeps no store: what it records goes to the main app's (DASHBOARD_URL), whose dashboard shows it.
  const forward = config.telemetry && config.dashboardUrl ? telemetryForwarder(config.dashboardUrl, config.dashboardToken!) : undefined;
  if (config.telemetry && !forward && config.databaseKind !== "postgres") mkdirSync(config.dataDir, { recursive: true });
  const store =
    config.telemetry && !forward
      ? new TelemetryClient(TELEMETRY_WORKER, { databaseUrl: config.databaseKind === "postgres" ? config.databaseUrl : undefined, path: telemetryPath(config), retentionDays: config.logRetentionDays, alerts: true })
      : undefined;
  /** Ingest keys checked recently, so an exporter sending every few seconds costs one lookup a minute. */
  const keys = new Map<string, { at: number; key: { service: string | null } | null }>();
  const ingestKey = async (key: string) => {
    const hit = keys.get(key);
    if (hit && Date.now() - hit.at < 60_000) return hit.key;
    const found = await store!.call<{ service: string | null } | null>("verifyKey", { key }).catch(() => null);
    if (keys.size > 1000) keys.clear();
    keys.set(key, { at: Date.now(), key: found });
    return found;
  };
  const exporter = OtlpExporter.fromEnv(env, config.serviceName);
  const telemetry =
    store || exporter || forward
      ? new Telemetry({
          service: config.serviceName,
          instance: serverId,
          sink: (batch) => (forward ? forward(batch) : store?.write(batch)),
          exporter,
          tracesPerSecond: config.telemetryTracesPerSecond,
          detailPerSecond: config.telemetryDetailPerSecond,
          release: () => runtime.manifest?.release,
        })
      : undefined;
  const recentLogs: LogEntry[] = [];
  const logStreams = new Set<(e: LogEntry) => void>();
  runtime.onLog = (e) => {
    recentLogs.push(e);
    if (recentLogs.length > 2500) recentLogs.splice(0, recentLogs.length - 2000); // in steps of 500, not a copy of the array per entry
    if (e.level === "call") metrics.observe(e.name, e.durationMs ?? 0, e.ok ?? false);
    telemetry?.log(e);
    for (const send of logStreams) send(e);
  };
  runtime.onTrace = (t) => telemetry?.record(t);
  runtime.onMetrics = (points, instance) => telemetry?.metricPoints(points, instance);
  /** Each process's last event-loop delay, for /metrics: this server's own, and its function-runtime processes' when they run apart. */
  const loops: LoopDelays = new Map();
  runtime.onSample = (s) => {
    loops.set(s.instance, { role: s.role, p99: s.loopP99, max: s.loopMax });
    telemetry?.sample(s);
  };
  runtime.onPublish = (topics) => void bus.publish(topics).catch((e) => log("error", "publish failed", { error: String(e) }));
  /** Sockets of Nest gateways, by id: the function runtime sends to and closes them through runtime.onWs. */
  const gatewaySockets = new Map<string, ServerWebSocket<ServerSocket>>();
  runtime.onWs = (msg) => {
    const ws = gatewaySockets.get(msg.sid);
    if (msg.op === "send") ws?.send(msg.data);
    else ws?.close(msg.code ?? 1000, msg.reason);
  };
  const queries = new QueryRunner(runtime, cache, ttl, Boolean(cache) || !config.redisUrl);
  const subs = new SubscriptionManager(
    bus,
    queries,
    (e, requestId = crypto.randomUUID()) => {
      const err = toPublicError(e, requestId, dev);
      return { error: err.message, data: err.data, requestId: err.requestId };
    },
    telemetry,
  );
  // Evicts cache entries, and lets subscriptions notice writes that overlapped their first read. A Redis bus only delivers every topic when caching.
  if (cache || !config.redisUrl) bus.subscribe("*", (topic) => queries.invalidated(topic));
  // A restore rewrote the tables: what any query read may have changed.
  bus.subscribe(RESET_TOPIC, () => {
    void queries.reset().catch((e) => log("error", "cache reset failed", { error: String(e) }));
    subs.rerunAll();
  });

  const rpcOpts = { dev, maxSubscriptionsPerConnection: config.limits.maxSubscriptionsPerConnection, maxSubscriptionBytes: config.limits.maxSubscriptionBytes, maxRequestBytes: config.limits.maxRequestBytes, telemetry };
  const maxBody = config.limits.maxRequestBytes;
  // Files kept on this server's disk are served here; uploads to them, and backups uploaded to the dashboard, may be larger than other requests.
  const localFiles = config.storage === "local" ? (createStorage(config) as LocalStorage) : undefined;
  // A microservice answers its main app's dashboard (DASHBOARD_URL) without serving one: its admin API is on, its pages are there.
  const adminApi = config.dashboard || Boolean(config.dashboardUrl);
  const takesUploads = Boolean(localFiles) || adminApi;
  // Rebuilt after each load; open sockets use whichever is current, so they see functions added by a reload.
  let rpc: Rpc = buildRpc({ functions: [], tables: {}, crons: [], storage: false }, runtime, queries, subs, rpcOpts);
  let loading: Promise<unknown> = Promise.resolve();
  /** The routes served at the root, for the manifest they came with (a reload brings new ones). */
  let rootRoutes: { manifest: Manifest; routes: NonNullable<Manifest["rootRoutes"]> } | undefined;
  /** Whether a root-mounted route (`httpRouter({ root: true })`) takes this path: one that matches it, under any method (a 405 is the route's). */
  const atRoot = async (method: string, path: string) => {
    if (reservedPathOf(path) || WELL_KNOWN_AUTH.test(path)) return false;
    if (!runtime.manifest) await loading;
    const manifest = runtime.manifest;
    if (!manifest?.rootRoutes?.length) return false;
    if (rootRoutes?.manifest !== manifest) {
      // With pages, a route for every path would leave none for them: such a route stays under /http.
      const everything = (r: { path?: string; pathPrefix?: string }) => r.pathPrefix === "/" || r.path === "/";
      const hidden = opts.app ? manifest.rootRoutes.filter(everything) : [];
      if (hidden.length)
        console.warn(
          `[forge] forge/http.ts serves ${[...new Set(hidden.map((r) => r.path ?? r.pathPrefix))].join(", ")} at the root, which would hide the app's pages: those routes stay under /http. Give them a prefix of their own, such as nest(http, { prefix: "/api/" }).`,
        );
      rootRoutes = { manifest, routes: manifest.rootRoutes.filter((r) => !hidden.includes(r)) };
    }
    const match = matchRoute(rootRoutes.routes, method, path);
    return "route" in match || match.status === 405;
  };
  const load = () => {
    const p = runtime.start().then(async (manifest) => {
      rpc = buildRpc(manifest, runtime, queries, subs, rpcOpts);
      if (manifest.release) telemetry?.release(manifest.release);
      telemetry?.describe({
        "telemetry.sdk.name": "archlast-forge",
        "telemetry.sdk.language": "javascript",
        "process.runtime.name": "bun",
        "process.runtime.version": Bun.version,
        "host.name": hostname(),
        "deployment.environment.name": dev ? "development" : "production",
        ...(manifest.release && { "service.version": manifest.release }),
        "forge.functions": manifest.functions.length,
        "forge.runtime_mode": config.runtimeMode,
      });
      await queries.reset().catch((e) => log("error", "cache reset failed", { error: String(e) })); // results from the old code are wrong
      subs.rerunAll();
      // The code's security headers (http.helmet(), nest(http, { helmet })): options Helmet refuses fail the load like other code errors.
      try {
        security.configure({ code: manifest.helmet ?? {} });
      } catch (e) {
        throw new Error(`forge/http.ts: the security headers' options were refused: ${(e as Error).message}`);
      }
      // In production a page or route the API docs would hide stops the start, rather than one of them silently losing the path.
      if (!dev) {
        const docs = await docsAt();
        if (docs?.clashes.size) throw new Error(`the API docs and the app both claim ${[...docs.clashes].join(", ")}: move the docs with http.docs({ path, openapi, explorer }) or API_DOCS_PATH`);
      }
      return manifest;
    });
    loading = p.catch(() => {});
    return p;
  };

  const reload = () => runtime.stop().then(load);
  let connections = 0;
  let shuttingDown = false;
  let warnedEcho = false;
  const sockets = new Set<ServerWebSocket<SocketData>>();

  const given = (name: string) => baseEnv[name] !== undefined && baseEnv[name] !== "";
  const storedSettings = async () => Object.fromEntries((await runtime.admin<{ name: string; value: string }[]>("settings.stored", {}, "system")).map((r) => [r.name, r.value]));
  const admin = buildAdminApi({
    runtime,
    subs,
    recentLogs,
    serverInfo: () => ({
      serverId,
      customFunctions: config.customFunctions,
      telemetry: Boolean(store),
      dashboardUrl: config.dashboardUrl ?? null,
      connections,
      subscriptions: subs.size,
      workers: runtime.size,
      uptimeMs: Math.round(process.uptime() * 1000),
    }),
    reload: () => reload(),
    cache: () => ({ ...queries.snapshot(), backend: config.redisUrl ? "redis" : "memory", maxBytes: config.redisUrl ? null : config.cacheMaxBytes }),
    clearCache: () => queries.clear(),
    customFunctions: config.customFunctions,
    telemetry: store,
    microservices: () => ({ self: config.serviceName, services: Object.entries(config.microservices).map(([name, url]) => ({ name, url })) }),
    source: (file, line) => sourceContext(resolve(opts.forgeDir), file, line),
    maxRequestBytes: maxBody,
    restart: opts.restart && (() => void opts.restart!().catch((e) => log("error", `restart failed: ${(e as Error).message}`))),
    async settings() {
      const rows = await runtime.admin<{ name: string; value: string; updatedAt: number; updatedBy: string | null }[]>("settings.stored", {}, "system");
      const now = new Map(rows.map((r) => [r.name, r]));
      return {
        restartable: Boolean(opts.restart),
        storedError: storedError ?? null,
        settings: SETTINGS.map((def) => {
          const saved = now.get(def.name);
          const source = given(def.name) ? "environment" : saved ? "dashboard" : "default";
          const value = source === "environment" ? baseEnv[def.name]! : saved?.value;
          return {
            ...def,
            source,
            isSet: value !== undefined,
            value: def.secret ? null : (value ?? null),
            updatedAt: saved?.updatedAt ?? null,
            updatedBy: saved?.updatedBy ?? null,
            // Saved, but this server started with something else: a restart applies it.
            pending: !def.live && source !== "environment" && (saved?.value ?? null) !== (startedWith[def.name] ?? null),
            ...(def.name === "RUNTIME_WORKERS" && {
              effective: `${runtime.size} running${pool.auto ? ` (auto: ${pool.cores} cores × ${pool.ratio})` : ""} · ${pool.cores} CPU cores detected${config.runtimeMode === "inline" ? " · inline mode: a restart changes the count" : ""}`,
            }),
          };
        }),
      };
    },
    waf: {
      async info(minutes) {
        const stored = await storedSettings();
        const draft = loadConfig({ ...withSettings(baseEnv, stored), WAF: "on" }, dev).waf!;
        return { ...firewall.snapshot(minutes), draft: settingsOf(draft), locked: WAF_FIELDS.filter(([, name]) => given(name)).map(([field]) => field) };
      },
      test: (input) => firewall.test(input as TestRequest),
      async save(input, actor) {
        const stored = await storedSettings();
        const changes: Record<string, string | null> = {};
        for (const [field, name] of WAF_FIELDS) {
          const raw = input[field];
          if (raw === undefined) continue;
          if (given(name)) throw new HttpError("BAD_REQUEST", `${name} is set in the environment, which wins over the dashboard: change it where the engine is deployed`);
          const def = SETTING.get(name)!;
          const text = field === "enabled" ? (raw ? "on" : "off") : Array.isArray(raw) ? raw.join(",") : String(raw);
          try {
            changes[name] = text.trim() === "" ? null : checkValue(def, text);
          } catch (e) {
            if (e instanceof ConfigError) throw new HttpError("BAD_REQUEST", e.message);
            throw e;
          }
        }
        const all = { ...stored };
        for (const [name, value] of Object.entries(changes)) if (value === null) delete all[name];
        else all[name] = value;
        try {
          validateSettings(baseEnv, all, dev);
          // Applied first: rules that don't load leave the firewall as it was, and nothing is saved.
          await firewall.apply(loadConfig(withSettings(baseEnv, all), dev).waf);
        } catch (e) {
          if (e instanceof ConfigError) throw new HttpError("BAD_REQUEST", e.message);
          throw new HttpError("BAD_REQUEST", `The firewall couldn't start with these settings: ${(e as Error).message}`);
        }
        for (const [name, value] of Object.entries(changes)) {
          await runtime.admin("settings.save", { name, value }, actor);
          if (value === null) delete startedWith[name];
          else startedWith[name] = value;
        }
        return firewall.snapshot();
      },
    },
    security: {
      async info() {
        const stored = await storedSettings();
        return {
          ...security.snapshot(),
          locked: { enabled: given("HELMET"), overrides: given("HELMET_CONFIG") },
          // What the dashboard has saved (the environment's, when it sets it): the page edits this.
          saved: parseOverrides(given("HELMET_CONFIG") ? baseEnv.HELMET_CONFIG : stored.HELMET_CONFIG),
        };
      },
      async save(input, actor) {
        const changes: Record<string, string | null> = {};
        if (input.enabled !== undefined) {
          if (given("HELMET")) throw new HttpError("BAD_REQUEST", "HELMET is set in the environment, which wins over the dashboard");
          changes.HELMET = input.enabled ? "on" : "off";
        }
        if (input.overrides !== undefined) {
          if (given("HELMET_CONFIG")) throw new HttpError("BAD_REQUEST", "HELMET_CONFIG is set in the environment, which wins over the dashboard");
          const text = JSON.stringify(input.overrides ?? {});
          try {
            parseOverrides(text);
          } catch (e) {
            throw new HttpError("BAD_REQUEST", (e as Error).message);
          }
          changes.HELMET_CONFIG = text === "{}" ? null : text;
        }
        const stored = await storedSettings();
        const all = { ...stored };
        for (const [k, v] of Object.entries(changes)) if (v === null) delete all[k];
        else all[k] = v;
        // Applied first: options Helmet refuses leave the headers as they were, and nothing is saved.
        try {
          security.configure(securityOf(all));
        } catch (e) {
          throw new HttpError("BAD_REQUEST", `Helmet refused these options: ${(e as Error).message}`);
        }
        for (const [name, value] of Object.entries(changes)) await runtime.admin("settings.save", { name, value }, actor);
        return security.snapshot();
      },
      clearReports: () => security.clearReports(),
    },
    async saveSetting(name, value, actor) {
      const def = SETTING.get(name);
      if (!def) throw new HttpError("NOT_FOUND", `No setting ${name}`);
      try {
        const next = value === null || value.trim() === "" ? null : checkValue(def, value);
        const rows = await runtime.admin<{ name: string; value: string }[]>("settings.stored", {}, "system");
        const all = Object.fromEntries(rows.map((r) => [r.name, r.value]));
        if (next === null) delete all[name];
        else all[name] = next;
        validateSettings(baseEnv, all, dev); // the engine must still start, and back up, with it
        // The security headers change while the server runs; options Helmet refuses aren't saved.
        if (name === "HELMET" || name === "HELMET_CONFIG")
          try {
            security.configure(securityOf(all));
          } catch (e) {
            throw new HttpError("BAD_REQUEST", (e as Error).message);
          }
        const overridden = baseEnv[name] !== undefined && baseEnv[name] !== "";
        // The firewall changes while the server runs: its new threads load the rules first, so rules that can't load stop the change here.
        const wafSetting = name === "WAF" || name.startsWith("WAF_");
        if (wafSetting && !overridden) {
          try {
            await firewall.apply(loadConfig(withSettings(baseEnv, all), dev).waf);
          } catch (e) {
            throw new HttpError("BAD_REQUEST", `The firewall couldn't start with this: ${(e as Error).message}`);
          }
        }
        await runtime.admin("settings.save", { name, value: next }, actor);
        // The pool's size applies at once in process mode: processes start, or finish their calls and stop. Into or out of inline mode needs a restart.
        let applied: string | undefined;
        if ((name === "RUNTIME_WORKERS" || name === "RUNTIME_WORKERS_RATIO") && !overridden && config.runtimeMode === "process") {
          const merged = withSettings(baseEnv, all);
          const wanted = loadConfig(merged, dev);
          if (wanted.runtimeMode === "process") {
            await runtime.resize(wanted.runtimeWorkers);
            pool = runtimeWorkersFor(merged);
            for (const n of ["RUNTIME_WORKERS", "RUNTIME_WORKERS_RATIO"]) {
              if (all[n] === undefined) delete startedWith[n];
              else startedWith[n] = all[n];
            }
            applied = `${runtime.size} function runtime process${runtime.size === 1 ? "" : "es"} running`;
          }
        }
        if (wafSetting && !overridden) {
          if (next === null) delete startedWith[name];
          else startedWith[name] = next;
          applied = "the firewall changed while running";
        }
        return { name, live: Boolean(def.live), overridden, ...(applied && { applied }) };
      } catch (e) {
        if (e instanceof ConfigError) throw new HttpError("BAD_REQUEST", e.message);
        throw e;
      }
    },
  });
  /** The OpenAPI documents (the public one, and in dev the complete one), made once per load of the code (a reload brings a new manifest), minified. */
  const openApi = new Map<string, { manifest: unknown; json: string; etag: string }>();
  async function openApiResponse(req: Request) {
    await loading;
    if (!runtime.manifest) return Response.json({ message: runtime.loadError ?? "The function runtime is not running" }, { status: 503 });
    // The complete document lists what the public one leaves out: development only.
    const audience = dev && new URL(req.url).searchParams.get("audience") === "all" ? "all" : "public";
    let cached = openApi.get(audience);
    if (cached?.manifest !== runtime.manifest) {
      const manifest = runtime.manifest;
      const doc = await runtime.admin<Record<string, unknown>>("openapi", { audience }, "system");
      // Calls go to the servers the app names, else the address browsers use: BETTER_AUTH_URL when it is set (a proxy in front may hide it from the request), else the one asked.
      const json = JSON.stringify(doc.servers ? doc : { ...doc, servers: [{ url: env.BETTER_AUTH_URL ? config.authUrl : new URL(req.url).origin }] });
      openApi.set(audience, (cached = { manifest, json, etag: `"${Bun.hash(json).toString(36)}"` }));
    }
    if (req.headers.get("if-none-match") === cached.etag) return new Response(null, { status: 304, headers: { etag: cached.etag } });
    return compressed(req, cached.json, { "content-type": "application/json", etag: cached.etag, "cache-control": "no-cache", "x-content-type-options": "nosniff" });
  }

  /**
   * Where the API docs are for the loaded code, when they are on: API_DOCS decides if it is set, else they are on in development, and in
   * production when `http.docs({ production: true })`. Paths an app route takes are left to the app (and reported once).
   */
  let docsPlan: { manifest: unknown; at: ApiDocsRouting | null; clashes: Set<string>; settled: boolean } | undefined;
  async function docsAt(): Promise<{ at: ApiDocsRouting; clashes: Set<string> } | null> {
    if (!runtime.manifest) await loading;
    const manifest = runtime.manifest;
    const plan = docsPlan;
    if (plan && plan.manifest === manifest && plan.settled) return plan.at && { at: plan.at, clashes: plan.clashes };
    const at = manifest?.docs ?? docsRouting(undefined, config.apiDocsPath);
    const on = config.apiDocs ?? (dev || at.production);
    if (!on) return void (docsPlan = { manifest, at: null, clashes: new Set(), settled: true }), null;
    const found = docsClashes(manifest, at);
    if (found.clashes.size && !(plan && plan.manifest === manifest && plan.clashes.size))
      log("error", `the API docs and the app both claim ${[...found.clashes].map((c) => `${c} (${found.why.get(c)})`).join(", ")}: the app keeps them. Move the docs with http.docs({ path, openapi, explorer }) or API_DOCS_PATH.`);
    docsPlan = { manifest, at, clashes: found.clashes, settled: found.settled };
    return { at, clashes: found.clashes };
  }
  /** Whether the API docs serve this path: one of their own that no app route takes. */
  function docsClaim({ at, clashes }: { at: ApiDocsRouting; clashes: Set<string> }, path: string) {
    const page = path === at.path || path === `${at.path}/` || path.startsWith(`${at.path}/_docs/`) || path === at.explorer;
    const claimed = (p: string) => !clashes.has(p) && !(p.startsWith(`${at.path}/_docs/`) && clashes.has(`${at.path}/_docs/`));
    return (path === at.openapi || page) && claimed(path.replace(/\/$/, "") || path);
  }
  /** The docs' own paths that one of the app's routes (a page, or a root-mounted HTTP route) also takes. Unsettled while the app isn't built. */
  function docsClashes(manifest: Manifest | undefined, at: ApiDocsRouting) {
    const clashes = new Set<string>();
    const why = new Map<string, string>();
    let settled = true;
    const owned = [at.path, at.openapi, ...(at.explorer ? [at.explorer] : []), `${at.path}/_docs/`];
    for (const p of owned) {
      const page = opts.app?.matches?.(p.endsWith("/") ? `${p}x` : p);
      if (page === undefined && opts.app?.matches) settled = false;
      if (page) (clashes.add(p), why.set(p, "a page in app/routes"));
      const route = manifest?.rootRoutes?.find((r) => r.path === p || (r.pathPrefix !== undefined && p.startsWith(r.pathPrefix) && r.pathPrefix !== "/"));
      if (route) (clashes.add(p), why.set(p, `forge/http.ts ${route.method} ${route.path ?? `${route.pathPrefix}*`}`));
    }
    return { clashes, why, settled };
  }

  const adminSessions = new Map<string, { admin: AdminInfo | null; at: number }>();
  async function adminOf(req: Request): Promise<AdminInfo | null> {
    // The main app's dashboard, calling this microservice for someone signed in there, with the role that app gave them.
    if (config.dashboardUrl) {
      const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
      if (token && sameSecret(token, config.dashboardToken!)) {
        const role = req.headers.get("x-forge-role");
        return { email: req.headers.get("x-forge-actor") || "dashboard", role: role === "owner" || role === "admin" ? role : "viewer" };
      }
    }
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
  const adminCookie = (token: string, maxAge: number) => `afx_admin=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${config.authUrl.startsWith("https://") ? "; Secure" : ""}`;

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

  const clientIp = (req: Request, srv: Server<SocketData>) => (config.trustProxy && lastForwarded(req.headers.get("x-forwarded-for"))) || srv.requestIP(req)?.address || "unknown";
  /** Seconds to wait when this client is over its rate limit; with no limit configured, null at once and the client's address is never looked up. */
  const limited = (req: Request, srv: Server<SocketData>, prefix = ""): Promise<number | null> | null => {
    const max = config.limits.rateLimitPerMinute;
    if (!max) return null;
    return limiter.consume(prefix + clientIp(req, srv), { window: 60, max }).then((r) => (r.allowed ? null : (r.retryAfter ?? 60)));
  };
  const tooMany = (retryAfter: number) => Response.json({ message: "Too many requests" }, { status: 429, headers: { "retry-after": String(retryAfter) } });

  async function handleAdmin(req: Request, path: string, requestId: string): Promise<Response> {
    // A custom header can't be sent cross-site without a CORS preflight, which this API never grants.
    if (req.method !== "GET" && req.headers.get("x-forge-admin") !== "1") return Response.json({ message: "Missing x-forge-admin header" }, { status: 403 });
    if (path === "/_admin/login" && req.method === "POST") {
      const body = (await readText(req, maxBody)
        .then((text) => JSON.parse(text))
        .catch(() => ({}))) as { email?: string; password?: string; key?: string };
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
    // A page of the dashboard showing one of this app's microservices: everything but telemetry, which this app holds for all of them.
    const target = new URL(req.url).searchParams.get("target");
    if (target && !path.startsWith("/_admin/obs.") && path !== "/_admin/me" && path !== "/_admin/microservices") return toMicroservice(req, path, target, who, requestId);
    // A backup archive: streamed from the backup folder, or a redirect to a presigned URL of its bucket. Owners only, like restoring.
    if (path === "/_admin/backups/download" && req.method === "GET") {
      if (who?.role !== "owner") return Response.json({ message: "Requires the owner role" }, { status: who ? 403 : 401 });
      const id = new URL(req.url).searchParams.get("id") ?? "";
      try {
        const at = await runtime.admin<{ name: string; path?: string; url?: string }>("backups.download", { id }, who.email);
        void runtime.admin("recordAudit", { action: "backups.download", target: id, details: "{}" }, who.email).catch(() => {});
        if (at.url) return Response.redirect(at.url, 302);
        return new Response(Bun.file(at.path!), {
          headers: { "content-type": "application/gzip", "content-disposition": `attachment; filename="${at.name}"`, "cache-control": "no-store" },
        });
      } catch (e) {
        return Response.json({ message: (e as Error).message }, { status: 400 });
      }
    }
    // A backup archive from somewhere else (another server, an older download): kept with the others, then restorable like them.
    if (path === "/_admin/backups/upload" && req.method === "POST") {
      if (who?.role !== "owner") return Response.json({ message: "Requires the owner role" }, { status: who ? 403 : 401 });
      const dir = join(config.dataDir, ".backup-tmp");
      mkdirSync(dir, { recursive: true });
      const tmp = join(dir, `upload-${crypto.randomUUID()}.tar.gz`);
      try {
        const declared = Number(req.headers.get("content-length") ?? NaN);
        if (declared > config.maxUploadBytes)
          throw new HttpError("PAYLOAD_TOO_LARGE", `Backups over ${config.maxUploadBytes / 2 ** 20} MB can't be uploaded here (MAX_UPLOAD_MB); restore it with \`archlast-forge restore\``);
        const sink = Bun.file(tmp).writer();
        let size = 0;
        try {
          if (req.body)
            for await (const chunk of req.body) {
              size += chunk.byteLength;
              if (size > config.maxUploadBytes) throw new HttpError("PAYLOAD_TOO_LARGE", `Backups over ${config.maxUploadBytes / 2 ** 20} MB can't be uploaded here (MAX_UPLOAD_MB)`);
              sink.write(chunk);
            }
        } finally {
          await sink.end();
        }
        return Response.json(await runtime.admin("backups.import", { path: tmp }, who.email));
      } catch (e) {
        rmSync(tmp, { force: true });
        if (e instanceof HttpError) return errorResponse({ message: e.message, code: e.code, requestId });
        return Response.json({ message: (e as Error).message }, { status: 400 });
      }
    }
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

  /** The same admin call, made to the microservice `name` (MICROSERVICES) for the dashboard user `who`; that service checks their role as its own. */
  async function toMicroservice(req: Request, path: string, name: string, who: AdminInfo | null, requestId: string): Promise<Response> {
    if (!who) return Response.json({ message: "Sign in to the dashboard" }, { status: 401 });
    const base = Object.hasOwn(config.microservices, name) ? config.microservices[name] : undefined;
    if (!base) return Response.json({ message: `No microservice named "${name}": MICROSERVICES lists ${Object.keys(config.microservices).join(", ") || "none"}` }, { status: 404 });
    const url = new URL(req.url);
    url.searchParams.delete("target");
    const headers = new Headers({ authorization: `Bearer ${config.dashboardToken}`, "x-forge-actor": who.email, "x-forge-role": who.role, "x-forge-admin": "1", "x-request-id": requestId });
    for (const h of ["content-type", "content-length", "accept"]) if (req.headers.get(h)) headers.set(h, req.headers.get(h)!);
    try {
      const res = await fetch(`${base}${path}${url.search}`, {
        method: req.method,
        headers,
        body: req.body,
        redirect: "manual",
        signal: req.signal,
        ...(req.body && { duplex: "half" }),
      } as RequestInit);
      const out = new Headers(res.headers);
      // fetch has already decoded the body, and a session cookie of the service's has no business on this app's origin.
      for (const h of ["content-encoding", "content-length", "set-cookie", "transfer-encoding", "connection"]) out.delete(h);
      // The log stream ends quietly when the service goes away (a restart): the dashboard's EventSource connects again. Anything else (a
      // backup download) fails loudly rather than arrive cut short.
      if (res.body && out.get("content-type")?.startsWith("text/event-stream")) {
        const upstream = res.body.getReader();
        const events = new ReadableStream<Uint8Array>({
          async pull(c) {
            const next = await upstream.read().catch(() => ({ done: true as const, value: undefined }));
            if (next.done) c.close();
            else c.enqueue(next.value);
          },
          cancel: (reason) => upstream.cancel(reason),
        });
        return new Response(events, { status: res.status, headers: out });
      }
      return new Response(res.body, { status: res.status, headers: out });
    } catch (e) {
      if (req.signal.aborted) return new Response(null, { status: 499 });
      return Response.json({ message: `${name} (${base}) didn't answer: ${(e as Error).message}` }, { status: 502 });
    }
  }

  // The WAF starts before the server listens: a configuration that can't work (the rules, the module) stops the engine here, not after it is up and unguarded.
  // It is there when it is off too, so the dashboard can switch it on.
  // The WAF leaves alone what the engine answers itself, and only where it does: a path it doesn't serve (no dashboard, S3 storage, a file
  // that isn't there) goes to the app's code and is inspected. Where the API docs are is known once the request handler has asked (docsAt,
  // before the WAF's check).
  const firewall = new Firewall(WAF_WORKER, async (method, path) => {
    const under = (p: string) => path === p || path.startsWith(`${p}/`);
    if (dashboardPage && under("/_dashboard")) return "/_dashboard is the engine's own";
    if (path.startsWith("/_admin/")) return "/_admin is the engine's own";
    if (localFiles && path.startsWith("/_storage/")) return "/_storage is the engine's own";
    if (method === "POST" && path === "/_telemetry") return "/_telemetry is the engine's own";
    if (method === "POST" && path === CSP_REPORT_PATH) return `${CSP_REPORT_PATH} is the engine's own`;
    const plan = docsPlan;
    if (plan?.at && docsClaim({ at: plan.at, clashes: plan.clashes }, path)) return "the API docs are the engine's own";
    if ((method === "GET" || method === "HEAD") && (await opts.app?.serves?.(path))) return "the app's files aren't inspected";
    return undefined;
  });
  await firewall.apply(config.waf);
  metrics.waf = () => (firewall.enabled ? { ...firewall.stats.counters, rules: firewall.stats.ruleCounts() } : undefined);

  dashboardPage?.warm(); // built while the server starts, so the first visit doesn't wait
  const server = Bun.serve<ServerSocket>({
    port: config.port,
    hostname: config.hostname,
    maxRequestBodySize: takesUploads ? Math.max(config.limits.maxRequestBytes, config.maxUploadBytes) : config.limits.maxRequestBytes,
    idleTimeout: Math.min(config.idleTimeoutSeconds, 255), // Bun's own ceiling
    // The dashboard is bundled in production mode everywhere, dev included: minified, with React's production build (which the engine image
    // has, so a development bundle there renders a blank page). Its source isn't watched; edits to it show after a restart.
    development: false,
    routes: config.dashboardUrl
      ? { "/_dashboard": () => Response.redirect(`${config.dashboardUrl}/_dashboard#/microservices`, 302) }
      : {},
    async fetch(req, srv) {
      const url = new URL(req.url);
      const path = url.pathname;
      const requestId = requestIdOf(req.headers.get("x-request-id"));
      const withId = (res: Response) => (res.headers.set("x-request-id", requestId), res);

      if (path === "/health") return Response.json({ ok: true });
      if (path === "/ready")
        return Response.json(
          { ready: !shuttingDown && Boolean(runtime.manifest) && !runtime.loadError, error: runtime.loadError },
          { status: !shuttingDown && runtime.manifest && !runtime.loadError ? 200 : 503 },
        );
      // Content-Security-Policy violation reports from browsers (the app's pages and the dashboard), for the dashboard's Security page.
      if (path === CSP_REPORT_PATH && req.method === "POST") {
        const retry = await limited(req, srv, "csp:");
        if (retry) return tooMany(retry);
        try {
          const body = JSON.parse(await readText(req, 64 * 1024));
          security.record(body, (page) => (page === "/_dashboard" || page.startsWith("/_dashboard/") ? "dashboard" : "app"));
        } catch {}
        return new Response(null, { status: 204 });
      }
      if (dashboardPage && (path === "/_dashboard" || path.startsWith("/_dashboard/"))) {
        const page = await dashboardPage.serve(req, path);
        if (page) return security.apply("dashboard", page);
        return security.apply("dashboard", new Response("Not found", { status: 404 }));
      }
      // The CLI's data commands. They run in the function runtime, which owns the database, so imports reach subscribers and nothing contends with the server for the write lock.
      if (path === "/_cli" && req.method === "POST") {
        const retry = await limited(req, srv, "cli:");
        if (retry) return withId(tooMany(retry));
        const key = req.headers.get("x-admin-key");
        if (!key || !config.adminKey || !sameSecret(key, config.adminKey)) return withId(Response.json({ message: "Invalid admin key" }, { status: 401 }));
        const body = (await readText(req, maxBody)
          .then((text) => JSON.parse(text))
          .catch(() => null)) as { cmd?: string; args?: Record<string, unknown> } | null;
        if (!body?.cmd) return withId(Response.json({ message: "Expected {cmd, args}" }, { status: 400 }));
        try {
          return withId(Response.json({ result: await runtime.admin("cli", { cmd: body.cmd, args: body.args ?? {} }, "cli") }));
        } catch (e) {
          return withId(Response.json({ message: (e as Error).message }, { status: 400 }));
        }
      }
      // OTLP/HTTP ingest: other services' traces, logs and metrics, protobuf or JSON, optionally gzipped.
      if (path.startsWith("/otlp/v1/") && req.method === "POST") {
        const signal = path.slice("/otlp/v1/".length);
        if (!store || !["traces", "logs", "metrics"].includes(signal)) return withId(new Response("Not found", { status: 404 }));
        const retry = await limited(req, srv, "otlp:");
        if (retry) return withId(tooMany(retry));
        // An engine exporting to this one under this one's name: most likely its own exporter, pointed back here by an
        // OTEL_EXPORTER_OTLP_ENDPOINT meant for other services. It records these requests already, so they would count twice.
        if (req.headers.get("x-forge-service") === config.serviceName) {
          if (!warnedEcho) {
            warnedEcho = true;
            log(
              "warn",
              `ignoring OTLP from an archlast-forge engine named "${config.serviceName}", like this one: point OTEL_EXPORTER_OTLP_ENDPOINT at a collector, not at this app, or give the other engine its own OTEL_SERVICE_NAME`,
            );
          }
          return withId(Response.json({})); // the engine's exporter sends JSON
        }
        const key = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "") || req.headers.get("x-api-key") || req.headers.get("x-forge-key");
        let service: string | null | undefined;
        if (key && config.adminKey && sameSecret(key, config.adminKey)) service = null;
        else if (key) service = (await ingestKey(key))?.service;
        else if (dev) service = null; // in development, local services report without a key
        if (service === undefined)
          return withId(Response.json({ message: "Send an ingest key: Authorization: Bearer <key> (create one on the dashboard's Ingest keys page)" }, { status: 401 }));
        try {
          const encoding = req.headers.get("content-encoding")?.toLowerCase();
          if (encoding && !["gzip", "deflate", "identity"].includes(encoding)) return withId(Response.json({ message: `Unsupported content-encoding ${encoding}` }, { status: 415 }));
          const type = req.headers.get("content-type") ?? "application/x-protobuf";
          // The telemetry thread decompresses it: inflating here would hold up every request.
          const payload = await readBytes(req, maxBody);
          await store.ingest(
            signal as "traces" | "logs" | "metrics",
            payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength) as ArrayBuffer,
            type,
            service,
            encoding === "identity" ? undefined : (encoding as "gzip" | "deflate" | undefined),
          );
          return withId(type.includes("json") ? Response.json({}) : new Response(new Uint8Array(0), { headers: { "content-type": "application/x-protobuf" } }));
        } catch (e) {
          if (e instanceof HttpError) return withId(errorResponse({ message: e.message, code: e.code, requestId }));
          return withId(Response.json({ message: `Could not read the OTLP payload: ${(e as Error).message}` }, { status: 400 }));
        }
      }
      if (path === "/metrics") {
        const auth = req.headers.get("authorization")?.replace(/^Bearer /, "");
        const token = env.METRICS_TOKEN || config.adminKey;
        if (token ? !(auth && sameSecret(auth, token)) : !dev) return new Response("Not found", { status: 404 });
        return new Response(metrics.render({ subscriptions: subs.size, connections, workers: runtime.size, backlog: runtime.backlog() }, queries.snapshot(), loops), {
          headers: { "content-type": "text/plain; version=0.0.4" },
        });
      }
      if (shuttingDown) return withId(Response.json({ message: "Server is shutting down" }, { status: 503, headers: { "retry-after": "1" } }));

      // Where the API docs are for the loaded code (before the WAF, which leaves their pages alone).
      const docs = config.apiDocs === false ? null : await docsAt();

      // The WAF: everything below is what an attacker would reach (functions, auth, HTTP endpoints, pages), minus what the engine serves itself.
      if (firewall.enabled) {
        const outcome = await firewall.check(req, url, { address: clientIp(req, srv), port: srv.requestIP(req)?.port ?? 0 }, srv.port ?? config.port, maxBody, requestId);
        if (outcome.kind === "block") return cors(req, withId(errorResponse({ message: "The request was blocked by the web application firewall", code: "FORBIDDEN", requestId })));
        if (outcome.kind === "error" && outcome.refuse) return cors(req, withId(errorResponse({ message: "The web application firewall is unavailable", code: "SERVICE_UNAVAILABLE", requestId })));
      }

      // The API docs own a few exact paths and their assets' prefix; anything else below their path is the app's (its own pages under /docs).
      if (docs && docsClaim(docs, path)) {
        const { at } = docs;
        const retry = await limited(req, srv);
        if (retry) return withId(tooMany(retry));
        if (path === at.openapi) return withId(await openApiResponse(req));
        const served = await opts.apiDocs?.serve(req, {
          base: at.path,
          publicBase: at.basePath + at.path,
          openapiUrl: at.basePath + at.openapi,
          explorerPath: at.explorer,
          dev,
          forgeDir: resolve(opts.forgeDir),
          page: at.page,
        });
        if (served) return withId(served);
        if (path === at.path && !opts.apiDocs)
          return withId(Response.json({ message: `The docs page comes with @archlast/forge-dashboard; the OpenAPI document is at ${at.basePath}${at.openapi}` }, { status: 404 }));
        // Anything else falls through to the app's routes, which may have a page here.
      }
      if (localFiles && path.startsWith("/_storage/")) {
        const retry = await limited(req, srv, "storage:");
        if (retry) return withId(tooMany(retry));
        if (req.method === "PUT") srv.timeout(req, 0); // a large upload over a slow line
        return withId(await serveLocalStorage(req, localFiles, config.maxUploadBytes));
      }
      if (path === "/rpc" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
        if (!originAllowed(req)) return new Response("Origin not allowed. Add it to TRUSTED_ORIGINS.", { status: 403 });
        const retry = await limited(req, srv);
        if (retry) return tooMany(retry);
        const ip = config.limits.rateLimitPerMinute ? clientIp(req, srv) : undefined;
        const data: SocketData = { headers: pickAuthHeaders((n) => req.headers.get(n)), requestId, traceparent: req.headers.get("traceparent") ?? undefined, ip, live: new Map() };
        if (srv.upgrade(req, { data })) return;
        return new Response("WebSocket upgrade failed", { status: 400 });
      }
      // HTTP actions (forge/http.ts): under /http, and at the root for a router with `root: true` when the path is none of the engine's
      // own. Before the OPTIONS branch below, so a route can answer its own preflight and set its own headers.
      const httpPath = path === "/http" || path.startsWith("/http/") ? path.slice("/http".length) || "/" : (await atRoot(req.method, path)) ? path : undefined;
      if (httpPath !== undefined) {
        const routed = new URL(req.url);
        routed.pathname = httpPath; // the handler sees the path it registered
        // A WebSocket for a Nest gateway (or GraphQL subscriptions): the socket is the server's, its events go to the function runtime.
        if (req.headers.get("upgrade")?.toLowerCase() === "websocket") {
          if (!originAllowed(req)) return new Response("Origin not allowed. Add it to TRUSTED_ORIGINS.", { status: 403 });
          const retry = await limited(req, srv);
          if (retry) return tooMany(retry);
          await loading;
          const ip = config.limits.rateLimitPerMinute ? clientIp(req, srv) : undefined;
          const gateway = { sid: crypto.randomUUID(), path: routed.pathname + routed.search, headers: [...req.headers] as [string, string][] };
          const data: ServerSocket = { headers: pickAuthHeaders((n) => req.headers.get(n)), requestId, ip, live: new Map(), gateway };
          if (srv.upgrade(req, { data, headers: subprotocol(req) })) return;
          return new Response("WebSocket upgrade failed", { status: 400 });
        }
        const retry = await limited(req, srv);
        if (retry) return withId(tooMany(retry));
        await loading;
        let body: ArrayBuffer | undefined;
        try {
          const bytes = req.method === "GET" ? undefined : await readBytes(req, maxBody);
          body = bytes && (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
        } catch (e) {
          if (e instanceof HttpError) return withId(errorResponse({ message: e.message, code: e.code, requestId }));
          throw e;
        }
        // Socket.IO's long-polling requests carry EIO=; their sessions live where its sockets do, on worker 0. They are not requests to record.
        const worker = routed.searchParams.has("EIO") ? 0 : undefined;
        const root =
          worker === undefined
            ? telemetry?.begin("http", `${req.method} ${normalizePath(routed.pathname)}`, req.method, req.headers.get("traceparent"), requestId, { "url.path": routed.pathname })
            : undefined;
        try {
          const r = await runtime.http(
            { method: req.method, url: routed.href, headers: [...req.headers], body },
            pickAuthHeaders((n) => req.headers.get(n)),
            requestId,
            worker,
            root && telemetry!.parent(root),
          );
          if (root) {
            const route = r.telemetry?.attrs?.["http.route"];
            root.operation = route ? `${req.method} ${route}` : r.status === 404 ? `${req.method} (unmatched)` : root.operation;
            telemetry!.end(root, {
              status: r.status,
              telemetry: r.telemetry,
              ...(r.status >= 500 && { error: { type: `HTTP ${r.status}`, message: `${root.operation} answered ${r.status}`, handled: false } }),
            });
          }
          // A body on a 204 or 304 is an error in a Response.
          const out = r.body instanceof ReadableStream ? r.body : r.body.byteLength ? r.body : null;
          const res = new Response(out, { status: r.status, headers: r.headers });
          return withId(r.nest ? security.apply("api", res) : res);
        } catch (e) {
          if (root) telemetry!.end(root, failureOf(e));
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
      // RFC 8414 (and OpenID Connect's form of it) puts an authorization server's metadata at the root, with the issuer's path after the
      // well-known name. The issuer is <origin>/api/auth, so /.well-known/oauth-authorization-server/api/auth is the document Better Auth
      // serves at /api/auth/.well-known/oauth-authorization-server (the OAuth Provider plugin's; without the plugin, its 404).
      const wellKnown = req.method === "GET" || req.method === "HEAD" ? WELL_KNOWN_AUTH.exec(path) : null;
      const authPath = wellKnown ? `/api/auth/.well-known/${wellKnown[1]}` : path;
      if (path.startsWith("/rpc/") || authPath.startsWith("/api/auth")) {
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
      if (authPath.startsWith("/api/auth")) {
        let body: string | undefined;
        try {
          body = req.method === "GET" || req.method === "HEAD" ? undefined : await readText(req, maxBody);
        } catch (e) {
          if (e instanceof HttpError) return cors(req, withId(errorResponse({ message: e.message, code: e.code, requestId })));
          throw e;
        }
        const root = telemetry?.begin("auth", `${req.method} ${normalizePath(path)}`, req.method, req.headers.get("traceparent"), requestId);
        try {
          const headers: [string, string][] = [...req.headers].filter(([k]) => k !== CLIENT_IP_HEADER);
          headers.push([CLIENT_IP_HEADER, clientIp(req, srv)]);
          const r = await runtime.auth({ method: req.method, url: wellKnown ? new URL(authPath + url.search, url).href : req.url, headers, body }, root && telemetry!.parent(root));
          if (root) telemetry!.end(root, { status: r.status, telemetry: r.telemetry });
          return cors(req, withId(new Response(r.body, { status: r.status, headers: r.headers })));
        } catch (e) {
          if (root) telemetry!.end(root, { ...failureOf(e), status: 503 });
          const err = toPublicError(e, requestId, dev, { path });
          return cors(req, withId(Response.json({ message: err.message }, { status: 503 })));
        }
      }
      // A microservice's telemetry (it has DASHBOARD_URL pointing here), in the batches its recorder makes.
      if (path === "/_telemetry" && req.method === "POST") {
        if (!store || !config.dashboardToken) return withId(new Response("Not found", { status: 404 }));
        const token = req.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
        if (!token || !sameSecret(token, config.dashboardToken)) return withId(Response.json({ message: "Send the DASHBOARD_TOKEN this app has" }, { status: 401 }));
        try {
          const batch = JSON.parse(await readText(req, maxBody)) as TelemetryBatch;
          if (!batch || typeof batch !== "object" || Array.isArray(batch)) throw new Error("Expected a telemetry batch");
          // Under this app's own name its numbers would add up with this app's, as if one service.
          if ([...(batch.rollups ?? []), ...(batch.samples ?? []), ...(batch.services ?? [])].some((x) => x?.service === config.serviceName))
            return withId(Response.json({ message: `A microservice reported as "${config.serviceName}", this app's own name: give it its own OTEL_SERVICE_NAME` }, { status: 409 }));
          store.write(batch);
          return withId(Response.json({}));
        } catch (e) {
          if (e instanceof HttpError) return withId(errorResponse({ message: e.message, code: e.code, requestId }));
          return withId(Response.json({ message: (e as Error).message }, { status: 400 }));
        }
      }
      if (path.startsWith("/_admin/")) {
        if (!adminApi) return new Response("Not found", { status: 404 });
        if (path === "/_admin/login") {
          const retry = await limited(req, srv, "admin:");
          if (retry) return withId(tooMany(retry));
        }
        return withId(adminResponse(await handleAdmin(req, path, requestId)));
      }
      if (opts.app) {
        await loading;
        const headers = pickAuthHeaders((n) => req.headers.get(n));
        const publicError = (e: unknown) => {
          const err = toPublicError(e, requestId, dev, { path });
          return err.data !== undefined ? new ForgeError(err.data) : Object.assign(new Error(err.message), { code: err.code, requestId });
        };
        // A page render is a request; the calls its loaders make are its spans. Only documents (and failures) are kept: not assets.
        const root = telemetry?.begin("page", `${req.method} ${normalizePath(path)}`, req.method, req.headers.get("traceparent"), requestId, { "url.path": path });
        const spans: Span[] = [];
        let user: { id: string; name?: string } | undefined;
        const keep = (obs: QueryObserver | { telemetry?: QueryObserver["telemetry"] }, name: string, started: number) => {
          if (!root?.detail) return;
          if (obs.telemetry) {
            spans.push(...obs.telemetry.spans);
            user ??= obs.telemetry.user;
          } else
            spans.push({
              traceId: root.traceId,
              spanId: newSpanId(),
              parentId: root.spanId,
              name,
              type: "cache",
              kind: 1,
              start: started,
              duration: clock() - started,
              status: 1,
              attrs: { "forge.cache": (obs as QueryObserver).cache ?? "hit" },
            });
        };
        let res: Response | undefined;
        // A fresh nonce per page, when the app's policy limits scripts: its inline scripts carry it, and the policy names it.
        const nonce = security.wantsNonce("app") ? Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64") : undefined;
        try {
          res = await opts.app.fetch(req, {
            requestId,
            dev,
            ...(nonce && { nonce }),
            headers,
            async call(name, kind, args) {
              const started = clock();
              const obs: QueryObserver = root
                ? {
                    get trace() {
                      return telemetry!.parent(root);
                    },
                  }
                : {};
              try {
                if (kind === "query") {
                  // A copy: the result may be the object the query cache keeps, and a page is free to change what it gets.
                  const r = await queries.run(name, (args ?? {}) as Record<string, unknown>, headers, requestId, undefined, obs);
                  keep(obs, name, started);
                  return r.json !== undefined ? JSON.parse(r.json) : structuredClone(r.value);
                }
                const r = await runtime.call(name, kind, args ?? {}, headers, { requestId, trace: obs.trace });
                keep(r, name, started);
                return r.value;
              } catch (e) {
                keep({ telemetry: failureOf(e).telemetry }, name, started);
                throw publicError(e);
              }
            },
            identity: () =>
              queries.who(headers).then(
                (c) => c.identity,
                (e) => Promise.reject(publicError(e)),
              ),
            rateLimited: async () => (await limited(req, srv)) ?? null,
            keepAlive: () => srv.timeout(req, 0),
            route: (pattern) => {
              if (root) root.operation = `${req.method} ${pattern}`;
            },
          });
        } catch (e) {
          if (root) telemetry!.end(root, { ...failureOf(e), status: 500, spans, user });
          throw e;
        }
        if (root) {
          const document = res?.headers.get("content-type")?.includes("text/html");
          telemetry!.end(root, {
            status: res?.status ?? 404,
            spans,
            user,
            discard: !res || (!document && res.status < 500),
            ...(res && res.status >= 500 && { error: { type: `HTTP ${res.status}`, message: `${root.operation} answered ${res.status}`, handled: false } }),
          });
        }
        // The nonce is for documents; the app's files and JSON get the policy without it.
        if (res) return security.apply("app", res, res.headers.get("content-type")?.includes("text/html") ? nonce : undefined);
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
        const g = ws.data.gateway;
        if (!g) return;
        gatewaySockets.set(g.sid, ws);
        runtime.wsEvent({ t: "ws", op: "open", sid: g.sid, path: g.path, headers: g.headers, requestId: ws.data.requestId });
      },
      async message(ws, msg) {
        if (config.limits.rateLimitPerMinute) {
          const r = await limiter.consume(ws.data.ip ?? "unknown", { window: 60, max: config.limits.rateLimitPerMinute });
          if (!r.allowed) return ws.close(1008, "Too many requests");
        }
        await loading; // a socket can connect before the function runtime has loaded, as an HTTP request can
        const g = ws.data.gateway;
        if (g)
          runtime.wsEvent({ t: "ws", op: "message", sid: g.sid, data: typeof msg === "string" ? msg : (msg.buffer.slice(msg.byteOffset, msg.byteOffset + msg.byteLength) as ArrayBuffer) });
        else if (typeof msg === "string") rpc.message(ws, msg);
      },
      close(ws, code, reason) {
        connections--;
        sockets.delete(ws);
        const g = ws.data.gateway;
        if (!g) return rpc.close(ws);
        gatewaySockets.delete(g.sid);
        runtime.wsEvent({ t: "ws", op: "close", sid: g.sid, code, reason });
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

  // This process's health every 10 seconds, with the connections, subscriptions and cache figures only the server knows. The cache
  // counters are totals since start; a sample carries what happened since the one before.
  let sampled = { hits: 0, misses: 0, coalesced: 0 };
  const health = processSampler();
  let warnedBusy = 0;
  const takeSample = () => {
    // A function runtime with seconds of queries waiting is the ceiling of the app: say so before callers start seeing "busy" and timeouts.
    const backlog = runtime.backlog();
    const busy = backlog.findIndex((b) => b.waitMs > 2000);
    if (busy >= 0 && Date.now() - warnedBusy > 60_000) {
      warnedBusy = Date.now();
      const cores = availableParallelism();
      log(
        "warn",
        `function runtime ${busy} has ${backlog[busy]!.waiting} queries waiting, about ${(backlog[busy]!.waitMs / 1000).toFixed(1)} s of work${cores > backlog.length ? `. This machine has ${cores} cores and runs ${backlog.length} function runtime${backlog.length === 1 ? "" : "s"}: RUNTIME_WORKERS=${Math.min(cores - 1, 4)} would spread them` : ""}. Queries that every user runs alike can share one run (see \`access\` in the docs)`,
      );
    }
    const c = queries.snapshot();
    const cache = c.enabled ? { cacheHits: c.hits - sampled.hits, cacheMisses: c.misses - sampled.misses, cacheShared: c.coalesced - sampled.coalesced, cacheEntries: c.entries } : {};
    sampled = { hits: c.hits, misses: c.misses, coalesced: c.coalesced };
    const h = health();
    loops.set(serverId, { role: "server", p99: h.loopP99, max: h.loopMax });
    telemetry?.sample({ time: Date.now(), instance: serverId, role: "server", ...h, connections, subscriptions: subs.size, inflight: telemetry.inflight, ...cache });
  };
  const sampler = setInterval(takeSample, 10_000);
  sampler.unref?.();
  // A first sample soon after start, so a node a scaler just added is on the dashboard's Nodes page at once rather than 10 s later.
  const firstSample = setTimeout(takeSample, 1000);
  firstSample.unref?.();

  return {
    url,
    config,
    runtime,
    reload,
    async stop({ graceful = true, keepApp = false } = {}) {
      shuttingDown = true;
      clearInterval(sampler);
      clearTimeout(firstSample);
      // 1012 "service restart": clients reconnect (to another server, behind a load balancer) and refetch.
      for (const ws of sockets) ws.close(1012, "Server restarting");
      if (graceful) await Promise.race([server.stop(false), Bun.sleep(10_000)]);
      server.stop(true);
      if (!keepApp) await opts.app?.dispose?.();
      await runtime.stop();
      await bus.close();
      await cache?.close();
      await telemetry?.close();
      await store?.close();
      firewall.close();
    },
  };
}
