import { createSqliteDb } from "/home/algochad/Projects/archlast-forge/packages/runtime/src/server/db/sqlite";
import { rmSync, mkdirSync } from "node:fs";
const dir = process.env.HOME + "/.cache/bench/data/dbsync"; rmSync(dir, { recursive: true, force: true }); mkdirSync(dir, { recursive: true });
for (const mode of ["NORMAL", "FULL"] as const) for (const clients of [1, 64]) {
  const db = createSqliteDb(`${dir}/${mode}${clients}.db`, 4, undefined, mode);
  await db.execute(`CREATE TABLE t (k INTEGER PRIMARY KEY, v TEXT)`);
  let n = 0, stop = false; const lat: number[] = [];
  const c = async (id: number) => { let i = 0; while (!stop) { const t = performance.now(); await db.transaction("write", (tx) => tx.execute(`INSERT INTO t (v) VALUES (?)`, ["x".repeat(60)])); lat.push(performance.now() - t); n++; i++; } };
  const ps = Array.from({ length: clients }, (_, i) => c(i)); await Bun.sleep(500); n = 0; lat.length = 0; const t0 = performance.now(); await Bun.sleep(5000); stop = true; const el = (performance.now() - t0) / 1000; await Promise.all(ps);
  lat.sort((a, b) => a - b);
  console.log(`${mode.padEnd(6)} ${String(clients).padStart(2)} clients: ${Math.round(n / el)} writes/s  p50 ${lat[lat.length >> 1].toFixed(2)} ms  p99 ${lat[Math.floor(lat.length * .99)].toFixed(2)} ms`);
  await db.close();
}
rmSync(dir, { recursive: true, force: true });
