import { SQL } from "bun";
import { indexPlan, PREFIX, tableDDL } from "./migrate";
import { scopedTx, type Db, type DbTx, type Dialect } from "./types";

const field = (name: string) => `"doc"->'${name}'`;

export const postgresDialect: Dialect = {
  name: "postgres",
  realType: "DOUBLE PRECISION",
  jsonType: "JSONB",
  // Bound as text: Bun would JSON-encode a string bound straight to jsonb a second time.
  jsonParam: "?::text::jsonb",
  field,
  valueParam: "?::text::jsonb",
  encode: (value) => JSON.stringify(value),
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    return { sql: `${field(name)} = ?::text::jsonb`, params: [JSON.stringify(value)] };
  },
  listIndexesSql: `SELECT indexname AS name FROM pg_indexes WHERE tablename = ?`,
  searchWrite: () => [], // the GIN expression index stays in sync by itself
  searchSql(table, _index, fieldName, terms, filters, limit) {
    const vector = `to_tsvector('simple', coalesce("doc"->>'${fieldName}', ''))`;
    const query = terms.map((t, i) => (i === terms.length - 1 ? `${t}:*` : t)).join(" & ");
    return {
      sql: `SELECT "_id", "_creationTime", "doc" FROM "${table}" WHERE ${vector} @@ to_tsquery('simple', ?)${filters.map((f) => ` AND ${f.sql}`).join("")} ORDER BY ts_rank(${vector}, to_tsquery('simple', ?)) DESC, "_creationTime" LIMIT ${limit}`,
      params: [query, ...filters.flatMap((f) => f.params), query],
    };
  },
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
      const out = await sql.begin(options, async (tx) => {
        const scoped = scopedTx(txOf(tx));
        try {
          return { value: await fn(scoped) };
        } finally {
          scoped.end();
        }
      });
      return out.value;
    },
    async migrate(tables) {
      await db.transaction("write", async (tx) => {
        await tx.execute("SELECT pg_advisory_xact_lock(727274)");
        for (const t of tables) await tx.execute(tableDDL(postgresDialect, t.name));
      });
      // CONCURRENTLY can't run in a transaction, but it doesn't block writes on large tables.
      const conn = await sql.reserve();
      try {
        await conn.unsafe("SELECT pg_advisory_lock(727275)");
        for (const t of tables) {
          const plan = indexPlan(postgresDialect, t);
          const existing = (
            (await conn.unsafe(
              `SELECT c.relname AS name, i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid JOIN pg_class r ON r.oid = i.indrelid WHERE r.relname = $1`,
              [t.name],
            )) as { name: string; valid: boolean }[]
          ).filter((r) => r.name.startsWith(PREFIX));
          // An interrupted concurrent build leaves an invalid index behind; rebuild it.
          for (const r of existing) if (!plan.has(r.name) || !r.valid) await conn.unsafe(`DROP INDEX CONCURRENTLY IF EXISTS "${r.name}"`);
          for (const [name, body] of plan)
            if (!existing.some((r) => r.name === name && r.valid)) await conn.unsafe(`CREATE INDEX CONCURRENTLY IF NOT EXISTS "${name}" ${body}`);
        }
      } finally {
        await conn.unsafe("SELECT pg_advisory_unlock(727275)").catch(() => {});
        conn.release();
      }
    },
    close: () => sql.close(),
  };
  return db;
}
