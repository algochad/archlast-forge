// Per-call latency and throughput of Forge RPC against Nest's TCP (and Redis, with BENCH_REDIS_URL) transports, at the same concurrency,
// with a small payload and a 64 KB one. One engine (production, functions inline) serves the same echo on every transport; the clients
// send through Nest's ClientProxy for all of them.
// bun benchmarks/forge-rpc/bench.ts            (from the repo root; BENCH_REDIS_URL=redis://127.0.0.1:6379 adds Redis)
import { startServer } from "../../packages/runtime/src/server/server";
import { rxjs } from "../../packages/runtime/src/nest";
import { ClientProxyFactory, Transport, type ClientProxy } from "../../packages/runtime/src/nest-microservices";
import { ForgeRpcClient } from "../../packages/runtime/src/nest-rpc";
import { mkdtempSync } from "node:fs";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";

const CONCURRENCY = 64;
const SECONDS = 5;
const TOKEN = "bench-token-".padEnd(32, "x");
const freePort = async () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  await s.stop(true);
  return port;
};
const [tcpPort, rpcPort] = [await freePort(), await freePort()];
const redisUrl = process.env.BENCH_REDIS_URL;
// Functions run inline in this process, so forge/http.ts reads this process's environment.
Object.assign(process.env, { BENCH_TCP_PORT: String(tcpPort), BENCH_RPC_PORT: String(rpcPort), FORGE_RPC_TOKEN: TOKEN });

const server = await startServer({
  forgeDir: join(import.meta.dir, "forge"),
  env: {
    ...process.env,
    PORT: "0",
    DATA_DIR: mkdtempSync(join(tmpdir(), "afx-rpc-bench-")),
    BETTER_AUTH_SECRET: "x".repeat(32),
    BETTER_AUTH_URL: "http://localhost",
    ALLOW_INSECURE_HTTP: "1",
    LOG_LEVEL: "warn",
  },
});

const transports: [string, ClientProxy, string][] = [
  ["TCP", ClientProxyFactory.create({ transport: Transport.TCP, options: { host: "127.0.0.1", port: tcpPort } }), "echo.back"],
  ["Forge RPC", new ForgeRpcClient({ url: `http://127.0.0.1:${rpcPort}`, token: TOKEN, timeoutMs: 30_000 }), "echo.back"],
];
if (redisUrl) {
  const u = new URL(redisUrl);
  transports.push(["Redis", ClientProxyFactory.create({ transport: Transport.REDIS, options: { host: u.hostname, port: Number(u.port || 6379) } }), "echo.back"]);
}

/** CONCURRENCY callers back to back for SECONDS: calls a second, and latency percentiles. */
async function load(client: ClientProxy, pattern: string, blob: string) {
  for (let i = 0; i < 200; i++) await rxjs.lastValueFrom(client.send(pattern, { blob }));
  const times: number[] = [];
  const end = performance.now() + SECONDS * 1000;
  await Promise.all(
    Array.from({ length: CONCURRENCY }, async () => {
      while (performance.now() < end) {
        const t = performance.now();
        const r = (await rxjs.lastValueFrom(client.send(pattern, { blob }))) as { n: number };
        if (r.n !== blob.length) throw new Error("wrong answer");
        times.push(performance.now() - t);
      }
    }),
  );
  times.sort((a, b) => a - b);
  const at = (q: number) => times[Math.min(times.length - 1, Math.floor(q * times.length))]!.toFixed(2);
  return { "calls/s": Math.round(times.length / SECONDS), "p50 ms": at(0.5), "p99 ms": at(0.99) };
}

const rows: Record<string, unknown>[] = [];
for (const [label, blob] of [
  ["small (16 B)", "x".repeat(16)],
  ["64 KB", "x".repeat(64 * 1024)],
] as const)
  for (const [name, client, pattern] of transports) {
    await client.connect();
    rows.push({ payload: label, transport: name, ...(await load(client, pattern, blob)) });
  }
console.log(`${cpus().length} × ${cpus()[0]?.model}, Bun ${Bun.version}, ${CONCURRENCY} concurrent callers, ${SECONDS} s each`);
console.table(rows);
for (const [, client] of transports) await client.close();
await server.stop({ graceful: false });
process.exit(0);
