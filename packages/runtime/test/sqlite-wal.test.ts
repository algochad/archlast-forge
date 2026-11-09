import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";

const MiB = 2 ** 20;

test("writes that never pause do not make the WAL grow without a limit, and nothing is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-wal-"));
  const path = join(dir, "app.db");
  const db = createSqliteDb(path, 2, undefined, "NORMAL");
  await db.transaction("write", async (tx) => void (await tx.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, doc TEXT, k INTEGER)")));
  await db.transaction("write", async (tx) => void (await tx.execute("CREATE INDEX tk ON t (k)")));
  const payload = "x".repeat(900); // about four pages of WAL per insert with the index
  let inserted = 0;
  let peak = 0;
  const started = performance.now();
  // 32 writers that start the next write as soon as the last one is answered, for 5 seconds, as a client under load does
  await Promise.all(
    Array.from({ length: 32 }, async (_, w) => {
      while (performance.now() - started < 5000) {
        await db.transaction("write", async (tx) => void (await tx.execute("INSERT INTO t (doc, k) VALUES (?, ?)", [payload, inserted++ * 7919 + w])));
        if (inserted % 200 === 0) peak = Math.max(peak, statSync(`${path}-wal`).size);
      }
    }),
  );
  const n = (await db.transaction("read", async (tx) => ((await tx.query("SELECT count(*) AS n FROM t")) as { n: number }[])[0]!.n)) as number;
  expect(n).toBe(inserted); // every acknowledged write is there
  // The thread checks every 250 ms and restarts the log past 64 MiB, so the file stays within a few hundred MiB even at hundreds of thousands of inserts a second.
  expect(inserted).toBeGreaterThan(20_000); // the test wrote enough for the old behavior to reach gigabytes
  const bounded = peak < 400 * MiB;
  await db.close();
  rmSync(dir, { recursive: true, force: true }); // before the assertion: a failing run must not leave gigabytes behind
  expect(bounded).toBe(true);
}, 30_000);
