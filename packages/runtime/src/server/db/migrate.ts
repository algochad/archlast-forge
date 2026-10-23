import type { Db, DbTx, Dialect, TableSpec } from "./types";

export const PREFIX = "afx_";

/** Index names hash their definition, so changing an index's fields drops and recreates it. */
const hashName = (...parts: string[]) => PREFIX + Bun.hash(parts.join("\0")).toString(16);

/** SQLite FTS5 table backing one search index. */
export const ftsTable = (table: string, index: string) => `afx_fts_${Bun.hash(`${table}\0${index}`).toString(16)}`;

export const tableDDL = (d: Dialect, table: string) =>
  `CREATE TABLE IF NOT EXISTS "${table}" ("_id" TEXT PRIMARY KEY, "_creationTime" ${d.realType} NOT NULL, "doc" ${d.jsonType} NOT NULL)`;

/** Wanted B-tree (and, on Postgres, search) indexes for a table: name → `ON … (…)`. */
export function indexPlan(d: Dialect, t: TableSpec): Map<string, string> {
  const plan = new Map<string, string>();
  for (const [index, fields] of [["by_creation_time", []] as const, ...Object.entries(t.indexes)]) {
    const cols = [...fields.map((f) => `(${d.field(f)})`), `"_creationTime"`, `"_id"`].join(", ");
    plan.set(hashName(t.name, index, fields.join(",")), `ON "${t.name}" (${cols})`);
  }
  if (d.name === "postgres")
    for (const [index, { searchField }] of Object.entries(t.searchIndexes ?? {}))
      plan.set(hashName(t.name, "search", index, searchField), `ON "${t.name}" USING GIN (to_tsvector('simple', coalesce("doc"->>'${searchField}', '')))`);
  return plan;
}

/** SQLite: tables, indexes and FTS tables in one write transaction. */
export async function migrateSqlite(db: Db, tables: TableSpec[]) {
  const d = db.dialect;
  await db.transaction("write", async (tx) => {
    await tx.execute(`CREATE TABLE IF NOT EXISTS "_search_indexes" ("name" TEXT PRIMARY KEY, "table" TEXT NOT NULL, "field" TEXT NOT NULL)`);
    for (const t of tables) {
      await tx.execute(tableDDL(d, t.name));
      const plan = indexPlan(d, t);
      const existing = (await tx.query<{ name: string }>(d.listIndexesSql, [t.name])).map((r) => r.name).filter((n) => n.startsWith(PREFIX));
      for (const name of existing) if (!plan.has(name)) await tx.execute(`DROP INDEX IF EXISTS "${name}"`);
      for (const [name, body] of plan) if (!existing.includes(name)) await tx.execute(`CREATE INDEX IF NOT EXISTS "${name}" ${body}`);

      const wanted = new Map(Object.entries(t.searchIndexes ?? {}).map(([index, c]) => [ftsTable(t.name, index), { index, field: c.searchField }]));
      const registered = await tx.query<{ name: string; field: string }>(`SELECT "name", "field" FROM "_search_indexes" WHERE "table" = ?`, [t.name]);
      for (const r of registered)
        if (wanted.get(r.name)?.field !== r.field) {
          await tx.execute(`DROP TABLE IF EXISTS "${r.name}"`);
          await tx.execute(`DELETE FROM "_search_indexes" WHERE "name" = ?`, [r.name]);
        }
      for (const [name, { index, field }] of wanted) {
        if (registered.some((r) => r.name === name && r.field === field)) continue;
        if (d.search === "tokens") {
          await tx.execute(`CREATE TABLE "${name}" ("term" TEXT NOT NULL, "doc_id" TEXT NOT NULL, "tf" INTEGER NOT NULL, PRIMARY KEY ("term", "doc_id"))`);
          await tx.execute(`CREATE INDEX "${name}_doc" ON "${name}" ("doc_id")`);
          await backfillTokens(tx, d, t.name, index, field);
        } else {
          await tx.execute(`CREATE VIRTUAL TABLE "${name}" USING fts5(doc_id UNINDEXED, body, tokenize = 'unicode61')`);
          await tx.execute(
            `INSERT INTO "${name}" (doc_id, body) SELECT "_id", ${d.field(field)} FROM "${t.name}" WHERE ${d.field(field)} IS NOT NULL`,
          );
        }
        await tx.execute(`INSERT INTO "_search_indexes" ("name", "table", "field") VALUES (?, ?, ?)`, [name, t.name, field]);
      }
    }
  });
}

/** Fills a new token-table search index from the documents already there, a batch at a time. */
async function backfillTokens(tx: DbTx, d: Dialect, table: string, index: string, field: string) {
  for (let after = ""; ; ) {
    const rows = await tx.query<{ _id: string; v: unknown }>(`SELECT "_id", ${d.field(field)} AS v FROM "${table}" WHERE "_id" > ? ORDER BY "_id" LIMIT 500`, [after]);
    if (!rows.length) return;
    for (const r of rows) if (typeof r.v === "string") for (const stmt of d.searchWrite(table, index, r._id, r.v)) await tx.execute(stmt.sql, stmt.params);
    after = rows.at(-1)!._id;
  }
}
