import { join } from "node:path";

export interface Config {
  dev: boolean;
  port: number;
  dataDir: string;
  databaseUrl?: string;
  redisUrl?: string;
  s3?: { endpoint: string; bucket: string; accessKeyId?: string; secretAccessKey?: string; region?: string };
  adminKey?: string;
  authSecret?: string;
  authUrl: string;
  trustedOrigins: string[];
  replicas: number;
  /** TTL for cached query results. 0 disables the cache. */
  cacheTtlMs: number;
}

export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Fails fast on missing or contradictory settings. */
export function loadConfig(env: Record<string, string | undefined> = process.env, dev = false): Config {
  const port = Number(env.PORT ?? 3000);
  const replicas = Number(env.REPLICAS ?? 1);
  const databaseUrl = env.DATABASE_URL || undefined;
  const fail = (msg: string) => {
    throw new ConfigError(msg);
  };
  if (!Number.isInteger(port) || port < 0) fail(`PORT must be an integer, got "${env.PORT}"`);
  if (!Number.isInteger(replicas) || replicas < 1) fail(`REPLICAS must be a positive integer, got "${env.REPLICAS}"`);
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl))
    fail(`DATABASE_URL must be a postgres:// URL (unset it to use bun:sqlite), got "${databaseUrl.split(":")[0]}:"`);
  if (replicas > 1 && !env.REDIS_URL) fail("REPLICAS > 1 requires REDIS_URL, or mutations won't reach subscribers on other servers");
  if (replicas > 1 && !databaseUrl) fail("REPLICAS > 1 requires a Postgres DATABASE_URL; bun:sqlite is single-server");
  if (Boolean(env.S3_ENDPOINT) !== Boolean(env.S3_BUCKET)) fail("Set both S3_ENDPOINT and S3_BUCKET, or neither");
  if (!dev && !env.BETTER_AUTH_SECRET) fail("BETTER_AUTH_SECRET is required outside dev");
  return {
    dev,
    port,
    dataDir: env.DATA_DIR ?? "./data",
    databaseUrl,
    redisUrl: env.REDIS_URL || undefined,
    s3: env.S3_ENDPOINT
      ? {
          endpoint: env.S3_ENDPOINT,
          bucket: env.S3_BUCKET!,
          accessKeyId: env.S3_ACCESS_KEY_ID,
          secretAccessKey: env.S3_SECRET_ACCESS_KEY,
          region: env.S3_REGION,
        }
      : undefined,
    adminKey: env.ADMIN_KEY || undefined,
    authSecret: env.BETTER_AUTH_SECRET,
    authUrl: env.BETTER_AUTH_URL ?? `http://localhost:${port}`,
    trustedOrigins: (env.TRUSTED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    replicas,
    cacheTtlMs: Number(env.CACHE_TTL_MS ?? 60_000),
  };
}

export const sqlitePath = (c: Config) => join(c.dataDir, "app.db");
