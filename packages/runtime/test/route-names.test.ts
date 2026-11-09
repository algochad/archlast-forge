import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

// A request is counted under the route that answered it (`GET /users/:name`), whether or not its trace was kept. Most requests under load are not traced, and they are
// named without a span to annotate: by what the Nest adapter leaves on the call, or by the exact path of the route.
const ADMIN = "k".repeat(32);
let srv: RunningServer;

beforeAll(async () => {
  srv = await startServer({
    forgeDir: join(import.meta.dir, "fixture-route-names"),
    dev: true,
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", LOG_FORMAT: "json", LOG_LEVEL: "error", RATE_LIMIT_PER_MINUTE: "0", TELEMETRY_DETAIL_PER_SECOND: "1", ADMIN_KEY: ADMIN },
  });
}, 30_000);
afterAll(() => srv?.stop({ graceful: false }));

const hit = (path: string) => fetch(`${srv.url}/http${path}`).then((r) => r.text());
const operations = async () => {
  const r = await fetch(`${srv.url}/_admin/obs.requests?input=${encodeURIComponent(JSON.stringify({ from: Date.now() - 3600_000, to: Date.now() + 60_000 }))}`, { headers: { "x-admin-key": ADMIN } });
  return ((await r.json()) as any).operations.filter((o: any) => o.kind === "http") as { operation: string; count: number }[];
};

test("requests are named by their route, traced or not", async () => {
  // two bursts in two seconds: with one detailed request a second, nearly all of the second burst have no trace
  for (let round = 0; round < 2; round++) {
    await Promise.all(Array.from({ length: 150 }, (_, i) => hit(i % 3 === 0 ? `/users/${["alice", "bob", "carol"][i % 9 % 3]}` : i % 3 === 1 ? `/orders/${1000 + i}` : "/ping")));
    if (round === 0) await Bun.sleep(1100);
  }
  const count = (ops: { operation: string; count: number }[], name: string) => ops.filter((o) => o.operation === name).reduce((a, o) => a + o.count, 0);
  let ops = await operations();
  for (let i = 0; i < 60 && count(ops, "GET /users/:name") + count(ops, "GET /orders/:id") + count(ops, "GET /ping") < 300; i++) (await Bun.sleep(150), (ops = await operations()));
  expect(count(ops, "GET /users/:name")).toBe(100);
  expect(count(ops, "GET /orders/:id")).toBe(100);
  expect(count(ops, "GET /ping")).toBe(100);
  expect(ops.map((o) => o.operation).filter((n) => /\/users\/(alice|bob|carol)|\/orders\/\d/.test(n))).toEqual([]); // no request named by its own path
}, 30_000);
