import { sqlitePath, type Config } from "../config";
import { planPools, readPostgresLimits, type PoolPlan } from "./pool-size";
import { createPostgresDb } from "./postgres";
import { nativeDb } from "./native";
import { createSqliteDb } from "./sqlite";
import { createNativeSqliteDb } from "./sqlite-native";
import type { Db } from "./types";

/**
 * The database `DATABASE_URL` names (SQLite in `DATA_DIR` when it is unset). `memory` is the RAM SQLite may use. On Postgres, `workers` is how
 * many processes of this server open the same pools (the function runtime's, RUNTIME_WORKERS; 1 for a CLI command), and `plan` hears how
 * they were sized.
 */
export async function openDatabase(config: Config, memory?: number, opts: { workers?: number; plan?: (plan: PoolPlan) => void } = {}): Promise<Db> {
  if (config.databaseKind === "postgres") {
    const set = config.databasePoolSize !== undefined && config.databaseWritePoolSize !== undefined;
    const plan = planPools({
      cores: navigator.hardwareConcurrency,
      workers: opts.workers ?? config.runtimeWorkers,
      replicas: config.replicas,
      dev: config.dev,
      read: config.databasePoolSize,
      write: config.databaseWritePoolSize,
      // Read only when it decides something: both sizes set means none of it is used, except to warn.
      limits: set && !opts.plan ? undefined : await readPostgresLimits(config.databaseUrl!),
    });
    opts.plan?.(plan);
    return createPostgresDb(config.databaseUrl!, plan.read, plan.write);
  }
  // MongoDB's pool is both: reads and writes share its connections. The driver is loaded only by those who use it.
  if (config.databaseKind === "mongodb") {
    const read = config.databasePoolSize ?? navigator.hardwareConcurrency * 2;
    return (await import("./mongodb")).createMongoDb(config.databaseUrl!, { maxPoolSize: read + (config.databaseWritePoolSize ?? read * 2) });
  }
  if (config.dbEngine === "native") {
    const native = nativeDb();
    if (!native) throw new Error("DB_ENGINE=native, but the native database layer is not available here (Linux, built with `bun run build` in packages/db, or the engine image)");
    return createNativeSqliteDb(sqlitePath(config), native, undefined, memory, config.sqliteSynchronous);
  }
  return createSqliteDb(sqlitePath(config), undefined, memory, config.sqliteSynchronous);
}
