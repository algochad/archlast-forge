// Throughput at the same load with 1, 2 and 4 function runtime processes, then a resize under load (counting failed requests).
// bun benchmarks/workers/bench.ts            (from the repo root)
import { startServer } from "../../packages/runtime/src/server/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const forgeDir = join(import.meta.dir, "forge");
const CONCURRENCY = 16;
const SECONDS = 6;
const WORK_MS = 4;
const env = (extra: Record<string, string>) => ({
  ...process.env,
  PORT: "0",
  DATA_DIR: mkdtempSync(join(tmpdir(), "afx-workers-bench-")),
  BETTER_AUTH_SECRET: "x".repeat(32),
  BETTER_AUTH_URL: "http://localhost",
  ALLOW_INSECURE_HTTP: "1",
  ADMIN_KEY: "secret-bench-admin-key",
  DASHBOARD: "on",
  CACHE_TTL_MS: "0",
  RATE_LIMIT_PER_MINUTE: "0",
  MAX_CONNECTIONS_PER_IP: "0",
  ...extra,
});

/** CONCURRENCY clients calling back to back for `seconds`: completed calls per second, and failures. */
async function load(url: string, seconds: number, during?: () => Promise<void>) {
  let ok = 0;
  let failed = 0;
  let seq = 0;
  const end = Date.now() + seconds * 1000;
  const client = async () => {
    while (Date.now() < end) {
      const r = await fetch(`${url}/rpc/work:compute?args=${encodeURIComponent(JSON.stringify({ ms: WORK_MS, seq: seq++ }))}`).catch(() => null);
      if (r?.status === 200) ok++;
      else failed++;
      await r?.arrayBuffer();
    }
  };
  await Promise.all([...Array.from({ length: CONCURRENCY }, client), during?.()]);
  return { perSecond: Math.round(ok / seconds), failed };
}

const admin = { "x-admin-key": "secret-bench-admin-key", "x-forge-admin": "1", "content-type": "application/json" };
const resize = (url: string, n: number | null) =>
  fetch(`${url}/_admin/saveSetting`, { method: "POST", headers: admin, body: JSON.stringify({ name: "RUNTIME_WORKERS", value: n === null ? null : String(n) }) }).then((r) => r.json());

for (const [label, extra] of [
  ["1 (inline)", {}],
  ["1 (process)", { RUNTIME_MODE: "process" }],
  ["2", { RUNTIME_WORKERS: "2" }],
  ["4", { RUNTIME_WORKERS: "4" }],
] as const) {
  const srv = await startServer({ forgeDir, env: env(extra) });
  await load(srv.url, 1); // warm up
  const r = await load(srv.url, SECONDS);
  console.log(`workers ${label.padEnd(12)} ${String(r.perSecond).padStart(6)} calls/s   ${r.failed} failed`);
  await srv.stop({ graceful: false });
}

// Resize under load: process mode, 1 -> 3 -> 1 while 16 clients keep calling.
const srv = await startServer({ forgeDir, env: env({ RUNTIME_MODE: "process" }) });
await load(srv.url, 1);
const r = await load(srv.url, 12, async () => {
  await Bun.sleep(3000);
  console.log(`  resize to 3: ${JSON.stringify(await resize(srv.url, 3))}`);
  await Bun.sleep(4000);
  console.log(`  resize to 1: ${JSON.stringify(await resize(srv.url, null))}`);
});
console.log(`resize 1 -> 3 -> 1 under load: ${r.perSecond} calls/s on average, ${r.failed} failed`);
await srv.stop({ graceful: false });
process.exit(0);
