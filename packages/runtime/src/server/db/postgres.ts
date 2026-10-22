import { SQL } from "bun";
import { migrateTables } from "./migrate";
import type { Db, DbTx, Dialect } from "./types";

const field = (name: string) => `"doc"->'${name}'`;

export const postgresDialect: Dialect = {
  name: "postgres",
  realType: "DOUBLE PRECISION",
  jsonType: "JSONB",
  // Bound as text: Bun would JSON-encode a string bound straight to jsonb a second time.
  jsonParam: "?::text::jsonb",
  field,
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    return { sql: `${field(name)} = ?::text::jsonb`, params: [JSON.stringify(value)] };
  },
  listIndexesSql: `SELECT indexname AS name FROM pg_indexes WHERE tablename = ?`,
};

const toPg = (sql: string) => {
  let i = 0;
  return sql.replace(/\?/g, () => `$${++i}`);
};

/** Pooled connections (CPU count × 2 by default). Writes run SERIALIZABLE; callers retry on conflicts. */
export function createPostgresDb(url: string, max = navigator.hardwareConcurrency * 2): Db {
  const sql = new SQL(url, { max });
  const txOf = (s: SQL): DbTx => ({
    query: async (q, params = []) => [...(await s.unsafe(toPg(q), params as any[]))],
    execute: async (q, params = []) => {
      await s.unsafe(toPg(q), params as any[]);
    },
  });
  const db: Db = {
    dialect: postgresDialect,
    ...txOf(sql),
    async transaction(mode, fn) {
      const options = mode === "write" ? "isolation level serializable" : "isolation level repeatable read read only";
      // Wrapped: Bun pipelines an array returned from begin() as queries.
      const out = await sql.begin(options, async (tx) => ({ value: await fn(txOf(tx)) }));
      return out.value;
    },
    migrate: (tables) => migrateTables(db, tables, "SELECT pg_advisory_xact_lock(727274)"),
    close: () => sql.close(),
  };
  return db;
}
