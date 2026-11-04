import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createSqliteDb, WalSyncer } from "../src/server/db/sqlite";
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

test("SQLITE_SYNCHRONOUS: FULL by default, NORMAL on request, anything else is refused", async () => {
  const { loadConfig } = await import("../src/server/config");
  expect(loadConfig({}, true).sqliteSynchronous).toBe("FULL");
  expect(loadConfig({ SQLITE_SYNCHRONOUS: "normal" }, true).sqliteSynchronous).toBe("NORMAL");
  expect(() => loadConfig({ SQLITE_SYNCHRONOUS: "off" }, true)).toThrow("SQLITE_SYNCHRONOUS");
});

test("with FULL a write is answered only after the syncer's fsync, and is on disk when it is", async () => {
  const dir = tempDir();
  for (const mode of ["FULL", "NORMAL"] as const) {
    const db = createSqliteDb(join(dir, `${mode}.db`), 4, undefined, mode);
    await db.execute(`CREATE TABLE "t" ("k" INTEGER PRIMARY KEY, "v" TEXT)`);
    await Promise.all(Array.from({ length: 300 }, (_, i) => db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (?, ?)`, [i, "x"]))));
    // the answers are all in, so every row is committed and visible to a reader
    expect(((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "t"`))[0] as { n: number }).n).toBe(300);
    // a failure in one transaction of a batch still fails alone, and the others are answered
    const results = await Promise.allSettled([
      db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (1000, 'ok')`)),
      db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (1, 'duplicate')`)),
      db.transaction("write", (tx) => tx.execute(`INSERT INTO "t" VALUES (1001, 'ok')`)),
    ]);
    expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
    await db.close();
  }
  // reopened from the file, as after a restart, everything answered is there
  const again = createSqliteDb(join(dir, "FULL.db"));
  expect(((await again.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "t"`))[0] as { n: number }).n).toBe(302);
  await again.close();
});

test("WalSyncer: every call is answered, one fsync serves the calls made while it runs, and a failure rejects them", async () => {
  const dir = tempDir();
  const db = createSqliteDb(join(dir, "app.db"), 4, undefined, "NORMAL");
  await db.execute(`CREATE TABLE "t" ("k" INTEGER)`);
  const syncer = new WalSyncer(join(dir, "app.db-wal"), join(dir, "app.db"));
  const order: number[] = [];
  await Promise.all(Array.from({ length: 50 }, (_, i) => syncer.sync().then(() => order.push(i))));
  expect(order).toEqual(Array.from({ length: 50 }, (_, i) => i)); // answered in the order asked
  const broken = new WalSyncer(join(dir, "missing", "x-wal"), join(dir, "missing", "x"));
  await expect(broken.sync()).rejects.toThrow("could not sync");
  await db.close();
});

test("every write that was answered is in the database after the process is killed", async () => {
  const file = join(tempDir(), "killed.db");
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixture-acked-writes.ts"), file, "FULL"], { stdout: "pipe", stderr: "inherit" });
  const acked = new Set<number>();
  let rest = "";
  const reader = child.stdout.getReader();
  while (acked.size < 3000) {
    const { value, done } = await reader.read();
    if (done) break;
    rest += new TextDecoder().decode(value);
    const lines = rest.split("\n");
    rest = lines.pop()!;
    for (const line of lines) acked.add(Number(line));
  }
  child.kill("SIGKILL"); // no chance to flush or close anything
  await child.exited;
  expect(acked.size).toBeGreaterThanOrEqual(3000);
  const db = createSqliteDb(file, 1);
  const stored = new Set((await db.query<{ k: number }>(`SELECT k FROM "t"`)).map((r) => r.k));
  const lost = [...acked].filter((k) => !stored.has(k));
  expect(lost).toEqual([]);
  await db.close();
}, 60_000);
