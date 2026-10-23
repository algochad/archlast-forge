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

async function rpc(path: string, input: unknown, opts: { mutation?: boolean; headers?: Record<string, string> } = {}) {
  const res = opts.mutation
    ? await fetch(`${srv.url}/rpc/${path}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json", ...opts.headers } })
    : await fetch(`${srv.url}/rpc/${path}?args=${encodeURIComponent(JSON.stringify(input))}`, { headers: opts.headers });
  const body = (await res.json()) as any;
  if (body.error) throw new Error(body.error.message);
  return body.result;
}

function subscribe(name: string, args: unknown) {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
  const updates: any[] = [];
  const opened = new Promise((r) => ws.addEventListener("open", r));
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "data") updates.push(msg.data);
  });
  opened.then(() => ws.send(JSON.stringify({ type: "subscribe", id: "1", name, args })));
  return { updates, close: () => ws.close() };
}

const until = async (cond: () => boolean, ms = 3000) => {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(10)) if (Date.now() > end) throw new Error("timed out");
};

test("HTTP queries and mutations", async () => {
  const listId = await rpc("todos:createList", { name: "home" }, { mutation: true });
  await rpc("todos:add", { listId, title: "milk" }, { mutation: true });
  expect(await rpc("todos:listByList", { listId })).toMatchObject([{ title: "milk" }]);
  await expect(rpc("todos:add", { listId, title: 5 }, { mutation: true })).rejects.toThrow("args.title must be a string");
});

test("a mutation updates a subscribed query; an unrelated one doesn't push", async () => {
  const listId = await rpc("todos:createList", { name: "reactive" }, { mutation: true });
  const other = await rpc("todos:createList", { name: "other" }, { mutation: true });
  const sub = subscribe("todos:listByList", { listId });
  await until(() => sub.updates.length === 1);
  expect(sub.updates[0]).toEqual({ value: [] });
  await rpc("todos:add", { listId, title: "eggs" }, { mutation: true });
  await until(() => sub.updates.length === 2);
  expect(sub.updates[1].value).toMatchObject([{ title: "eggs" }]);
  await rpc("todos:add", { listId: other, title: "noise" }, { mutation: true });
  await Bun.sleep(200);
  expect(sub.updates.length).toBe(2);
  sub.close();
});

test("the wire protocol refuses what it should, with an error body and the matching status", async () => {
  const call = (name: string, init: RequestInit = {}) => fetch(`${srv.url}/rpc/${name}`, init);
  const json = { "content-type": "application/json" };
  const unknown = await call("todos:nope", { method: "POST", headers: json, body: "{}" });
  expect(unknown.status).toBe(404);
  expect(((await unknown.json()) as any).error).toMatchObject({ code: "NOT_FOUND", message: 'No function "todos:nope"' });
  expect((await call("todos:createList?args=%7B%7D")).status).toBe(405); // a mutation can't be a GET
  expect((await call("todos:createList", { method: "POST", headers: { "content-type": "text/plain" }, body: "{}" })).status).toBe(415);
  const bad = await call("todos:createList", { method: "POST", headers: json, body: "{not json" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).error.requestId).toBeTruthy();
  expect((await call("todos:secretCount", { method: "POST", headers: json, body: "{}" })).status).toBe(404); // internal
});

test("sockets report refused subscriptions, stop on unsubscribe, and drop malformed messages", async () => {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
  const got: any[] = [];
  let closed: number | undefined;
  ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
  ws.addEventListener("close", (e) => (closed = e.code));
  await new Promise((r) => ws.addEventListener("open", r));
  const send = (m: object) => ws.send(JSON.stringify(m));
  send({ type: "subscribe", id: "a", name: "todos:createList", args: {} }); // a mutation isn't subscribable
  await until(() => got.length === 1);
  expect(got[0]).toMatchObject({ type: "error", id: "a", error: { code: "NOT_FOUND" } });

  const listId = await rpc("todos:createList", { name: "unsub" }, { mutation: true });
  send({ type: "subscribe", id: "b", name: "todos:listByList", args: { listId } });
  await until(() => got.length === 2);
  expect(got[1]).toEqual({ type: "data", id: "b", data: { value: [] } });
  send({ type: "unsubscribe", id: "b" });
  await Bun.sleep(50);
  await rpc("todos:add", { listId, title: "unseen" }, { mutation: true });
  await Bun.sleep(200);
  expect(got).toHaveLength(2);

  ws.send("not json");
  await until(() => closed !== undefined);
  expect(closed).toBe(1003);
});

test("restarting the function runtime keeps sockets and re-runs subscriptions", async () => {
  const listId = await rpc("todos:createList", { name: "restart" }, { mutation: true });
  const sub = subscribe("todos:openCount", { listId });
  await until(() => sub.updates.length === 1);
  await srv.reload();
  await rpc("todos:add", { listId, title: "after restart" }, { mutation: true });
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
  const me = await rpc("todos:whoami", {}, { headers: { cookie } });
  expect(me).toMatchObject({ email: "ada@example.com", name: "Ada" });
  expect(me.userId).toMatch(/^users:/);
  expect(await rpc("todos:whoami", {})).toBeNull();
});

test("admin router requires ADMIN_KEY", async () => {
  const denied = await fetch(`${srv.url}/_admin/manifest`);
  expect(denied.status).toBe(401);
  const ok = (await (await fetch(`${srv.url}/_admin/manifest`, { headers: { "x-admin-key": "secret" } })).json()) as any;
  expect(ok.functions.map((f: any) => f.name)).toContain("todos:add");
});

const cli = (cmd: string, args: Record<string, unknown> = {}, key: string | null = "secret") =>
  fetch(`${srv.url}/_cli`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { "x-admin-key": key } : {}) }, body: JSON.stringify({ cmd, args }) });

test("CLI commands reach the database through the running server", async () => {
  expect((await cli("admin.list", {}, null)).status).toBe(401);
  expect((await cli("admin.list", {}, "wrong")).status).toBe(401);
  expect((await cli("admin.add", { email: "Ops@Example.com", password: "a-long-password!", role: "viewer" })).status).toBe(200);
  expect(((await (await cli("admin.list")).json()) as any).result).toMatchObject([{ email: "ops@example.com", role: "viewer" }]);
  await cli("env.set", { name: "GREETING", value: "hi" });
  expect(((await (await cli("env.list")).json()) as any).result).toMatchObject([{ name: "GREETING", value: "hi" }]);
  const bad = await cli("env.set", { name: "not valid", value: "x" });
  expect(bad.status).toBe(400);
  expect(((await bad.json()) as any).message).toContain("Invalid variable name");
  expect((await cli("nope")).status).toBe(400);
  // Audited without the password or value.
  const audit = (await (await fetch(`${srv.url}/_admin/audit?input=${encodeURIComponent(JSON.stringify({}))}`, { headers: { "x-admin-key": "secret" } })).json()) as any;
  const rows = JSON.stringify(audit);
  expect(rows).toContain("admin.add");
  expect(rows).not.toContain("a-long-password!");
  expect(rows).not.toContain('"hi"');
});
