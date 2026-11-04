// The engine in production mode on the test fixture, for load tests. Settings come from the environment (RUNTIME_WORKERS,
// CACHE_TTL_MS, DATABASE_URL, REDIS_URL, REPLICAS…). Writes the seeded list ids to LIST_FILE; on SIGTERM prints the server loop's delay.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { startServer } from "../../packages/runtime/src/server/server";

const srv = await startServer({
  forgeDir: join(import.meta.dir, "../../packages/runtime/test/fixture"),
  env: {
    ...process.env,
    PORT: process.env.PORT ?? "3100",
    DATA_DIR: process.env.DATA_DIR ?? mkdtempSync(join(tmpdir(), "afx-bench-")),
    BETTER_AUTH_SECRET: "s".repeat(32),
    ALLOW_INSECURE_HTTP: "1",
    RATE_LIMIT_PER_MINUTE: process.env.RATE_LIMIT_PER_MINUTE ?? "0",
    LOG_FORMAT: "json",
    SCHEMA_CHECK: "off",
    ADMIN_KEY: "bench-admin-key-0123456789abcdef0123",
    DASHBOARD: "on",
  },
});
if (!process.env.NO_SEED) {
  const call = async (name: string, args: object) =>
    ((await (await fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) })).json()) as any).result;
  // SEED_LISTS lists of 20 todos; LIST_FILE gets their ids, one a line (the first is the one every case uses).
  const lists: string[] = [];
  const todos: string[] = [];
  for (let l = 0; l < Number(process.env.SEED_LISTS ?? 1); l++) {
    const list = await call("todos:createList", { name: `bench ${l}` });
    for (let i = 0; i < 20; i++) todos.push(await call("todos:add", { listId: list, title: `todo ${i}` }));
    lists.push(list);
  }
  await Bun.write(process.env.LIST_FILE!, lists.join("\n"));
  await Bun.write(process.env.LIST_FILE! + ".todos", todos.join("\n")); // for the patch case
}
const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
console.log("READY", srv.url);
process.on("SIGUSR2", () => loop.reset()); // the runner resets after warm-up
process.on("SIGTERM", async () => {
  const ms = (n: number) => +(n / 1e6).toFixed(2);
  console.log(`LOOP ${JSON.stringify({ p50: ms(loop.percentile(50)), p99: ms(loop.percentile(99)), max: ms(loop.max) })}`);
  await srv.stop({ graceful: false });
  process.exit(0);
});
