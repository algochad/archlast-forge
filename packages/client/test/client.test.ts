import { startServer, type RunningServer } from "@archlast/forge-runtime/server";
import { anyApi } from "@archlast/forge-runtime";
import { QueryClient } from "@tanstack/query-core";
import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ArchlastForgeClient, pageArgs, queryKey, syncQuery, windowArgs, type QueryUpdate } from "../src/index";

const fixture = join(import.meta.dir, "../../runtime/test/fixture");
const api = anyApi;
const dataDir = mkdtempSync(join(tmpdir(), "afx-client-"));
let srv: RunningServer;
let client: ArchlastForgeClient;

const boot = (port = "0") => startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: port, DATA_DIR: dataDir, ADMIN_KEY: "k" } });

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
  expect(subs.filter((s: any) => s.name === "todos:openCount")).toHaveLength(1);
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
}, 15_000);

const pg = process.env.TEST_POSTGRES_URL;
const redis = process.env.TEST_REDIS_URL;
test.skipIf(!pg || !redis)("two servers: a mutation on one reaches subscribers on the other, and caches invalidate", async () => {
  const env = { ...process.env, PORT: "0", DATABASE_URL: pg, REDIS_URL: redis, REPLICAS: "2", OTEL_SERVICE_NAME: "orders", BETTER_AUTH_SECRET: "x".repeat(32), CACHE_TTL_MS: "60000", ALLOW_INSECURE_HTTP: "1" };
  const [s1, s2] = [await startServer({ forgeDir: fixture, env }), await startServer({ forgeDir: fixture, env })];
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

test("a rate-limited call says so, and how long to wait", async () => {
  const limited = await startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "afx-client-")), ADMIN_KEY: "k", RATE_LIMIT_PER_MINUTE: "2" } });
  const c = new ArchlastForgeClient({ url: limited.url });
  try {
    await c.query(api.todos.events);
    await c.query(api.todos.events);
    const err = (await c.query(api.todos.events).catch((e) => e)) as Error & { code?: string; retryAfter?: number };
    expect(err.message).toBe("Too many requests");
    expect(err.code).toBe("TOO_MANY_REQUESTS");
    expect(err.retryAfter).toBeGreaterThan(0);
  } finally {
    c.close();
    await limited.stop({ graceful: false });
  }
});

test("pageArgs asks for numbered page N with its total; windowArgs for the first n of a growing list", () => {
  expect(pageArgs({ listId: "lists:1" }, 3, 20)).toEqual({ listId: "lists:1", paginationOpts: { numItems: 20, cursor: null, offset: 40, withTotal: true } });
  expect(windowArgs({}, 30)).toEqual({ paginationOpts: { numItems: 30, cursor: null } });
  expect(() => pageArgs({}, 0, 20)).toThrow("page must be an integer from 1, got 0");
});

test("a client without browser cookies (React Native) signs its calls and its socket with headers, and live updates arrive", async () => {
  const res = await fetch(`${srv.url}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: "native@example.com", password: "native password 1", name: "Native" }) });
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  let asked = 0;
  // React Native's WebSocket takes handshake headers as a third argument; Bun's takes them in an options object.
  class NativeStyleWebSocket extends WebSocket {
    constructor(url: string, _protocols?: string | string[], options?: { headers?: Record<string, string> }) {
      super(url, { headers: options?.headers } as never);
    }
  }
  const native = new ArchlastForgeClient({ url: srv.url, WebSocket: NativeStyleWebSocket as never, headers: async () => (asked++, { cookie }) });
  try {
    expect(await native.query(api.todos.whoami)).toMatchObject({ email: "native@example.com" }); // the call carried the session
    const seen: unknown[] = [];
    const stop = native.watch(api.todos.whoami, {}, (u) => "value" in u && seen.push(u.value));
    await until(() => seen.length > 0);
    expect(seen[0]).toMatchObject({ email: "native@example.com" }); // so did the socket's handshake
    stop();
    const events: unknown[][] = [];
    const off = native.watch(api.todos.events, {}, (u) => "value" in u && events.push(u.value as unknown[]));
    await until(() => events.length > 0);
    await native.mutation(api.todos.logEvent, { kind: "from a phone" });
    // The live update arrives, with the event this call wrote. Not "one more than before": the table is shared with the other tests of this
    // file, so something else may write in the same moment, and the count would skip the value the test waits for.
    await until(() => (events.at(-1) as { kind: string }[]).some((e) => e.kind === "from a phone"));
    off();
    expect(asked).toBeGreaterThanOrEqual(3); // asked each time: every call, and the socket
  } finally {
    native.close();
  }
}, 15_000); // a sign-up (password hashing), two live subscriptions and their updates: past 5 s on a busy CI runner

test.skipIf(!redis)("two apps on one Redis: each app's cache and subscriptions are its own", async () => {
  // Two different backends that happen to have a function of the same name (`todos:listCounts`) and a table of the same name (`lists`), as
  // the services of a monorepo can. Each has its own database and its own service name; they share one Redis.
  const app = (service: string) =>
    startServer({
      forgeDir: fixture,
      dev: true,
      env: { ...process.env, PORT: "0", DATA_DIR: mkdtempSync(join(tmpdir(), "afx-app-")), ADMIN_KEY: "k", REDIS_URL: redis, OTEL_SERVICE_NAME: service, BETTER_AUTH_SECRET: "s".repeat(32), CACHE_TTL_MS: "60000" },
    });
  const run = crypto.randomUUID().slice(0, 8); // names of its own, so other tests on this Redis (or an earlier run) share nothing with it
  const [orders, billing] = [await app(`orders-${run}`), await app(`billing-${run}`)];
  const [co, cb] = [new ArchlastForgeClient({ url: orders.url }), new ArchlastForgeClient({ url: billing.url })];
  const names = async (c: ArchlastForgeClient) => ((await c.query(api.todos.listCounts, {})) as { name: string }[]).map((l) => l.name);
  try {
    await co.mutation(api.todos.createList, { name: "orders list" });
    expect(await names(co)).toEqual(["orders list"]); // cached in Redis now
    // Billing asks the same function with the same arguments: its own (empty) answer, not orders' cached one.
    expect(await names(cb)).toEqual([]);
    // And a write in billing doesn't re-run or invalidate orders' subscription or cache.
    const updates: QueryUpdate[] = [];
    const off = co.watch(api.todos.listCounts, {}, (u) => updates.push(u));
    await until(() => updates.length === 1);
    await cb.mutation(api.todos.createList, { name: "billing list" });
    await Bun.sleep(300);
    expect(updates).toHaveLength(1);
    expect(JSON.stringify(updates.at(-1))).not.toContain("billing list");
    expect(await names(co)).toEqual(["orders list"]);
    off();
  } finally {
    co.close();
    cb.close();
    await orders.stop();
    await billing.stop();
  }
}, 20_000);
