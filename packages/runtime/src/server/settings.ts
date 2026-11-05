// The engine's settings: every environment variable it reads, what each does, and whether the dashboard may change it. A value saved from the
// dashboard is kept in `_settings`; the process environment always wins over it, so a deployment's own configuration means what it did.
import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { existsSync } from "node:fs";
import { ConfigError, loadBackupConfig, loadConfig, sqlitePath, type Config } from "./config";

export type SettingType = "int" | "bool" | "enum" | "string" | "list" | "cron";

export interface SettingDef {
  name: string;
  group: string;
  type: SettingType;
  options?: string[];
  min?: number;
  /** What applies when nothing sets it, in words. */
  default: string;
  doc: string;
  /** Read only from the environment: why. */
  envOnly?: string;
  /** Never shown back once set. */
  secret?: boolean;
  /** Read again each time it is used, so a change applies without a restart. */
  live?: boolean;
}

const BOOT = "The engine needs it before it can read the settings stored in its database.";
const ACCESS = "A wrong value from here could lock you out of the dashboard; set it where the engine is deployed.";

export const SETTINGS: SettingDef[] = [
  // -- server --
  { name: "PORT", group: "Server", type: "int", min: 0, default: "3000", doc: "The port to listen on.", envOnly: "The container's port mapping and health check depend on it." },
  { name: "HOST", group: "Server", type: "string", default: "0.0.0.0", doc: "The interface to bind.", envOnly: "The container's port mapping depends on it." },
  { name: "IDLE_TIMEOUT_SECONDS", group: "Server", type: "int", min: 1, default: "75", doc: "How long an idle keep-alive connection stays open (capped at 255)." },
  { name: "TRUST_PROXY", group: "Server", type: "bool", default: "off", doc: "Take the client IP from X-Forwarded-For for rate limiting. Only behind a proxy that overwrites that header." },
  { name: "TRUSTED_ORIGINS", group: "Server", type: "list", default: "none", doc: "Browser origins other than BETTER_AUTH_URL that may call the engine (comma-separated)." },
  {
    name: "REPLICAS",
    group: "Server",
    type: "int",
    min: 1,
    default: "1",
    doc: "How many servers you run; above 1 it requires Redis and Postgres.",
    envOnly: "It describes the deployment, which this dashboard can't change.",
  },
  // -- auth and access --
  {
    name: "BETTER_AUTH_URL",
    group: "Auth",
    type: "string",
    default: "http://localhost:<port>",
    doc: "The public address of the app, as browsers see it. Must be https:// outside dev.",
    envOnly: ACCESS,
  },
  { name: "BETTER_AUTH_SECRET", group: "Auth", type: "string", secret: true, default: "generated in dev", doc: "Signs session cookies. Changing it signs everybody out.", envOnly: ACCESS },
  { name: "ALLOW_INSECURE_HTTP", group: "Auth", type: "bool", default: "off", doc: "Lets production start with an http:// BETTER_AUTH_URL (cookies aren't Secure)." },
  { name: "ADMIN_KEY", group: "Auth", type: "string", secret: true, default: "generated in dev", doc: "An owner credential for the dashboard and the CLI's data commands.", envOnly: ACCESS },
  { name: "DASHBOARD", group: "Auth", type: "bool", default: "on in dev, off otherwise", doc: "Serve /_dashboard and its API.", envOnly: ACCESS },
  {
    name: "FORGE_RPC_TOKEN",
    group: "Auth",
    type: "string",
    secret: true,
    default: "none: Forge RPC refuses to start without one",
    doc: "The shared secret Forge RPC servers and clients send and check (16 characters or more).",
    envOnly: "Every app that calls or serves Forge RPC needs the same one: set it where they are deployed.",
  },
  {
    name: "API_DOCS",
    group: "Server",
    type: "bool",
    default: "on in dev; in production when forge/http.ts says http.docs({ production: true })",
    doc: "Serve the OpenAPI document and the API docs page. Set, it wins over the code. What the document lists is set in code (http.docs({ include, functions })).",
  },
  { name: "API_DOCS_PATH", group: "Server", type: "string", default: "http.docs({ path }), else /_api", doc: "Where the API docs page is served, over what forge/http.ts says." },
  {
    name: "ALLOW_CUSTOM_FUNCTIONS",
    group: "Auth",
    type: "bool",
    default: "on in dev, off otherwise",
    doc: "Let owners run code typed into the dashboard, with the function runtime's privileges.",
  },
  // -- database and cache --
  { name: "DATA_DIR", group: "Database", type: "string", default: "./data (/data in the image)", doc: "Where the SQLite database, telemetry and the built-in storage live.", envOnly: BOOT },
  { name: "DATABASE_URL", group: "Database", type: "string", secret: true, default: "SQLite in DATA_DIR", doc: "A Postgres database instead of the SQLite file.", envOnly: BOOT },
  { name: "DATABASE_POOL_SIZE", group: "Database", type: "int", min: 1, default: "sized from Postgres's max_connections", doc: "Postgres connections each function-runtime process holds for reads. Unset, this app's servers take 60% of what Postgres allows (at most twice the CPU cores for reads; 4 in development); the log says the numbers at start." },
  { name: "DATABASE_WRITE_POOL_SIZE", group: "Database", type: "int", min: 1, default: "sized with DATABASE_POOL_SIZE; twice it when only that is set", doc: "Postgres connections each function-runtime process holds for write transactions. More connections hide the latency of a commit. A pool holds all its connections from the start: with the sizes set, keep REPLICAS × RUNTIME_WORKERS × (both pools) + 3 per server under Postgres's max_connections (100 by default)." },
  {
    name: "SQLITE_SYNCHRONOUS",
    group: "Database",
    type: "enum",
    options: ["FULL", "NORMAL"],
    default: "FULL",
    doc: "How hard SQLite pushes a commit to the disk. FULL: an answered write survives a power cut. NORMAL: faster for a lone writer, but a power cut or operating-system crash can lose the last few writes (a crash of the engine alone can't).",
  },
  { name: "SCHEMA_CHECK", group: "Database", type: "bool", default: "on outside dev", doc: "At startup, refuse to serve when stored documents don't match the schema." },
  {
    name: "REDIS_URL",
    group: "Database",
    type: "string",
    secret: true,
    default: "in-memory",
    doc: "Redis for the bus between servers, a shared cache and shared rate limits.",
    envOnly: "The engine connects to it before it serves anything: a wrong value would keep it from starting.",
  },
  {
    name: "REDIS_PREFIX",
    group: "Database",
    type: "string",
    default: "archlast-forge:<OTEL_SERVICE_NAME>:",
    doc: 'What this service\'s Redis keys and channels start with, so services that share one Redis keep their cached results, topics and rate limits apart. Every server of a service uses the same value: by default it comes from OTEL_SERVICE_NAME, and without a name it is "archlast-forge:", what the engine always used.',
    envOnly: "The engine connects to Redis with it before it serves anything.",
  },
  { name: "CACHE_TTL_MS", group: "Database", type: "int", min: 0, default: "60000", doc: "The longest a query result is cached. 0 turns the query cache off." },
  { name: "CACHE_MAX_MB", group: "Database", type: "int", min: 1, default: "64", doc: "Memory for the in-process query cache (Redis applies its own limits)." },
  // -- function runtime --
  {
    name: "RUNTIME_WORKERS",
    group: "Runtime",
    type: "int",
    min: 1,
    options: ["auto"],
    default: "1",
    doc: "Function runtime processes per server, or auto (the cores times RUNTIME_WORKERS_RATIO). Above 1 needs process mode. In process mode a change applies at once: new processes start beside the others, and removed ones finish their calls first.",
  },
  {
    name: "RUNTIME_WORKERS_RATIO",
    group: "Runtime",
    type: "string",
    default: "0.5",
    doc: "For RUNTIME_WORKERS=auto: processes per core (0.5: half the cores, rounded down, at least 1).",
  },
  {
    name: "RUNTIME_MODE",
    group: "Runtime",
    type: "enum",
    options: ["process", "inline"],
    default: "inline outside dev, process in dev or with more than one worker",
    doc: "inline runs functions in the server process (fastest); process runs them in child processes.",
  },
  { name: "FUNCTION_TIMEOUT_MS", group: "Runtime", type: "int", min: 1, default: "10000", doc: "Time for a query or mutation." },
  { name: "ACTION_TIMEOUT_MS", group: "Runtime", type: "int", min: 1, default: "600000", doc: "Time for an action or an HTTP endpoint." },
  { name: "MAX_PENDING_CALLS", group: "Runtime", type: "int", min: 1, default: "1000", doc: "Calls waiting for a function runtime before new ones get 503." },
  // -- limits --
  { name: "MAX_RESULT_BYTES", group: "Limits", type: "int", min: 1, default: "8388608 (8 MiB)", doc: "The JSON size of a function's return value." },
  { name: "MAX_DOCUMENT_BYTES", group: "Limits", type: "int", min: 1, default: "1048576 (1 MiB)", doc: "The JSON size of one stored document." },
  { name: "MAX_REQUEST_BYTES", group: "Limits", type: "int", min: 1, default: "8388608 (8 MiB)", doc: "An HTTP request body and a WebSocket message." },
  { name: "RATE_LIMIT_PER_MINUTE", group: "Limits", type: "int", min: 0, default: "1200 (off in dev)", doc: "Requests per client IP per minute. 0 turns rate limiting off." },
  { name: "MAX_SUBSCRIPTIONS_PER_CONNECTION", group: "Limits", type: "int", min: 1, default: "200", doc: "Live queries one WebSocket may hold." },
  // -- web application firewall --
  { name: "WAF", group: "Firewall", type: "bool", default: "off", doc: "Inspect every request with the OWASP Core Rule Set (Coraza) before the engine handles it. A request the rules flag gets a 403. Costs about a millisecond of CPU per request and over 100 MB of memory per WAF thread. The Firewall page of the dashboard watches it and changes it while it runs: the WAF_* settings apply at once, without a restart." },
  { name: "WAF_MODE", group: "Firewall", type: "enum", options: ["block", "detect"], default: "block", doc: "`detect` only logs what the rules would stop, so a rollout can be watched before it blocks anything." },
  { name: "WAF_PARANOIA", group: "Firewall", type: "int", min: 1, default: "1", doc: "How strict the rules are, 1 to 4. Higher levels catch more and flag more legitimate requests." },
  { name: "WAF_WORKERS", group: "Firewall", type: "int", min: 1, default: "1", doc: "WAF threads. Each has its own copy of the rules in memory (over 100 MB); one handles around a thousand requests a second." },
  { name: "WAF_MAX_BODY_KB", group: "Firewall", type: "int", min: 1, default: "512", doc: "The largest request body that is inspected. A larger one isn't (its URL and headers still are)." },
  { name: "WAF_IGNORE_PATHS", group: "Firewall", type: "list", default: "none", doc: "Path prefixes whose requests are not inspected (comma-separated, like /webhooks). The dashboard, storage and the app's built files never are." },
  { name: "WAF_DISABLED_RULES", group: "Firewall", type: "list", default: "none", doc: "CRS rule ids to switch off (comma-separated, like 942100), for a rule that stops something legitimate. The log says which rule blocked a request." },
  // -- storage --
  {
    name: "STORAGE",
    group: "Storage",
    type: "enum",
    options: ["s3", "local", "off"],
    default: "s3 with S3_ENDPOINT, local in dev, otherwise off",
    doc: "Where files live. local keeps them in DATA_DIR/storage on this server. Files already stored stay where they are when you switch.",
  },
  { name: "S3_ENDPOINT", group: "Storage", type: "string", default: "unset", doc: "The S3-compatible service, as the engine reaches it." },
  { name: "S3_BUCKET", group: "Storage", type: "string", default: "unset", doc: "The bucket for uploads. It must already exist." },
  { name: "S3_ACCESS_KEY_ID", group: "Storage", type: "string", default: "unset", doc: "The bucket's access key." },
  { name: "S3_SECRET_ACCESS_KEY", group: "Storage", type: "string", secret: true, default: "unset", doc: "The bucket's secret key." },
  { name: "S3_REGION", group: "Storage", type: "string", default: "unset", doc: "The region, for providers that need it when signing." },
  { name: "S3_PUBLIC_ENDPOINT", group: "Storage", type: "string", default: "S3_ENDPOINT", doc: "The address browsers upload to and download from." },
  { name: "STORAGE_PUBLIC_URL", group: "Storage", type: "string", default: "BETTER_AUTH_URL", doc: "With STORAGE=local: the address browsers reach the engine's files at." },
  {
    name: "MAX_UPLOAD_MB",
    group: "Storage",
    type: "int",
    min: 1,
    default: "5120",
    doc: "The largest file the built-in storage accepts, and the largest backup the dashboard takes as an upload.",
  },
  // -- backups (read for every backup, so no restart) --
  {
    name: "BACKUP_SCHEDULE",
    group: "Backups",
    type: "cron",
    live: true,
    default: "none",
    doc: 'When to back up, as a cron expression in UTC ("0 3 * * *" is 03:00 every day). Empty turns scheduled backups off.',
  },
  { name: "BACKUP_KEEP", group: "Backups", type: "int", min: 1, live: true, default: "7", doc: "Scheduled backups to keep; older ones are deleted after each new one." },
  { name: "BACKUP_FILES", group: "Backups", type: "bool", live: true, default: "on", doc: "Include the files in storage in scheduled backups." },
  {
    name: "BACKUP_DIR",
    group: "Backups",
    type: "string",
    live: true,
    default: "next to the files",
    doc: "Keep backups in this directory. Without it they go to the files' S3 bucket under _backups/, or DATA_DIR/backups.",
  },
  { name: "BACKUP_S3_ENDPOINT", group: "Backups", type: "string", live: true, default: "unset", doc: "A bucket of their own for backups, off this machine. Wins over BACKUP_DIR." },
  { name: "BACKUP_S3_BUCKET", group: "Backups", type: "string", live: true, default: "unset", doc: "The backups' bucket. It must already exist." },
  { name: "BACKUP_S3_ACCESS_KEY_ID", group: "Backups", type: "string", live: true, default: "unset", doc: "The backup bucket's access key." },
  { name: "BACKUP_S3_SECRET_ACCESS_KEY", group: "Backups", type: "string", live: true, secret: true, default: "unset", doc: "The backup bucket's secret key." },
  { name: "BACKUP_S3_REGION", group: "Backups", type: "string", live: true, default: "unset", doc: "The backup bucket's region." },
  { name: "BACKUP_S3_PUBLIC_ENDPOINT", group: "Backups", type: "string", live: true, default: "BACKUP_S3_ENDPOINT", doc: "The address browsers download backups from." },
  {
    name: "BACKUP_S3_PREFIX",
    group: "Backups",
    type: "string",
    live: true,
    default: "_backups/ in the files' bucket, none in a bucket of their own",
    doc: "Where in the bucket backups go.",
  },
  // -- telemetry and logs --
  { name: "TELEMETRY", group: "Telemetry", type: "bool", default: "on", doc: "Record requests, traces, errors, logs and runtime samples for the dashboard." },
  { name: "TELEMETRY_DETAIL_PER_SECOND", group: "Telemetry", type: "int", min: 1, default: "200", doc: "Requests a second recorded with all their spans." },
  { name: "TELEMETRY_TRACES_PER_SECOND", group: "Telemetry", type: "int", min: 1, default: "25", doc: "Traces kept a second, and as many again for errors and slow requests." },
  { name: "LOG_RETENTION_DAYS", group: "Telemetry", type: "int", min: 1, default: "7", doc: "How long requests, traces, logs and finished jobs are kept." },
  {
    name: "LOG_FORMAT",
    group: "Telemetry",
    type: "enum",
    options: ["pretty", "json"],
    default: "pretty in dev, json otherwise",
    doc: "Server log lines: readable text or one JSON object per line.",
  },
  { name: "OTEL_SERVICE_NAME", group: "Telemetry", type: "string", default: "archlast-forge", doc: "The engine's name on the dashboard and on exported spans." },
  { name: "OTEL_EXPORTER_OTLP_ENDPOINT", group: "Telemetry", type: "string", default: "unset", doc: "Also export every request as OTLP/HTTP to this collector." },
  { name: "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", group: "Telemetry", type: "string", default: "unset", doc: "The full traces URL for the export; wins over the one above." },
  { name: "OTEL_EXPORTER_OTLP_HEADERS", group: "Telemetry", type: "string", secret: true, default: "unset", doc: "Headers for the export (key=value,…), such as the collector's API key." },
  {
    name: "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
    group: "Telemetry",
    type: "string",
    secret: true,
    default: "OTEL_EXPORTER_OTLP_HEADERS",
    doc: "Headers for the traces export; win over the ones above.",
  },
  {
    name: "MICROSERVICES",
    group: "Telemetry",
    type: "list",
    default: "none",
    doc: "This app's microservices as name=url (comma-separated): its dashboard shows their data, schema and telemetry.",
    envOnly: "The dashboard reads it when the server starts.",
  },
  {
    name: "DASHBOARD_URL",
    group: "Telemetry",
    type: "string",
    default: "unset",
    doc: "On a microservice: the main app's address. Its telemetry goes there, and that app's dashboard shows it.",
    envOnly: "The telemetry is sent from when the server starts.",
  },
  {
    name: "DASHBOARD_TOKEN",
    group: "Telemetry",
    type: "string",
    secret: true,
    default: "unset",
    doc: "The secret a main app and its microservices share for MICROSERVICES and DASHBOARD_URL.",
    envOnly: "A change has to reach the main app and every microservice at once.",
  },
  { name: "METRICS_TOKEN", group: "Telemetry", type: "string", secret: true, default: "ADMIN_KEY", doc: "The bearer token for GET /metrics." },
  { name: "FORGE_RELEASE", group: "Telemetry", type: "string", default: "the commit, or a hash of forge/", doc: "The release this server runs, for the Releases page." },
];

export const SETTING = new Map(SETTINGS.map((s) => [s.name, s]));

const set = (v: string | undefined) => v !== undefined && v !== "";

/** The environment the engine runs with: stored settings, then the process environment over them. Live settings are left to their readers. */
export function withSettings(env: Record<string, string | undefined>, stored: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env };
  for (const [name, value] of Object.entries(stored)) {
    const def = SETTING.get(name);
    if (def && !def.envOnly && !def.live && !set(env[name])) out[name] = value;
  }
  return out;
}

/** A live setting's value now: the environment's, else the stored one. */
export function liveEnv(env: Record<string, string | undefined>, stored: Record<string, string>): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = {};
  for (const def of SETTINGS) if (def.live) out[def.name] = set(env[def.name]) ? env[def.name] : stored[def.name];
  return out;
}

/** Normalizes a value typed into the dashboard, or says what is wrong with it. */
export function checkValue(def: SettingDef, raw: string): string {
  const value = raw.trim();
  if (def.envOnly) throw new ConfigError(`${def.name} can only be set in the environment. ${def.envOnly}`);
  if (def.type === "int" && !def.options?.includes(value) && (!/^\d+$/.test(value) || Number(value) < (def.min ?? 0)))
    throw new ConfigError(`${def.name} must be an integer ≥ ${def.min ?? 0}${def.options ? ` or ${def.options.join(", ")}` : ""}`);
  if (def.type === "bool") {
    const v = value.toLowerCase();
    if (["1", "true", "on", "yes"].includes(v)) return "on";
    if (["0", "false", "off", "no"].includes(v)) return "off";
    throw new ConfigError(`${def.name} is on or off`);
  }
  if (def.type === "enum" && !def.options!.includes(value)) throw new ConfigError(`${def.name} must be one of ${def.options!.join(", ")}`);
  if (def.type === "list")
    return value
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)
      .join(",");
  return value;
}

/** Throws ConfigError when the engine would refuse to start (or to back up) with these values: checked before a value is saved. */
export function validateSettings(env: Record<string, string | undefined>, stored: Record<string, string>, dev: boolean) {
  const config = loadConfig(withSettings(env, stored), dev);
  loadBackupConfig({ ...withSettings(env, stored), ...liveEnv(env, stored) }, config);
}

/**
 * Reads `_settings` straight from the database, before the function runtime (which owns it) has started: the server's own configuration
 * (workers, limits, cache) depends on them. Missing table or database: none stored yet.
 */
export async function readStoredSettings(config: Pick<Config, "databaseUrl" | "databaseKind" | "dataDir">): Promise<Record<string, string>> {
  let rows: { name: string; value: string }[] = [];
  try {
    if (config.databaseKind === "mongodb") {
      const { createMongoDb } = await import("./db/mongodb");
      const db = createMongoDb(config.databaseUrl!, { maxPoolSize: 1 });
      try {
        rows = (await db.query(`SELECT "name", "value" FROM "_settings"`)) as typeof rows;
      } finally {
        await db.close();
      }
    } else if (config.databaseUrl) {
      const sql = new SQL(config.databaseUrl, { max: 1 });
      try {
        rows = [...(await sql.unsafe(`SELECT "name", "value" FROM "_settings"`))] as typeof rows;
      } finally {
        await sql.close();
      }
    } else {
      const path = sqlitePath(config as Config);
      if (!existsSync(path)) return {};
      const db = new Database(path, { readonly: true });
      try {
        rows = db.query(`SELECT "name", "value" FROM "_settings"`).all() as typeof rows;
      } finally {
        db.close();
      }
    }
  } catch (e) {
    if (/_settings|no such table|does not exist/i.test(String((e as Error)?.message))) return {};
    throw e;
  }
  return Object.fromEntries(rows.map((r) => [r.name, r.value]));
}
