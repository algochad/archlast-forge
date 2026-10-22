import type { Db, TableSpec } from "./types";

const PREFIX = "afx_";

/** Index names hash their definition, so changing an index's fields drops and recreates it. */
const indexName = (table: string, index: string, fields: readonly string[]) =>
  PREFIX + Bun.hash(`${table}\0${index}\0${fields.join(",")}`).toString(16);

export async function migrateTables(db: Db, tables: TableSpec[], lockSql?: string) {
  const d = db.dialect;
  await db.transaction("write", async (tx) => {
    if (lockSql) await tx.execute(lockSql);
    for (const t of tables) {
      await tx.execute(
        `CREATE TABLE IF NOT EXISTS "${t.name}" ("_id" TEXT PRIMARY KEY, "_creationTime" ${d.realType} NOT NULL, "doc" ${d.jsonType} NOT NULL)`,
      );
      const wanted = new Map<string, string>();
      for (const [index, fields] of [["by_creation_time", []] as const, ...Object.entries(t.indexes)]) {
        const name = indexName(t.name, index, fields);
        const cols = [...fields.map((f) => `(${d.field(f)})`), `"_creationTime"`, `"_id"`].join(", ");
        wanted.set(name, `CREATE INDEX IF NOT EXISTS "${name}" ON "${t.name}" (${cols})`);
      }
      const existing = (await tx.query<{ name: string }>(d.listIndexesSql, [t.name]))
        .map((r) => r.name)
        .filter((n) => n.startsWith(PREFIX));
      for (const name of existing) if (!wanted.has(name)) await tx.execute(`DROP INDEX IF EXISTS "${name}"`);
      for (const [name, sql] of wanted) if (!existing.includes(name)) await tx.execute(sql);
    }
  });
}
