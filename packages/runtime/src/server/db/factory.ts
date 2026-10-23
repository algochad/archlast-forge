import { createSqliteDb } from "./sqlite";
import type { Db } from "./types";

export type SqliteDriver = "turso" | "bun";

/** The embedded database at `path`: Turso (the default) or bun:sqlite. They use different file formats, so a file belongs to the driver that made it. */
export async function createLocalDb(path: string, driver: SqliteDriver = (process.env.SQLITE_DRIVER as SqliteDriver | undefined) ?? "turso"): Promise<Db> {
  if (driver === "bun") return createSqliteDb(path);
  if (driver !== "turso") throw new Error(`SQLITE_DRIVER must be "turso" or "bun", got "${driver}"`);
  return (await import("./turso")).createTursoDb(path);
}
