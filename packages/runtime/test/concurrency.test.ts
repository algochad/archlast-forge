import { expect, test } from "bun:test";
import { join } from "node:path";
import { createTursoDb } from "../src/server/db/turso";
import { tempDir } from "./helpers";

type Result = { committed: number; conflicts: number; errors: string[] };

/** Several Workers, each with its own connections, writing to one database file. */
async function run(workers: number, rows: number, hot: boolean) {
  const path = join(tempDir(), "app.db");
  const db = await createTursoDb(path);
  await db.execute(`CREATE TABLE "rows" ("id" INTEGER PRIMARY KEY, "worker" INTEGER, "n" INTEGER)`);
  await db.execute(`CREATE TABLE "counter" ("id" INTEGER PRIMARY KEY, "n" INTEGER)`);
  await db.execute(`INSERT INTO "counter" ("id", "n") VALUES (1, 0)`);
  const results = await Promise.all(
    Array.from(
      { length: workers },
      (_, id) =>
        new Promise<Result>((resolve, reject) => {
          const w = new Worker(new URL("./concurrency.worker.ts", import.meta.url).href);
          w.onmessage = (e) => (resolve(e.data), w.terminate());
          w.onerror = (e) => reject(new Error(e.message));
          w.postMessage({ path, id, rows, hot });
        }),
    ),
  );
  const count = (await db.query<{ count: number }>(`SELECT COUNT(*) AS count FROM "rows"`))[0]!.count;
  const n = (await db.query<{ n: number }>(`SELECT "n" FROM "counter" WHERE "id" = 1`))[0]!.n;
  await db.close();
  return { results, count, n };
}

test("concurrent Workers inserting into one file lose no rows and see no errors", async () => {
  const { results, count } = await run(4, 100, false);
  expect(results.flatMap((r) => r.errors)).toEqual([]);
  expect(results.reduce((a, r) => a + r.committed, 0)).toBe(400);
  expect(count).toBe(400);
}, 60_000);

test("concurrent Workers updating one row conflict, retry, and still count exactly", async () => {
  const { results, n } = await run(4, 50, true);
  expect(results.flatMap((r) => r.errors)).toEqual([]);
  expect(n).toBe(200);
}, 60_000);

test("one process's write transactions run one at a time: a long one beside many small ones loses nothing", async () => {
  // Overlapping write transactions on separate connections froze the process for good under the benchmark load (bench/mixed-writes.ts reproduces it on a large database; this small one doesn't), so the adapter queues them.
  const db = await createTursoDb(join(tempDir(), "app.db"));
  await db.execute(`CREATE TABLE "rows" ("id" INTEGER PRIMARY KEY, "worker" INTEGER, "n" INTEGER, "pad" TEXT)`);
  await db.execute(`CREATE INDEX "rows_n" ON "rows" ("n", "worker")`);
  const insert = async (tx: { query(sql: string, params?: unknown[]): Promise<unknown[]>; execute(sql: string, params?: unknown[]): Promise<void> }, n: number) => {
    await tx.query(`SELECT "id" FROM "rows" WHERE "n" = ? AND "worker" = ?`, [n, 0]);
    await tx.execute(`INSERT INTO "rows" ("worker", "n", "pad") VALUES (?, ?, ?)`, [0, n, "x".repeat(2000)]); // enough bytes to cross the engine's checkpoint threshold
  };
  const end = Date.now() + 4000;
  let small = 0;
  let big = 0;
  await Promise.all([
    (async () => {
      while (Date.now() < end) {
        await db.transaction("write", async (tx) => {
          for (let i = 0; i < 600; i++) await insert(tx, i);
        });
        big += 600;
        await Bun.sleep(300);
      }
    })(),
    ...Array.from({ length: 50 }, async () => {
      while (Date.now() < end) {
        await db.transaction("write", (tx) => insert(tx, 1));
        small++;
        await Bun.sleep(20 + Math.random() * 60);
      }
    }),
  ]);
  expect(((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "rows"`))[0] as { n: number }).n).toBe(small + big);
  await db.close();
}, 30_000);
