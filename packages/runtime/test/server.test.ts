import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
let srv: RunningServer;

beforeAll(async () => {
  srv = await startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret" } });
});
afterAll(() => srv.stop());

async function trpc(path: string, input: unknown, opts: { mutation?: boolean; headers?: Record<string, string> } = {}) {
  const res = opts.mutation
    ? await fetch(`${srv.url}/trpc/${path}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json", ...opts.headers } })
    : await fetch(`${srv.url}/trpc/${path}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: opts.headers });
  const body = (await res.json()) as any;
  if (body.error) throw new Error(body.error.message);
  return body.result.data;
}

function subscribe(path: string, input: unknown) {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/trpc`);
  const updates: any[] = [];
  const opened = new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.result?.type === "data") updates.push(msg.result.data);
  });
  opened.then(() => ws.send(JSON.stringify({ id: 1, method: "subscription", params: { path: `_sub.${path}`, input } })));
  return { updates, close: () => ws.close() };
}

const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(10)) if (Date.now() > end) throw new Error("timed out");
};

test("HTTP queries and mutations", async () => {
  const listId = await trpc("todos.createList", { name: "home" }, { mutation: true });
  await trpc("todos.add", { listId, title: "milk" }, { mutation: true });
  expect(await trpc("todos.listByList", { listId })).toMatchObject([{ title: "milk" }]);
  await expect(trpc("todos.add", { listId, title: 5 }, { mutation: true })).rejects.toThrow("args.title must be a string");
});

test("a mutation updates a subscribed query; an unrelated one doesn't push", async () => {
  const listId = await trpc("todos.createList", { name: "reactive" }, { mutation: true });
  const other = await trpc("todos.createList", { name: "other" }, { mutation: true });
  const sub = subscribe("todos.listByList", { listId });
  await until(() => sub.updates.length === 1);
  expect(sub.updates[0]).toEqual({ value: [] });
  await trpc("todos.add", { listId, title: "eggs" }, { mutation: true });
  await until(() => sub.updates.length === 2);
  expect(sub.updates[1].value).toMatchObject([{ title: "eggs" }]);
  await trpc("todos.add", { listId: other, title: "noise" }, { mutation: true });
  await Bun.sleep(200);
  expect(sub.updates.length).toBe(2);
  sub.close();
});

test("restarting the function runtime keeps sockets and re-runs subscriptions", async () => {
  const listId = await trpc("todos.createList", { name: "restart" }, { mutation: true });
  const sub = subscribe("todos.openCount", { listId });
  await until(() => sub.updates.length === 1);
  await srv.reload();
  await trpc("todos.add", { listId, title: "after restart" }, { mutation: true });
  await until(() => sub.updates.at(-1)?.value === 1);
  sub.close();
});

test("Better Auth sign-up sets a session that ctx.auth resolves", async () => {
  const res = await fetch(`${srv.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ email: "ada@example.com", password: "correct horse battery", name: "Ada" }),
  });
  expect(res.status).toBe(200);
  const cookie = res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  expect(cookie).toContain("session_token");
  const me = await trpc("todos.whoami", {}, { headers: { cookie } });
  expect(me).toMatchObject({ email: "ada@example.com", name: "Ada" });
  expect(me.userId).toMatch(/^users:/);
  expect(await trpc("todos.whoami", {})).toBeNull();
});

test("admin router requires ADMIN_KEY", async () => {
  const denied = await fetch(`${srv.url}/_admin/manifest`);
  expect(denied.status).toBe(401);
  const ok = (await (await fetch(`${srv.url}/_admin/manifest`, { headers: { "x-admin-key": "secret" } })).json()) as any;
  expect(ok.result.data.functions.map((f: any) => f.name)).toContain("todos:add");
});
