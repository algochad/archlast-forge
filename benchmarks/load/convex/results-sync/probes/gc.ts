// Group-commit shape of sqlite.ts (queue -> setImmediate drain -> one BEGIN/COMMIT per batch), 64 closed-loop clients, insert of ~100 B JSON.
import { Database } from "bun:sqlite";
import { mkdirSync, rmSync } from "node:fs";
const [sync, clients, secs, dir] = [process.argv[2], +process.argv[3], +process.argv[4], process.argv[5]];
mkdirSync(dir, { recursive: true });
const path = `${dir}/gc-${sync}.db`;
for (const s of ["", "-wal", "-shm"]) rmSync(path + s, { force: true });
const db = new Database(path, { create: true });
db.exec("PRAGMA journal_mode = WAL"); db.exec(`PRAGMA synchronous = ${sync}`); db.exec("PRAGMA wal_autocheckpoint = 0");
db.exec("CREATE TABLE t (_id TEXT PRIMARY KEY, _creationTime REAL, doc TEXT)");
const ins = db.prepare("INSERT INTO t VALUES (?,?,?)"), begin = db.prepare("BEGIN IMMEDIATE"), commit = db.prepare("COMMIT");
const q: (() => void)[] = []; let draining = false, commits = 0, n = 0;
const enqueue = () => new Promise<void>((res) => { q.push(res); if (!draining) { draining = true; setImmediate(drain); } });
function drain() {
  while (q.length) {
    const batch = q.splice(0, 256);
    begin.run(); for (const _ of batch) ins.run(crypto.randomUUID(), Date.now(), JSON.stringify({ text: "x".repeat(60), done: false })); commit.run(); commits++;
    for (const r of batch) r();
  }
  draining = false;
}
const lat: number[] = []; let stop = false;
const client = async () => { while (!stop) { const t = performance.now(); await enqueue(); lat.push(performance.now() - t); n++; } };
const ps = Array.from({ length: clients }, client);
await Bun.sleep(1000); n = 0; commits = 0; lat.length = 0; const t0 = performance.now();
await Bun.sleep(secs * 1000); stop = true; const el = (performance.now() - t0) / 1000; await Promise.all(ps);
lat.sort((a, b) => a - b);
console.log(`${sync.padEnd(6)} clients ${clients}: ${Math.round(n / el)} inserts/s, ${Math.round(commits / el)} commits/s, avg batch ${(n / commits).toFixed(1)}, p50 ${lat[lat.length >> 1].toFixed(2)} ms p99 ${lat[Math.floor(lat.length * 0.99)].toFixed(2)} ms`);
