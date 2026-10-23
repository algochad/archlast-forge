import { join } from "node:path";

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
  redisUrl?: string;
  s3?: { endpoint: string; publicEndpoint?: string; bucket: string; accessKeyId?: string; secretAccessKey?: string; region?: string };
  adminKey?: string;
  /** Serve /_dashboard and the admin API. Off by default outside dev. */
  dashboard: boolean;
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
  limits: Limits;
  /** Use X-Forwarded-For for client IPs (rate limiting); only behind a trusted proxy. */
  trustProxy: boolean;
  logFormat: "pretty" | "json";
  logRetentionDays: number;
  /** Refuse to start when stored documents don't match the schema. */
  schemaCheck: boolean;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

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
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl))
    fail(`DATABASE_URL must be a postgres:// URL (unset it to use bun:sqlite), got "${databaseUrl.split(":")[0]}:"`);
  if (replicas > 1 && !env.REDIS_URL) fail("REPLICAS > 1 requires REDIS_URL, or mutations won't reach subscribers on other servers");
  if (replicas > 1 && !databaseUrl) fail("REPLICAS > 1 requires a Postgres DATABASE_URL; bun:sqlite is single-server");
  if (Boolean(env.S3_ENDPOINT) !== Boolean(env.S3_BUCKET)) fail("Set both S3_ENDPOINT and S3_BUCKET, or neither");
  if (!dev && !env.BETTER_AUTH_SECRET) fail("BETTER_AUTH_SECRET is required outside dev");
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
    redisUrl: env.REDIS_URL || undefined,
    s3: env.S3_ENDPOINT
      ? {
          endpoint: env.S3_ENDPOINT,
          publicEndpoint: env.S3_PUBLIC_ENDPOINT || undefined,
          bucket: env.S3_BUCKET!,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          region: env.S3_REGION,
        }
      : undefined,
    adminKey: env.ADMIN_KEY || undefined,
    dashboard: bool(env.DASHBOARD, dev),
    customFunctions: bool(env.ALLOW_CUSTOM_FUNCTIONS, dev),
    authSecret: env.BETTER_AUTH_SECRET,
    authUrl,
    trustedOrigins: (env.TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    replicas,
    cacheTtlMs: int("CACHE_TTL_MS", 60_000),
    cacheMaxBytes: int("CACHE_MAX_MB", 64, 1) * 2 ** 20,
    idleTimeoutSeconds: int("IDLE_TIMEOUT_SECONDS", 75, 1),
    runtimeWorkers: int("RUNTIME_WORKERS", 1, 1),
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
  };
}

export const sqlitePath = (c: Config) => join(c.dataDir, "app.db");
