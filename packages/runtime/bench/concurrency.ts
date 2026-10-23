// Several Bun Workers writing to one database file: Turso (MVCC, BEGIN CONCURRENT) against bun:sqlite (WAL), with and without busy_timeout.
//   bun bench/concurrency.ts [workers=4] [rowsPerWorker=500] [insert|hot]
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [workers = 4, rows = 500] = process.argv.slice(2, 4).map(Number);
const hot = process.argv[4] === "hot"; // every transaction updates the same row, so Turso reports write-write conflicts
const LABEL = { "bun-nobusy": "bun:sqlite WAL, no busy_timeout", "bun-busy": "bun:sqlite WAL, busy_timeout 5000", turso: "turso, BEGIN CONCURRENT (MVCC)" } as const;
const DDL = `CREATE TABLE t (id INTEGER PRIMARY KEY, w INTEGER, n INTEGER)`;
const dir = mkdtempSync(join(tmpdir(), "conc-"));

async function trial(driver: keyof typeof LABEL) {
  const path = join(dir, `${driver}.db`);
  if (driver === "turso") {
    const { connect } = await import("@tursodatabase/database");
    const db = await connect(path);
    await (await db.prepare("PRAGMA journal_mode = 'mvcc'")).all();
    await db.exec(DDL);
    if (hot) await db.exec(`INSERT INTO t (id, w, n) VALUES (1, 0, 0)`);
    await db.close();
  } else {
    const db = new Database(path);
    db.exec(`PRAGMA journal_mode = WAL; ${DDL}`);
    if (hot) db.exec(`INSERT INTO t (id, w, n) VALUES (1, 0, 0)`);
    db.close();
  }
  const t0 = performance.now();
  const results = await Promise.all(
    Array.from(
      { length: workers },
      (_, id) =>
        new Promise<{ committed: number; retries: number; errors: Record<string, number> }>((resolve) => {
          const w = new Worker(new URL("./concurrency.worker.ts", import.meta.url).href);
          w.onmessage = (e) => (resolve(e.data), w.terminate());
          w.onerror = (e) => resolve({ committed: 0, retries: 0, errors: { [`worker crashed: ${e.message}`.slice(0, 90)]: 1 } });
          w.postMessage({ driver, path, id, rows, hot });
        }),
    ),
  );
  const ms = performance.now() - t0;
  const total = workers * rows;
  const committed = results.reduce((a, r) => a + r.committed, 0);
  const retries = results.reduce((a, r) => a + r.retries, 0);
  console.log(
    `${LABEL[driver].padEnd(34)} ${committed}/${total} committed, ${total - committed} failed (${(((total - committed) / total) * 100).toFixed(1)}%), ` +
      `${retries} conflict retries, ${ms.toFixed(0)} ms, ${(committed / (ms / 1000)).toFixed(0)} commits/s`,
  );
  const errors: Record<string, number> = {};
  for (const r of results) for (const [k, v] of Object.entries(r.errors)) errors[k] = (errors[k] ?? 0) + v;
  for (const [k, v] of Object.entries(errors)) console.log(`      ${v}x  ${k}`);
}

console.log(`${workers} Bun Workers x ${rows} single-row write transactions each, one database file (${hot ? "all updating one row" : "inserting"})`);
for (const d of ["bun-nobusy", "bun-busy", "turso"] as const) await trial(d);
rmSync(dir, { recursive: true, force: true });
