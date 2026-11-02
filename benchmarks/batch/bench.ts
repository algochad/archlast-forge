// N single writes against one batch of N, through the engine (HTTP mutations, SQLite).
// bun benchmarks/batch/bench.ts            (from the repo root)
import { startServer } from "../../packages/runtime/src/server/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const N = Number(process.argv[2] ?? 1000);
const srv = await startServer({
  forgeDir: join(import.meta.dir, "forge"),
  env: { ...process.env, PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "afx-batch-bench-")), BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "http://localhost", ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "0" },
});
const call = async (name: string, args: unknown) => {
  const r = await fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const body = (await r.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
};
const time = async <T>(fn: () => Promise<T>) => {
  const t = performance.now();
  const value = await fn();
  return { ms: performance.now() - t, value };
};
const report = (label: string, ms: number, latency: string) => console.log(`${label.padEnd(44)} ${String(Math.round((N / ms) * 1000)).padStart(8)} rows/s   ${latency}`);

await call("items:insertOne", { n: -1 }); // warm up
let next = 0;

// N calls one after another: each waits for the last, so the latency is one call's.
const lat: number[] = [];
const seq = await time(async () => {
  for (let i = 0; i < N; i++) {
    const t = performance.now();
    await call("items:insertOne", { n: next++ });
    lat.push(performance.now() - t);
  }
});
lat.sort((a, b) => a - b);
report(`${N} single inserts, one at a time`, seq.ms, `p50 ${lat[Math.floor(N / 2)]!.toFixed(2)} ms, p99 ${lat[Math.floor(N * 0.99)]!.toFixed(2)} ms a call`);

// N calls 32 at a time: group commit joins their transactions.
const conc = await time(() => Promise.all(Array.from({ length: 32 }, async (_, w) => { for (let i = w; i < N; i += 32) await call("items:insertOne", { n: next + i }); })));
next += N;
report(`${N} single inserts, 32 at a time`, conc.ms, `${(conc.ms / 1000).toFixed(2)} s in all`);

// In one mutation: a loop of N, against one call for N. Seven rounds, alternating; the first two warm up, the median of the rest is shown.
const rounds: Record<string, number[]> = { insertLoop: [], insertMany: [], patchLoop: [], updateMany: [] };
for (let r = 0; r < 7; r++) {
  rounds.insertLoop!.push((await time(() => call("items:insertLoop", { from: next, count: N }))).ms);
  next += N;
  const b = await time(() => call("items:insertBatch", { from: next, count: N }));
  next += N;
  rounds.insertMany!.push(b.ms);
  const ids = b.value as string[];
  rounds.patchLoop!.push((await time(() => call("items:updateLoop", { ids }))).ms);
  rounds.updateMany!.push((await time(() => call("items:updateBatch", { ids }))).ms);
}
const median = (xs: number[]) => xs.slice(2).sort((a, b) => a - b)[2]!;
for (const [label, key] of [
  [`1 mutation inserting ${N} in a loop`, "insertLoop"],
  [`1 mutation with insertMany(${N})`, "insertMany"],
  [`1 mutation patching ${N} in a loop`, "patchLoop"],
  [`1 mutation with updateMany(${N})`, "updateMany"],
] as const)
  report(label, median(rounds[key]!), `${median(rounds[key]!).toFixed(1)} ms for the call (median of 5)`);

await srv.stop({ graceful: false });
process.exit(0);
