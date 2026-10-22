import { startServer, type RunningServer } from "@archlast-forge/runtime/server";
import { anyApi } from "@archlast-forge/runtime";
import { QueryClient } from "@tanstack/query-core";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchlastForgeClient, queryKey, syncQuery, type QueryUpdate } from "../src/index";

const fixture = join(import.meta.dir, "../../runtime/test/fixture");
const api = anyApi;
const dataDir = mkdtempSync(join(tmpdir(), "afx-client-"));
let srv: RunningServer;
let client: ArchlastForgeClient;

const boot = (port = "0") => startServer({ convexDir: fixture, dev: true, env: { ...process.env, PORT: port, DATA_DIR: dataDir, ADMIN_KEY: "k" } });

beforeAll(async () => {
  srv = await boot();
  client = new ArchlastForgeClient({ url: srv.url });
});
afterAll(async () => {
  client.close();
  await srv.stop();
});

const until = async (cond: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(10)) if (Date.now() > end) throw new Error("timed out");
};

test("query, mutation and action", async () => {
  const listId = await client.mutation(api.todos.createList, { name: "a" });
  const todo = await client.action(api.todos.addViaAction, { listId, title: "x" });
  expect(todo).toMatchObject({ title: "x" });
  expect(await client.query(api.todos.listByList, { listId })).toHaveLength(1);
  await expect(client.mutation(api.todos.add, { listId, title: 3 })).rejects.toThrow("args.title must be a string");
});

test("watch pushes changes; identical watches share one subscription", async () => {
  const listId = await client.mutation(api.todos.createList, { name: "live" });
  const a: QueryUpdate[] = [];
  const b: QueryUpdate[] = [];
  const offA = client.watch(api.todos.openCount, { listId }, (u) => a.push(u));
  const offB = client.watch(api.todos.openCount, { listId }, (u) => b.push(u));
  await until(() => a.length === 1 && b.length === 1);
  expect(a[0]).toEqual({ value: 0 });
  const id = await client.mutation(api.todos.add, { listId, title: "t" });
  await until(() => a.at(-1)?.["value" as never] === 1);
  await client.mutation(api.todos.toggle, { id });
  await until(() => b.at(-1)?.["value" as never] === 0);
  const subs = (await (await fetch(`${srv.url}/_admin/subscriptions`, { headers: { "x-admin-key": "k" } })).json()) as any;
  expect(subs.result.data.filter((s: any) => s.name === "todos:openCount")).toHaveLength(1);
  offA();
  offB();
});

test("syncQuery feeds a TanStack QueryClient", async () => {
  const qc = new QueryClient();
  const listId = await client.mutation(api.todos.createList, { name: "tanstack" });
  const off = syncQuery(qc, client, api.todos.listByList, { listId });
  await until(() => Array.isArray(qc.getQueryData(queryKey(api.todos.listByList, { listId }))));
  await client.mutation(api.todos.add, { listId, title: "q" });
  await until(() => (qc.getQueryData(queryKey(api.todos.listByList, { listId })) as unknown[]).length === 1);
  off();
});

test("after the server restarts, the client reconnects and refetches", async () => {
  const listId = await client.mutation(api.todos.createList, { name: "reconnect" });
  const updates: QueryUpdate[] = [];
  const off = client.watch(api.todos.listByList, { listId }, (u) => updates.push(u));
  await until(() => updates.length === 1);
  const port = new URL(srv.url).port;
  await srv.stop();
  srv = await boot(port);
  // Written while this client was disconnected, through another client.
  const other = new ArchlastForgeClient({ url: srv.url });
  await other.mutation(api.todos.add, { listId, title: "missed" });
  other.close();
  await until(() => JSON.stringify(updates.at(-1)).includes("missed"), 10_000);
  off();
});

const pg = process.env.TEST_POSTGRES_URL;
const redis = process.env.TEST_REDIS_URL;
test.skipIf(!pg || !redis)("two servers: a mutation on one reaches subscribers on the other, and caches invalidate", async () => {
  const env = { ...process.env, PORT: "0", DATABASE_URL: pg, REDIS_URL: redis, REPLICAS: "2", BETTER_AUTH_SECRET: "x".repeat(32), CACHE_TTL_MS: "60000" };
  const [s1, s2] = [await startServer({ convexDir: fixture, env }), await startServer({ convexDir: fixture, env })];
  const [c1, c2] = [new ArchlastForgeClient({ url: s1.url }), new ArchlastForgeClient({ url: s2.url })];
  try {
    const listId = await c1.mutation(api.todos.createList, { name: "cluster" });
    expect(await c1.query(api.todos.listByList, { listId })).toEqual([]); // now cached on s1 (shared Redis cache)
    const updates: QueryUpdate[] = [];
    const off = c1.watch(api.todos.listByList, { listId }, (u) => updates.push(u));
    await until(() => updates.length === 1);
    await c2.mutation(api.todos.add, { listId, title: "from s2" });
    await until(() => JSON.stringify(updates.at(-1)).includes("from s2"));
    expect(await c1.query(api.todos.listByList, { listId })).toHaveLength(1);
    off();
  } finally {
    c1.close();
    c2.close();
    await s1.stop();
    await s2.stop();
  }
});
