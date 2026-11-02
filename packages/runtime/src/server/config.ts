import { readFileSync } from "node:fs";
import { availableParallelism } from "node:os";
import { join } from "node:path";

/** CPU cores this process may use: the container's CPU quota when it has one (cgroup v2 `cpu.max`), else the machine's. */
export function serverCores(): number {
  const cores = availableParallelism();
  try {
    const [quota, period] = readFileSync("/sys/fs/cgroup/cpu.max", "utf8").trim().split(/\s+/);
    if (quota && quota !== "max") return Math.min(cores, Math.max(1, Math.ceil(Number(quota) / Number(period))));
  } catch {} // not Linux, or no cgroup v2
  return cores;
}

/**
 * The function runtime processes `RUNTIME_WORKERS` asks for: a number, or `auto`, which is the cores times `RUNTIME_WORKERS_RATIO` (0.5 by
 * default: half the cores, leaving the rest to the server process, the database and whatever else runs there), rounded down, at least 1.
 */
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
  /** Calls waiting for one function runtime process; past this, new calls are refused with 503 instead of queueing. */
  maxPendingCalls: number;
}

export interface Config {
  dev: boolean;
  port: number;
  hostname: string;
  dataDir: string;
  databaseUrl?: string;
  /** Postgres connections each function-runtime process may open (DATABASE_POOL_SIZE); twice the CPU cores by default. */
  databasePoolSize: number;
  redisUrl?: string;
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
  /** Serve the OpenAPI document, the API docs page and the explorer at `apiDocsPath`. */
  apiDocs: boolean;
  apiDocsPath: string;
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
  /** Function runtime processes per server. */
  runtimeWorkers: number;
  /** `process`: functions run in child processes, restarted alone on code changes or a hang. `inline`: in the server process, fastest. */
  runtimeMode: "process" | "inline";
  limits: Limits;
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

/** Paths the engine answers itself, which the API docs can't take. */
const RESERVED = ["/rpc", "/http", "/api/auth", "/_dashboard", "/_admin", "/_cli", "/_storage", "/_app", "/health", "/ready", "/metrics", "/otlp"];
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
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) fail(`DATABASE_URL must be a postgres:// URL (unset it to use bun:sqlite), got "${databaseUrl.split(":")[0]}:"`);
  // Inline is the default outside dev: no IPC hop per call, about twice the throughput on one core. Dev keeps the child process, so code
  // changes reload without dropping connections, and so does a pool of runtime processes.
  const { workers: runtimeWorkers } = runtimeWorkersFor(env);
  const runtimeMode = (env.RUNTIME_MODE || (dev || runtimeWorkers > 1 ? "process" : "inline")) as Config["runtimeMode"];
  if (runtimeMode !== "process" && runtimeMode !== "inline") fail(`RUNTIME_MODE must be "process" or "inline", got "${env.RUNTIME_MODE}"`);
  if (runtimeMode === "inline" && dev) fail("RUNTIME_MODE=inline can't reload code when it changes; use it outside dev");
  if (runtimeMode === "inline" && runtimeWorkers > 1) fail("RUNTIME_MODE=inline runs one function runtime, in the server process; unset RUNTIME_WORKERS");
  if (replicas > 1 && !env.REDIS_URL) fail("REPLICAS > 1 requires REDIS_URL, or mutations won't reach subscribers on other servers");
  if (replicas > 1 && !databaseUrl) fail("REPLICAS > 1 requires a Postgres DATABASE_URL; bun:sqlite is single-server");
  if (Boolean(env.S3_ENDPOINT) !== Boolean(env.S3_BUCKET)) fail("Set both S3_ENDPOINT and S3_BUCKET, or neither");
  // Without S3, development keeps files on the engine's disk; production does only when asked, so a deployment without storage stays one.
  const storage = (env.STORAGE || (env.S3_ENDPOINT ? "s3" : dev ? "local" : "off")) as Config["storage"];
  if (!["s3", "local", "off"].includes(storage)) fail(`STORAGE must be "s3", "local" or "off", got "${env.STORAGE}"`);
  if (storage === "s3" && !env.S3_ENDPOINT) fail("STORAGE=s3 needs S3_ENDPOINT and S3_BUCKET");
  if (storage === "local" && replicas > 1) fail("STORAGE=local keeps files on this server's disk; with REPLICAS > 1 use S3 (S3_ENDPOINT, S3_BUCKET)");
  if (!dev && !env.BETTER_AUTH_SECRET) fail("BETTER_AUTH_SECRET is required outside dev");
  const apiDocsPath = (env.API_DOCS_PATH || "/_api").replace(/\/+$/, "");
  if (!/^\/[A-Za-z0-9._~\/-]+$/.test(apiDocsPath)) fail(`API_DOCS_PATH must be a path like "/_api", got "${env.API_DOCS_PATH}"`);
  if (RESERVED.some((r) => apiDocsPath === r || apiDocsPath.startsWith(`${r}/`))) fail(`API_DOCS_PATH can't be under ${RESERVED.find((r) => apiDocsPath === r || apiDocsPath.startsWith(`${r}/`))}, which the engine serves`);
  const authUrl = env.BETTER_AUTH_URL ?? `http://localhost:${port}`;
  // Over http, Better Auth's cookies aren't marked Secure; behind a TLS proxy that silently weakens sessions.
  if (!dev && !authUrl.startsWith("https://") && !bool(env.ALLOW_INSECURE_HTTP, false))
    fail(`BETTER_AUTH_URL must be https:// outside dev (got "${authUrl}"). Set ALLOW_INSECURE_HTTP=1 only for local testing.`);
  const logFormat = (env.LOG_FORMAT ?? (dev ? "pretty" : "json")) as Config["logFormat"];
  if (logFormat !== "pretty" && logFormat !== "json") fail(`LOG_FORMAT must be "pretty" or "json"`);
  return {
    dev,
    port,
    hostname: env.HOST ?? "0.0.0.0",
    dataDir: env.DATA_DIR ?? "./data",
    databaseUrl,
    databasePoolSize: int("DATABASE_POOL_SIZE", navigator.hardwareConcurrency * 2, 1),
    redisUrl: env.REDIS_URL || undefined,
    s3: s3Of(env, "S3_"),
    storage,
    storagePublicUrl: (env.STORAGE_PUBLIC_URL || authUrl).replace(/\/+$/, ""),
    maxUploadBytes: int("MAX_UPLOAD_MB", 5120, 1) * 2 ** 20,
    adminKey: env.ADMIN_KEY || undefined,
    dashboard: bool(env.DASHBOARD, dev),
    apiDocs: bool(env.API_DOCS, dev),
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
    limits: {
      functionTimeoutMs: int("FUNCTION_TIMEOUT_MS", 10_000, 1),
      actionTimeoutMs: int("ACTION_TIMEOUT_MS", 600_000, 1),
      maxResultBytes: int("MAX_RESULT_BYTES", 8 * 1024 * 1024, 1),
      maxDocumentBytes: int("MAX_DOCUMENT_BYTES", 1024 * 1024, 1),
      maxRequestBytes: int("MAX_REQUEST_BYTES", 8 * 1024 * 1024, 1),
      rateLimitPerMinute: int("RATE_LIMIT_PER_MINUTE", dev ? 0 : 1200),
      maxSubscriptionsPerConnection: int("MAX_SUBSCRIPTIONS_PER_CONNECTION", 200, 1),
      maxPendingCalls: int("MAX_PENDING_CALLS", 1000, 1),
    },
    trustProxy: bool(env.TRUST_PROXY, false),
    logFormat,
    logRetentionDays: int("LOG_RETENTION_DAYS", 7, 1),
    schemaCheck: bool(env.SCHEMA_CHECK, !dev),
    telemetry: bool(env.TELEMETRY, true),
    telemetryTracesPerSecond: int("TELEMETRY_TRACES_PER_SECOND", 25, 1),
    telemetryDetailPerSecond: int("TELEMETRY_DETAIL_PER_SECOND", 200, 1),
    serviceName: env.OTEL_SERVICE_NAME || "archlast-forge",
  };
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
