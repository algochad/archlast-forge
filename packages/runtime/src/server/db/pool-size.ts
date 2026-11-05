// How many Postgres connections a function-runtime process opens. Bun's SQL client opens every connection of a pool at its first query and
// keeps them (a pool of 64 is 64 backends a moment after start, busy or not), so the pools' maximum is what the server holds, and it has to
// fit the database: a default Postgres allows 100, and twice and four times the cores of a 16-core machine (32 + 64) plus the telemetry store
// left nothing for a second process, a hot reload or psql. So unless the pools are set, they are a share of what Postgres allows.
import { SQL } from "bun";

/** The telemetry store's connections, in the server process: 2 for its reads, 1 for its writes. */
export const TELEMETRY_CONNECTIONS = 3;
/** The share of Postgres's usable connections the pools of one server take by default, leaving the rest for tools, a reload and other clients. */
export const DEFAULT_SHARE = 0.6;
/** Above this share of the usable connections, the server says so at start. */
export const WARN_SHARE = 0.8;
/** In development the database serves one person: small pools, which also leave room for the moment a reload runs two processes. */
const DEV_READ = 4;
const DEV_WRITE = 8;
/** When the limit can't be read (the database is unreachable for a moment): pools that fit any Postgres. */
const FALLBACK_READ = 4;
const FALLBACK_WRITE = 8;

export interface PostgresLimits {
  /** `max_connections`. */
  maxConnections: number;
  /** Slots an ordinary role can't use: `superuser_reserved_connections` and, from Postgres 16, `reserved_connections`. */
  reserved: number;
  /** Client connections already open when this was read, besides the one that read it: other servers, tools, other apps. */
  inUse: number;
}

export interface PoolPlan {
  /** Connections per function-runtime process for reads and for write transactions. */
  read: number;
  write: number;
  /** Whether the sizes came from the database's limit (or the defaults), rather than DATABASE_POOL_SIZE / DATABASE_WRITE_POOL_SIZE. */
  auto: boolean;
  workers: number;
  /** Servers of this app (REPLICAS), which share the database's connections. */
  replicas: number;
  /** The most this server holds: every process's pools and the telemetry store's. */
  total: number;
  /** What Postgres allows, when it could be read. */
  limits?: PostgresLimits & { usable: number };
}

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.floor(n)));

/**
 * The pools for one function-runtime process. A size that is set is used as it is (a set read pool alone still gets twice as many write
 * connections, as before). Otherwise this server's processes share `DEFAULT_SHARE` of the connections Postgres lets an ordinary role open,
 * split evenly between this app's servers (REPLICAS) and their processes, a third for reads and the rest for writes (at most twice the reads, which is the split the write pool was measured with), never more than
 * the old defaults: twice the cores for reads, twice that for writes.
 */
export function planPools(o: { cores: number; workers: number; replicas?: number; dev: boolean; read?: number; write?: number; limits?: PostgresLimits }): PoolPlan {
  const workers = Math.max(1, o.workers);
  const replicas = Math.max(1, o.replicas ?? 1);
  const limits = o.limits && { ...o.limits, usable: Math.max(1, o.limits.maxConnections - o.limits.reserved) };
  const capRead = o.dev ? DEV_READ : Math.max(1, o.cores * 2);
  const capWrite = o.dev ? DEV_WRITE : capRead * 2;
  let read: number;
  let write: number;
  if (o.read !== undefined) {
    read = o.read;
    write = o.write ?? read * 2;
  } else if (!limits) {
    write = o.write ?? Math.min(FALLBACK_WRITE, capWrite);
    read = Math.min(FALLBACK_READ, capRead);
  } else {
    // Every server (REPLICAS) runs the same pools and a telemetry store of its own.
    const perProcess = Math.floor((Math.floor(limits.usable * DEFAULT_SHARE) - replicas * TELEMETRY_CONNECTIONS) / (replicas * workers));
    if (o.write !== undefined) {
      write = o.write;
      read = clamp(perProcess - write, 1, capRead);
    } else {
      read = clamp(perProcess / 3, 1, capRead);
      write = clamp(perProcess - read, 1, Math.min(capWrite, read * 2));
    }
  }
  return { read, write, auto: o.read === undefined, workers, replicas, total: workers * (read + write) + TELEMETRY_CONNECTIONS, ...(limits && { limits }) };
}

/** Reads what Postgres allows, on a connection of its own that is closed at once; undefined when it can't be read. */
export async function readPostgresLimits(url: string): Promise<PostgresLimits | undefined> {
  const sql = new SQL(url, { max: 1 });
  try {
    const setting = async (name: string) => {
      try {
        return Number((await sql.unsafe(`SHOW ${name}`))[0]?.[name]) || 0;
      } catch {
        return 0; // reserved_connections is new in Postgres 16
      }
    };
    const maxConnections = await setting("max_connections");
    if (!maxConnections) return undefined;
    const reserved = (await setting("superuser_reserved_connections")) + (await setting("reserved_connections"));
    const [row] = await sql.unsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`);
    return { maxConnections, reserved, inUse: Number(row?.n) || 0 };
  } catch {
    return undefined;
  } finally {
    await sql.close().catch(() => {});
  }
}

/** One line that says what this server holds against what Postgres allows, and whether that is too close. */
export function describePlan(plan: PoolPlan): { level: "info" | "warn"; message: string } {
  const sizes = `${plan.workers > 1 ? `${plan.workers} processes × ` : ""}(${plan.read} read + ${plan.write} write) + ${TELEMETRY_CONNECTIONS} telemetry = ${plan.total}`;
  const how = plan.auto ? "sized from max_connections; set DATABASE_POOL_SIZE and DATABASE_WRITE_POOL_SIZE to choose" : "set by DATABASE_POOL_SIZE and DATABASE_WRITE_POOL_SIZE";
  const l = plan.limits;
  if (!l) return { level: "info", message: `Postgres connections: ${sizes} (${how}; max_connections couldn't be read)` };
  const of = `${plan.replicas > 1 ? `on each of ${plan.replicas} servers (REPLICAS), ` : ""}of the ${l.usable} Postgres allows (max_connections ${l.maxConnections}, ${l.reserved} reserved)`;
  // What is open already includes the other servers that have started; the ones that haven't are counted from REPLICAS.
  const busy = Math.max(l.inUse + plan.total, plan.replicas * plan.total);
  if (busy > l.usable * WARN_SHARE)
    return {
      level: "warn",
      message:
        `Postgres connections: this server holds up to ${sizes}${plan.replicas > 1 ? ` (${plan.replicas} servers: ${plan.replicas * plan.total})` : ""}, and ${l.inUse} other connection${l.inUse === 1 ? " was" : "s were"} already open: ${busy} of the ${l.usable} Postgres allows (max_connections ${l.maxConnections}, ${l.reserved} reserved). ` +
        `Another server, a reload or a tool may be refused ("too many clients"). Lower DATABASE_POOL_SIZE and DATABASE_WRITE_POOL_SIZE or RUNTIME_WORKERS, or raise max_connections.`,
    };
  return { level: "info", message: `Postgres connections: ${sizes} ${of} (${how})` };
}

/** Postgres's "sorry, too many clients already" (SQLSTATE 53300), as Bun's client reports it. */
export const isTooManyClients = (e: unknown) => {
  const err = e as { errno?: unknown; code?: unknown } | null;
  return String(err?.errno) === "53300" || String(err?.code) === "53300";
};
