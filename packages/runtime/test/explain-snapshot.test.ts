// The dev query-plan check runs EXPLAIN QUERY PLAN beside where()/orderBy() queries. bun:sqlite's cached statement for an EXPLAIN is not reset
// by .all(), and an active statement keeps its connection's read snapshot after COMMIT: every later read on that connection saw the database
// as it was. These check the adapter, and the executor with the dev check on, against test/fixture-where.
import { expect, test } from "bun:test";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";
import { migrateScheduler } from "../src/server/scheduler";
import { tempDir } from "./helpers";

test("a read transaction that ran an EXPLAIN does not keep its snapshot: the next read sees later writes", async () => {
  const db = createSqliteDb(join(tempDir(), "app.db"), 1); // one reader connection, so every read uses it
  await db.execute(`CREATE TABLE "t" ("a" TEXT)`);
  await db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES ('x')`));
  await db.transaction("read", async (tx) => {
    await tx.query(`EXPLAIN QUERY PLAN SELECT * FROM "t" WHERE "a" = ?`, ["x"]);
    return tx.query(`SELECT * FROM "t" WHERE "a" = ?`, ["x"]);
  });
  await db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES ('x')`));
  const [{ n }] = (await db.transaction("read", (tx) => tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "t"`))) as [{ n: number }];
  expect(n).toBe(2);
  await db.close();
});

test("with the dev query-plan check on, reads after a where() + paginate() query see every write", async () => {
  const project = await loadProject(join(import.meta.dir, "fixture-where"));
  const db = createSqliteDb(join(tempDir(), "app.db"));
  await db.migrate(tableSpecs(project.tables));
  await migrateScheduler(db);
  const exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {}, devWarn: () => {} }); // the dev check on
  const call = async (name: string, kind: "query" | "mutation", args: object) => (await exec.call(name, kind, args, null)).value as any;
  const seen: number[][] = [];
  for (let i = 0; i < 3; i++) {
    await call("jobs:add", "mutation", { app: "a", status: "open" });
    seen.push([(await call("jobs:page", "query", { app: "a", status: "open", paginationOpts: { numItems: 10, cursor: null } })).page.length, await call("jobs:all", "query", {})]);
  }
  expect(seen).toEqual([[1, 1], [2, 2], [3, 3]]);
  await db.close();
});
