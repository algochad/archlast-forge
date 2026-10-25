import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import { tempDir } from "./helpers";

const setup = async () => {
  const db = createSqliteDb(join(tempDir(), "app.db"));
  await db.execute(`CREATE TABLE "t" ("k" TEXT PRIMARY KEY, "v" INTEGER)`);
  return db;
};
const insert = (k: string, v = 0) => (tx: { execute(sql: string, params?: unknown[]): Promise<void> }) => tx.execute(`INSERT INTO "t" VALUES (?, ?)`, [k, v]);

test("concurrent write transactions all commit, and each sees the ones before it", async () => {
  const db = await setup();
  const seen: number[] = [];
  await Promise.all(
    Array.from({ length: 100 }, (_, i) =>
      db.transaction("write", async (tx) => {
        seen.push(((await tx.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "t"`))[0] as { n: number }).n);
        await insert(`k${i}`)(tx);
      }),
    ),
  );
  expect(seen).toEqual(Array.from({ length: 100 }, (_, i) => i)); // serial order, as if one at a time
  expect(((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "t"`))[0] as { n: number }).n).toBe(100);
  await db.close();
});

test("a failing transaction in a batch rolls back alone and rejects with its own error", async () => {
  const db = await setup();
  const results = await Promise.allSettled([
    db.transaction("write", insert("a")),
    db.transaction("write", async (tx) => {
      await insert("b")(tx);
      throw new Error("nope");
    }),
    db.transaction("write", insert("a")), // a constraint error from SQLite itself
    db.transaction("write", insert("c")),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "rejected", "fulfilled"]);
  expect((results[1] as PromiseRejectedResult).reason.message).toBe("nope");
  expect(String((results[2] as PromiseRejectedResult).reason)).toContain("UNIQUE");
  expect((await db.query<{ k: string }>(`SELECT "k" FROM "t" ORDER BY "k"`)).map((r) => r.k)).toEqual(["a", "c"]);
  await db.close();
});

test("a transaction resolves only once committed: another connection sees its write at once", async () => {
  const db = await setup();
  const checks = Array.from({ length: 20 }, (_, i) =>
    db.transaction("write", insert(`k${i}`, i)).then(async () => (await db.query(`SELECT "v" FROM "t" WHERE "k" = ?`, [`k${i}`])).length),
  );
  expect(await Promise.all(checks)).toEqual(Array(20).fill(1)); // read on a reader connection, not the writer
  await db.close();
});

test("statements that can't run in a transaction wait their turn between batches", async () => {
  const dir = tempDir();
  const db = await setup();
  const writes = Array.from({ length: 30 }, (_, i) => db.transaction("write", insert(`k${i}`)));
  await db.execute(`VACUUM INTO ?`, [join(dir, "copy.db")]);
  await Promise.all(writes);
  expect(existsSync(join(dir, "copy.db"))).toBe(true);
  await db.close();
});

test("a background thread checkpoints the WAL into the database file", async () => {
  const dir = tempDir();
  const db = createSqliteDb(join(dir, "app.db"));
  await db.execute(`CREATE TABLE "t" ("k" TEXT PRIMARY KEY, "v" TEXT)`);
  const size = () => Bun.file(join(dir, "app.db")).size;
  const before = size();
  await Promise.all(Array.from({ length: 12_000 }, (_, i) => db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (?, ?)`, [`k${i}`, "x".repeat(4000)])))); // past the 32 MiB that starts a checkpoint
  for (let i = 0; i < 400 && size() <= before; i++) await Bun.sleep(100); // the connections here never checkpoint themselves
  expect(size()).toBeGreaterThan(before + 100_000);
  await db.close();
}, 60_000);
