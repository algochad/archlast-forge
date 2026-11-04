import { sqlitePath, type Config } from "../config";
import { createPostgresDb } from "./postgres";
import { createSqliteDb } from "./sqlite";
import type { Db } from "./types";

/** The database `DATABASE_URL` names (SQLite in `DATA_DIR` when it is unset). `memory` is the RAM SQLite may use. */
export async function openDatabase(
  config: Config,
  memory?: number,
): Promise<Db> {
  if (config.databaseKind === "postgres")
    return createPostgresDb(
      config.databaseUrl!,
      config.databasePoolSize,
      config.databaseWritePoolSize,
    );
  // MongoDB's pool is both: reads and writes share its connections.
  // The driver is loaded only by those who use it.
  if (config.databaseKind === "mongodb")
    return (await import("./mongodb")).createMongoDb(config.databaseUrl!, {
      maxPoolSize: config.databasePoolSize + config.databaseWritePoolSize,
    });
  return createSqliteDb(sqlitePath(config), undefined, memory, config.sqliteSynchronous);
}
