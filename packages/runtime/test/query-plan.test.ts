import { expect, test } from "bun:test";
import { createSqliteDb } from "../src/server/db/sqlite";
import { DocStore, type TablesSpec } from "../src/server/docstore";
import { v } from "../src/values";

const tables: TablesSpec = {
  notes: { fields: { body: v.string(), tag: v.string(), n: v.number() }, indexes: { by_n: ["n"], by_tag_n: ["tag", "n"] }, strict: true },
};

test("in dev, a where() or orderBy() query that no index serves says so, once", async () => {
  const db = createSqliteDb(":memory:");
  await db.migrate([{ name: "notes", indexes: tables.notes!.indexes }]);
  const warnings: string[] = [];
  const read = <T>(fn: (s: any) => Promise<T>) => db.transaction("read", (tx) => fn(new DocStore(tx, db.dialect, tables, new Set(), undefined, undefined, undefined, (m) => warnings.push(m))));

  await read((s) => s.query("notes").where((q: any) => q.eq("body", "x")).collect());
  expect(warnings).toEqual([expect.stringContaining('A query on "notes" reads every document of the table: no index serves its where() or orderBy() (SQLite: SCAN notes')]);
  await read((s) => s.query("notes").where((q: any) => q.eq("body", "y")).collect()); // the same statement: not again
  expect(warnings).toHaveLength(1);

  // An index serves these: no warning.
  await read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "a")).where((q: any) => q.gt("n", 2)).collect());
  await read((s) => s.query("notes").where((q: any) => q.eq("n", 3)).collect()); // SQLite picks by_n on its own
  await read((s) => s.query("notes").withIndex("by_n").orderBy([["n", "desc"]]).take(5));
  expect(warnings).toHaveLength(1);

  await read((s) => s.query("notes").withIndex("by_n", (q: any) => q.gt("n", 0)).orderBy([["body", "asc"]]).take(5));
  expect(warnings[1]).toContain("sorts its results without an index");
  await db.close();
});
