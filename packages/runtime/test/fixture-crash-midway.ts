// Answers two transactions, then starts a third that writes its first row, tells the test, and waits to be killed before its second.
import { createSqliteDb } from "../src/server/db/sqlite";

const db = createSqliteDb(process.argv[2]!);
await db.execute(`CREATE TABLE IF NOT EXISTS "t" ("k" TEXT PRIMARY KEY)`);
for (const k of ["answered-1", "answered-2"]) await db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (?)`, [k]));
await db.transaction("write", async (tx) => {
  await tx.execute(`INSERT INTO "t" VALUES ('unfinished-1')`);
  process.stdout.write("MIDWAY\n");
  await Bun.sleep(60_000);
  await tx.execute(`INSERT INTO "t" VALUES ('unfinished-2')`);
});
