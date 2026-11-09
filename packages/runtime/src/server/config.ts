import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_REDIS_PREFIX } from "./bus";
import { serverCores } from "./cores";

export { serverCores };


/**
 * The function runtime processes `RUNTIME_WORKERS` asks for: a number, or `auto`, which is the cores times `RUNTIME_WORKERS_RATIO` (0.5 by
 * default: half the cores, leaving the rest to the server process, the database and whatever else runs there), rounded down, at least 1.
 */
/**
 * The prefix of this app's Redis keys: the identity of the service, so every server of one service has the same and two services differ.
 *  - REDIS_PREFIX, when it is set.
 *  - Else `archlast-forge:<service>:` from OTEL_SERVICE_NAME, the name the dashboard knows the service by (`init` gives every app of a
 *    monorepo its own, and every server of a service has the same).
 *  - Else `archlast-forge:`, what the engine always used: an app that names nothing keeps its keys when the engine is upgraded.
 * It doesn't depend on a secret, so rotating one moves nothing.
 */
export function redisPrefixOf(env: Record<string, string | undefined>): string {
  const given = env.REDIS_PREFIX?.trim();
  if (given) {
    if (!/^[A-Za-z0-9._:-]{1,64}$/.test(given)) throw new ConfigError(`REDIS_PREFIX must be 1 to 64 letters, digits, ".", "_", "-" or ":", got "${given}"`);
    return given.endsWith(":") ? given : `${given}:`;
  }
  const service = env.OTEL_SERVICE_NAME?.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return service && service !== "archlast-forge" ? `${DEFAULT_REDIS_PREFIX}${service}:` : DEFAULT_REDIS_PREFIX;
}

/** What tells one app from another that has the same prefix, and the same for every server of an app: a hash of its secret (its data folder in development). */
export function redisOwnerOf(config: Pick<Config, "authSecret" | "dataDir">): string {
  return createHash("sha256").update("redis-owner\0").update(config.authSecret ? `secret:${config.authSecret}` : `dir:${resolve(config.dataDir)}`).digest("hex").slice(0, 16);
}

export function runtimeWorkersFor(env: Record<string, string | undefined>, cores = serverCores()): { workers: number; auto: boolean; ratio: number; cores: number } {
  const rawRatio = env.RUNTIME_WORKERS_RATIO?.trim();
  const ratio = rawRatio ? Number(rawRatio) : 0.5;
  if (!(ratio > 0 && ratio <= 4)) throw new ConfigError(`RUNTIME_WORKERS_RATIO must be a number above 0 and at most 4, got "${rawRatio}"`);
  const raw = env.RUNTIME_WORKERS?.trim();
  if (raw === "auto") return { workers: Math.max(1, Math.floor(cores * ratio)), auto: true, ratio, cores };
  const workers = raw ? Number(raw) : 1;
  if (!Number.isInteger(workers) || workers < 1) throw new ConfigError(`RUNTIME_WORKERS must be an integer ≥ 1 or "auto", got "${raw}"`);
  return { workers, auto: false, ratio, cores };
}

export interface Limits {
  /** Per-call time limit for queries and mutations. */
  functionTimeoutMs: number;
  actionTimeoutMs: number;
  maxResultBytes: number;
  maxDocumentBytes: number;
  maxRequestBytes: number;
  /** Requests (HTTP calls and WebSocket messages) per client IP per minute. 0 disables. */
  rateLimitPerMinute: number;
  maxSubscriptionsPerConnection: number;
  /** The JSON size of one subscribe message; one connection's live queries together may hold 16 times this. */
  maxSubscriptionBytes: number;
  /** WebSockets one client IP (an IPv6 /64) may hold open on this server. 0 disables. */
  maxConnectionsPerIp: number;
  /** Calls waiting for one function runtime process; past this, new calls are refused with 503 instead of queueing. */
  maxPendingCalls: number;
}

/** The web application firewall (WAF=on). */
export interface WafConfig {
  /** `block` stops what the rules flag; `detect` only logs it, to see what a rollout would stop. */
  mode: "block" | "detect";
  /** CRS paranoia level, 1 (fewest false positives) to 4. */
  paranoia: number;
  /** Threads, each with its own copy of the rules in memory (a good 100 MB each). */
  workers: number;
  /** The most of a request body that is inspected; a body over it isn't (its URL and headers still are). */
  maxBodyBytes: number;
  /** Path prefixes whose requests aren't inspected, besides the engine's own (the dashboard and its API, storage, the app's built files). */
  ignorePaths: string[];
  /** CRS rule ids switched off, for a rule that stops something legitimate in this app. */
  disabledRules: number[];
}

export interface Config {
  dev: boolean;
  port: number;
  hostname: string;
  dataDir: string;
  databaseUrl?: string;
  /** Which database `databaseUrl` is: SQLite when there is none. */
  databaseKind: "sqlite" | "postgres" | "mongodb";
  /** Postgres connections each function-runtime process opens for reads (DATABASE_POOL_SIZE); unset: sized from the database (`db/pool-size.ts`). */
  databasePoolSize?: number;
  /** SQLite's `synchronous` for the app database (SQLITE_SYNCHRONOUS): `FULL` syncs every commit, `NORMAL` only at checkpoints. */
  sqliteSynchronous: "FULL" | "NORMAL";
  /** What runs SQLite (DB_ENGINE): bun:sqlite, or the native layer in packages/db. */
  dbEngine: "bun" | "native";
  /** SERVER_PROCESSES: how many servers of this app share the machine's port (a cluster, see cluster.ts), or `auto`: one for every two cores, from 4 cores. */
  serverProcesses: number | "auto";
  /** The cluster this process is in: its size once it is worked out (the CLI's supervisor tells each process), and this process's place (0 is the first, which keeps the singleton work). */
  clusterSize: number;
  clusterIndex: number;
  /** Postgres connections for write transactions (DATABASE_WRITE_POOL_SIZE); unset: twice DATABASE_POOL_SIZE when that is set, else sized from the database. */
  databaseWritePoolSize?: number;
  redisUrl?: string;
  /**
   * What the engine's Redis keys and channels start with (REDIS_PREFIX, else from the service name: see redisPrefixOf). Servers of one service
   * share it; services that share a Redis don't, so their cached results, topics and rate limits stay apart. It always ends with ":".
   */
  redisPrefix: string;
  s3?: S3Config;
  /** Where files live: an S3 bucket, the engine's own disk (DATA_DIR/storage), or nowhere. */
  storage: "s3" | "local" | "off";
  /** Where browsers reach the engine's own storage; BETTER_AUTH_URL unless STORAGE_PUBLIC_URL says otherwise. */
  storagePublicUrl: string;
  /** The largest body the built-in storage takes for one file, and the dashboard for an uploaded backup. */
  maxUploadBytes: number;
  adminKey?: string;
  /** Serve /_dashboard and the admin API. Off by default outside dev. */
  dashboard: boolean;
  /** API_DOCS: serve the OpenAPI document and the docs page, or not; unset, the code decides (on in dev, and in production with `http.docs({ production: true })`). */
  apiDocs?: boolean;
  /** API_DOCS_PATH: where the docs page is, over what `http.docs({ path })` says. */
  apiDocsPath?: string;
  authSecret?: string;
  authUrl: string;
  trustedOrigins: string[];
  replicas: number;
  /** TTL for cached query results. 0 disables the cache. */
  cacheTtlMs: number;
  /** Lets owners run code written in the dashboard. That is arbitrary code with the function runtime's privileges, so it is off in production unless asked for. */
  customFunctions: boolean;
  /** How long an idle keep-alive connection stays open. Proxies and load balancers reuse upstream connections for 60-75 s, so closing sooner makes them hit a socket just closed. */
  idleTimeoutSeconds: number;
  /** Memory the in-process cache may use; Redis applies its own limits. */
  cacheMaxBytes: number;
  /** HTTP_ENGINE: which server answers requests. `auto`: the native engine on 4 or more cores when it is built, else Bun.serve. */
  httpEngine: "auto" | "bun" | "archlast";
  /** Function runtime processes per server. */
  runtimeWorkers: number;
  /** `process`: functions run in child processes, restarted alone on code changes or a hang. `inline`: in the server process, fastest. */
  runtimeMode: "process" | "inline";
  limits: Limits;
  /** The WAF's settings when WAF is on, else undefined. */
  waf?: WafConfig;
  /** Use X-Forwarded-For for client IPs (rate limiting); only behind a trusted proxy. */
  trustProxy: boolean;
  logFormat: "pretty" | "json";
  logRetentionDays: number;
  /** Refuse to start when stored documents don't match the schema. */
  schemaCheck: boolean;
  /** Record requests, traces, logs and runtime health for the dashboard's observability pages. */
  telemetry: boolean;
  /** Whole traces kept per second, for ordinary requests and again for errors and slow ones; past it they are sampled. */
  telemetryTracesPerSecond: number;
  /** Requests per second recorded with every span; past it, a share that keeps to this rate (span statistics are then weighted estimates). */
  telemetryDetailPerSecond: number;
  /** The engine's name in telemetry (OpenTelemetry's service.name). */
  serviceName: string;
  /**
   * The main app whose dashboard this engine reports to, when it is one of its microservices (DASHBOARD_URL): its telemetry goes there,
   * its admin API answers that app's dashboard, and it serves no dashboard of its own.
   */
  dashboardUrl?: string;
  /** The secret a main app and its microservices share for the dashboard (DASHBOARD_TOKEN). */
  dashboardToken?: string;
  /** This app's microservices, by name, at the addresses this server reaches them at (MICROSERVICES=orders=http://orders:3000,…). */
  microservices: Record<string, string>;
}

export interface S3Config {
  endpoint: string;
  publicEndpoint?: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  region?: string;
}

/** Where backups are kept and when they are made. Read again for every backup, so a change from the dashboard needs no restart. */
export interface BackupConfig {
  /** A bucket of their own (BACKUP_S3_*), or the files' bucket under `prefix`, or a directory. */
  target: { kind: "s3"; s3: S3Config; prefix: string } | { kind: "dir"; dir: string };
  /** A cron expression (UTC); empty means no scheduled backups. */
  schedule: string;
  /** Scheduled backups kept; older ones are deleted after each new one. */
  keep: number;
  /** Whether scheduled backups include the files in storage. */
  files: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Paths the engine answers itself, which the API docs and root-mounted HTTP routes can't take. */
export const RESERVED = ["/rpc", "/http", "/api/auth", "/_dashboard", "/_admin", "/_cli", "/_storage", "/_app", "/_telemetry", "/health", "/ready", "/metrics", "/otlp"];

/** The engine path a path lies in (itself or below it), if any. */
export const reservedPathOf = (path: string) => RESERVED.find((r) => path === r || path.startsWith(`${r}/`));
const bool = (v: string | undefined, fallback: boolean) => (v === undefined || v === "" ? fallback : ["1", "true", "on", "yes"].includes(v.toLowerCase()));

/** Fails fast on missing or contradictory settings. */
export function loadConfig(env: Record<string, string | undefined> = process.env, dev = false): Config {
  const fail = (msg: string): never => {
    throw new ConfigError(msg);
  };
  const int = (name: string, fallback: number, min = 0) => {
    const raw = env[name];
    const n = raw === undefined || raw === "" ? fallback : Number(raw);
    if (!Number.isInteger(n) || n < min) fail(`${name} must be an integer ≥ ${min}, got "${raw}"`);
    return n;
  };
  const port = int("PORT", 3000);
  const replicas = int("REPLICAS", 1, 1);
  const databaseUrl = env.DATABASE_URL || undefined;
  const databaseKind: Config["databaseKind"] = !databaseUrl ? "sqlite" : /^postgres(ql)?:\/\//.test(databaseUrl) ? "postgres" : /^mongodb(\+srv)?:\/\//.test(databaseUrl) ? "mongodb" : "sqlite";
  if (databaseUrl && databaseKind === "sqlite")
    fail(`DATABASE_URL must be a postgres:// or mongodb:// URL (unset it to use bun:sqlite), got "${databaseUrl.split(":")[0]}:"`);
  // Inline is the default outside dev: no IPC hop per call, about twice the throughput on one core. Dev keeps the child process, so code
  // changes reload without dropping connections, and so does a pool of runtime processes.
  const { workers: runtimeWorkers } = runtimeWorkersFor(env);
  const httpEngine = (env.HTTP_ENGINE || "auto") as Config["httpEngine"];
  if (httpEngine !== "auto" && httpEngine !== "bun" && httpEngine !== "archlast") fail(`HTTP_ENGINE must be "auto", "bun" or "archlast", got "${env.HTTP_ENGINE}"`);
  const runtimeMode = (env.RUNTIME_MODE || (dev || runtimeWorkers > 1 ? "process" : "inline")) as Config["runtimeMode"];
  if (runtimeMode !== "process" && runtimeMode !== "inline") fail(`RUNTIME_MODE must be "process" or "inline", got "${env.RUNTIME_MODE}"`);
  if (runtimeMode === "inline" && dev) fail("RUNTIME_MODE=inline can't reload code when it changes; use it outside dev");
  if (runtimeMode === "inline" && runtimeWorkers > 1) fail("RUNTIME_MODE=inline runs one function runtime, in the server process; unset RUNTIME_WORKERS");
  if (replicas > 1 && !env.REDIS_URL) fail("REPLICAS > 1 requires REDIS_URL, or mutations won't reach subscribers on other servers");
  if (replicas > 1 && !databaseUrl) fail("REPLICAS > 1 requires a Postgres or MongoDB DATABASE_URL; bun:sqlite is single-server");
  if (Boolean(env.S3_ENDPOINT) !== Boolean(env.S3_BUCKET)) fail("Set both S3_ENDPOINT and S3_BUCKET, or neither");
  // Without S3, development keeps files on the engine's disk; production does only when asked, so a deployment without storage stays one.
  const storage = (env.STORAGE || (env.S3_ENDPOINT ? "s3" : dev ? "local" : "off")) as Config["storage"];
  if (!["s3", "local", "off"].includes(storage)) fail(`STORAGE must be "s3", "local" or "off", got "${env.STORAGE}"`);
  if (storage === "s3" && !env.S3_ENDPOINT) fail("STORAGE=s3 needs S3_ENDPOINT and S3_BUCKET");
  if (storage === "local" && replicas > 1) fail("STORAGE=local keeps files on this server's disk; with REPLICAS > 1 use S3 (S3_ENDPOINT, S3_BUCKET)");
  if (!dev && !env.BETTER_AUTH_SECRET) fail("BETTER_AUTH_SECRET is required outside dev");
  const apiDocsPath = env.API_DOCS_PATH ? env.API_DOCS_PATH.replace(/\/+$/, "") : undefined;
  if (apiDocsPath !== undefined && !/^\/[A-Za-z0-9._~\/-]+$/.test(apiDocsPath)) fail(`API_DOCS_PATH must be a path like "/_api", got "${env.API_DOCS_PATH}"`);
  if (apiDocsPath && reservedPathOf(apiDocsPath)) fail(`API_DOCS_PATH can't be under ${reservedPathOf(apiDocsPath)}, which the engine serves`);
  // Empty is unset, as everywhere else that reads it: an origin is parsed from it (CORS, trusted origins), and "" isn't a URL.
  const authUrl = env.BETTER_AUTH_URL || `http://localhost:${port}`;
  // Over http, Better Auth's cookies aren't marked Secure; behind a TLS proxy that silently weakens sessions.
  if (!dev && !authUrl.startsWith("https://") && !bool(env.ALLOW_INSECURE_HTTP, false))
    fail(`BETTER_AUTH_URL must be https:// outside dev (got "${authUrl}"). Set ALLOW_INSECURE_HTTP=1 only for local testing.`);
  const dashboardUrl = env.DASHBOARD_URL?.trim().replace(/\/+$/, "") || undefined;
  if (dashboardUrl && !/^https?:\/\/[^/]+/.test(dashboardUrl)) fail(`DASHBOARD_URL must be the main app's address, like http://api:3000, got "${dashboardUrl}"`);
  const microservices: Record<string, string> = {};
  for (const entry of (env.MICROSERVICES ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, url] = [entry.slice(0, entry.indexOf("=")).trim(), entry.slice(entry.indexOf("=") + 1).trim().replace(/\/+$/, "")];
    if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || !/^https?:\/\/[^/]+/.test(url)) fail(`MICROSERVICES is a list of name=url, like orders=http://orders:3000,billing=http://billing:3000; got "${entry}"`);
    microservices[name] = url;
  }
  const dashboardToken = env.DASHBOARD_TOKEN || undefined;
  if ((dashboardUrl || Object.keys(microservices).length) && !dashboardToken)
    fail(`${dashboardUrl ? "DASHBOARD_URL" : "MICROSERVICES"} needs DASHBOARD_TOKEN: the secret the main app and its microservices share`);
  if (dashboardToken && dashboardToken.length < 16) fail("DASHBOARD_TOKEN must be at least 16 characters");
  // It signs in as the owner, from anywhere that reaches /_admin: outside dev it can't be a word someone could guess.
  if (!dev && env.ADMIN_KEY && env.ADMIN_KEY.length < 16) fail("ADMIN_KEY must be at least 16 characters outside dev (`openssl rand -hex 24` makes one)");
  // Its telemetry joins the main app's under this name, which the main app's MICROSERVICES uses too; two engines both named archlast-forge would merge.
  if (dashboardUrl && !env.OTEL_SERVICE_NAME) fail("DASHBOARD_URL needs OTEL_SERVICE_NAME: this microservice's name, as the main app's MICROSERVICES lists it");
  const rawProcesses = env.SERVER_PROCESSES?.trim();
  const serverProcesses = !rawProcesses || rawProcesses === "auto" ? ("auto" as const) : Number(rawProcesses);
  if (serverProcesses !== "auto" && (!Number.isInteger(serverProcesses) || serverProcesses < 1 || serverProcesses > 32)) fail(`SERVER_PROCESSES must be an integer from 1 to 32 or "auto", got "${rawProcesses}"`);
  const clusterSize = Math.max(1, Math.floor(Number(env.ARCHLAST_CLUSTER_SIZE)) || 1);
  const clusterIndex = Math.max(0, Math.floor(Number(env.ARCHLAST_CLUSTER_INDEX)) || 0);
  // A cluster shares one SQLite file between processes, which the native layer is made for (the write lock, the log's checkpoint and the cache are all aware of the others).
  const dbEngine = (env.DB_ENGINE || (clusterSize > 1 ? "native" : "bun")) as Config["dbEngine"];
  if (dbEngine !== "bun" && dbEngine !== "native") fail(`DB_ENGINE must be "bun" or "native", got "${env.DB_ENGINE}"`);
  const sqliteSynchronous = (env.SQLITE_SYNCHRONOUS || "FULL").toUpperCase() as Config["sqliteSynchronous"];
  if (sqliteSynchronous !== "FULL" && sqliteSynchronous !== "NORMAL") fail(`SQLITE_SYNCHRONOUS must be "FULL" or "NORMAL", got "${env.SQLITE_SYNCHRONOUS}"`);
  const logFormat = (env.LOG_FORMAT ?? (dev ? "pretty" : "json")) as Config["logFormat"];
  if (logFormat !== "pretty" && logFormat !== "json") fail(`LOG_FORMAT must be "pretty" or "json"`);
  const waf = bool(env.WAF, false) ? wafConfigOf(env, int, fail) : undefined;
  return {
    dev,
    port,
    hostname: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "./data",
    databaseUrl,
    databaseKind,
    sqliteSynchronous,
    dbEngine,
    serverProcesses,
    clusterSize,
    clusterIndex,
    databasePoolSize: env.DATABASE_POOL_SIZE ? int("DATABASE_POOL_SIZE", 0, 1) : undefined,
    databaseWritePoolSize: env.DATABASE_WRITE_POOL_SIZE ? int("DATABASE_WRITE_POOL_SIZE", 0, 1) : undefined,
    redisUrl: env.REDIS_URL || undefined,
    redisPrefix: redisPrefixOf(env),
    s3: s3Of(env, "S3_"),
    storage,
    storagePublicUrl: (env.STORAGE_PUBLIC_URL || authUrl).replace(/\/+$/, ""),
    maxUploadBytes: int("MAX_UPLOAD_MB", 5120, 1) * 2 ** 20,
    adminKey: env.ADMIN_KEY || undefined,
    dashboard: bool(env.DASHBOARD, dev),
    apiDocs: env.API_DOCS ? bool(env.API_DOCS, dev) : undefined,
    apiDocsPath,
    customFunctions: bool(env.ALLOW_CUSTOM_FUNCTIONS, dev),
    authSecret: env.BETTER_AUTH_SECRET,
    authUrl,
    trustedOrigins: (env.TRUSTED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    replicas,
    cacheTtlMs: int("CACHE_TTL_MS", 60_000),
    cacheMaxBytes: int("CACHE_MAX_MB", 64, 1) * 2 ** 20,
    idleTimeoutSeconds: int("IDLE_TIMEOUT_SECONDS", 75, 1),
    runtimeWorkers,
    runtimeMode,
    httpEngine,
    limits: {
      functionTimeoutMs: int("FUNCTION_TIMEOUT_MS", 10_000, 1),
      actionTimeoutMs: int("ACTION_TIMEOUT_MS", 600_000, 1),
      maxResultBytes: int("MAX_RESULT_BYTES", 8 * 1024 * 1024, 1),
      maxDocumentBytes: int("MAX_DOCUMENT_BYTES", 1024 * 1024, 1),
      maxRequestBytes: int("MAX_REQUEST_BYTES", 8 * 1024 * 1024, 1),
      rateLimitPerMinute: int("RATE_LIMIT_PER_MINUTE", dev ? 0 : 1200),
      maxSubscriptionsPerConnection: int("MAX_SUBSCRIPTIONS_PER_CONNECTION", 200, 1),
      maxSubscriptionBytes: int("MAX_SUBSCRIPTION_BYTES", 64 * 1024, 1),
      maxConnectionsPerIp: int("MAX_CONNECTIONS_PER_IP", 256, 0),
      maxPendingCalls: int("MAX_PENDING_CALLS", 1000, 1),
    },
    waf,
    trustProxy: bool(env.TRUST_PROXY, false),
    logFormat,
    logRetentionDays: int("LOG_RETENTION_DAYS", 7, 1),
    schemaCheck: bool(env.SCHEMA_CHECK, !dev),
    telemetry: bool(env.TELEMETRY, true),
    telemetryTracesPerSecond: int("TELEMETRY_TRACES_PER_SECOND", 25, 1),
    telemetryDetailPerSecond: int("TELEMETRY_DETAIL_PER_SECOND", 200, 1),
    serviceName: env.OTEL_SERVICE_NAME || "archlast-forge",
    dashboardUrl,
    dashboardToken,
    microservices,
  };
}

/** WAF_* settings, read only when WAF is on. */
function wafConfigOf(env: Record<string, string | undefined>, int: (name: string, fallback: number, min?: number) => number, fail: (msg: string) => never): WafConfig {
  const mode = (env.WAF_MODE || "block") as WafConfig["mode"];
  if (mode !== "block" && mode !== "detect") fail(`WAF_MODE must be "block" or "detect", got "${env.WAF_MODE}"`);
  const paranoia = int("WAF_PARANOIA", 1, 1);
  if (paranoia > 4) fail(`WAF_PARANOIA must be 1 to 4, got ${paranoia}`);
  const list = (name: string) =>
    (env[name] ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  const ignorePaths = list("WAF_IGNORE_PATHS");
  for (const p of ignorePaths) if (!p.startsWith("/")) fail(`WAF_IGNORE_PATHS is a list of path prefixes like /webhooks, got "${p}"`);
  const disabledRules = list("WAF_DISABLED_RULES").map((id) => (/^\d{3,7}$/.test(id) ? Number(id) : fail(`WAF_DISABLED_RULES is a list of CRS rule ids like 942100, got "${id}"`)));
  return { mode, paranoia, workers: int("WAF_WORKERS", 1, 1), maxBodyBytes: int("WAF_MAX_BODY_KB", 512, 1) * 1024, ignorePaths, disabledRules };
}

const validCron = (expression: string) => {
  try {
    return Boolean(Bun.cron.parse(expression, Date.now(), { tz: "UTC" }));
  } catch {
    return false;
  }
};

/** An S3 connection from `<prefix>ENDPOINT`, `<prefix>BUCKET` and the rest, or undefined without an endpoint. */
function s3Of(env: Record<string, string | undefined>, prefix: string): S3Config | undefined {
  if (!env[`${prefix}ENDPOINT`]) return undefined;
  return {
    endpoint: env[`${prefix}ENDPOINT`]!,
    publicEndpoint: env[`${prefix}PUBLIC_ENDPOINT`] || undefined,
    bucket: env[`${prefix}BUCKET`]!,
    accessKeyId: env[`${prefix}ACCESS_KEY_ID`],
    secretAccessKey: env[`${prefix}SECRET_ACCESS_KEY`],
    region: env[`${prefix}REGION`],
  };
}

/**
 * Backups go to a bucket of their own when BACKUP_S3_ENDPOINT is set, to BACKUP_DIR when that is, then next to the files: the S3 bucket under
 * `_backups/`, or DATA_DIR/backups.
 */
export function loadBackupConfig(env: Record<string, string | undefined>, config: Pick<Config, "dataDir" | "s3" | "storage">): BackupConfig {
  if (Boolean(env.BACKUP_S3_ENDPOINT) !== Boolean(env.BACKUP_S3_BUCKET)) throw new ConfigError("Set both BACKUP_S3_ENDPOINT and BACKUP_S3_BUCKET, or neither");
  const keep = env.BACKUP_KEEP === undefined || env.BACKUP_KEEP === "" ? 7 : Number(env.BACKUP_KEEP);
  if (!Number.isInteger(keep) || keep < 1) throw new ConfigError(`BACKUP_KEEP must be an integer ≥ 1, got "${env.BACKUP_KEEP}"`);
  const schedule = (env.BACKUP_SCHEDULE ?? "").trim();
  if (schedule && !validCron(schedule)) throw new ConfigError(`BACKUP_SCHEDULE must be a cron expression like "0 3 * * *" (UTC), got "${schedule}"`);
  const own = s3Of(env, "BACKUP_S3_");
  const prefix = (env.BACKUP_S3_PREFIX ?? (own ? "" : "_backups/")).replace(/^\/+/, "");
  const target: BackupConfig["target"] = own
    ? { kind: "s3", s3: own, prefix }
    : env.BACKUP_DIR
      ? { kind: "dir", dir: env.BACKUP_DIR }
      : config.s3 && config.storage === "s3"
        ? { kind: "s3", s3: config.s3, prefix }
        : { kind: "dir", dir: join(config.dataDir, "backups") };
  return { target, schedule, keep, files: bool(env.BACKUP_FILES, true) };
}

export const sqlitePath = (c: Config) => join(c.dataDir, "app.db");
/** The telemetry store's own file on SQLite, so telemetry writes never queue behind the app's (or hold them up). */
export const telemetryPath = (c: Config) => join(c.dataDir, "telemetry.db");
