import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { addAdmin } from "../src/server/admin-ops";
import { createSqliteDb } from "../src/server/db/sqlite";
import { startServer, type RunningServer } from "../src/server/server";
import { migrateSystem } from "../src/server/system";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
const dataDir = tempDir();
const prodEnv = (extra: Record<string, string> = {}) => ({
  ...process.env,
  PORT: "0",
  DATA_DIR: dataDir,
  BETTER_AUTH_SECRET: "s".repeat(32),
  ALLOW_INSECURE_HTTP: "1",
  ADMIN_KEY: "root-key",
  DASHBOARD: "on",
  FUNCTION_TIMEOUT_MS: "300",
  MAX_SUBSCRIPTIONS_PER_CONNECTION: "2",
  RATE_LIMIT_PER_MINUTE: "100000",
  LOG_FORMAT: "json",
  ...extra,
});
let srv: RunningServer;

beforeAll(async () => {
  const db = createSqliteDb(join(dataDir, "app.db"));
  await migrateSystem(db);
  await addAdmin(db, "viewer@example.com", "viewer-password-123", "viewer");
  await addAdmin(db, "admin@example.com", "admin-password-123", "admin");
  await db.close();
  srv = await startServer({ forgeDir: fixture, env: prodEnv() });
});
afterAll(() => srv.stop({ graceful: false }));

const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.url}${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
const get = (path: string, input?: unknown, headers: Record<string, string> = {}) =>
  fetch(`${srv.url}${path}${input === undefined ? "" : `?${path.startsWith("/rpc/") ? "args" : "input"}=${encodeURIComponent(JSON.stringify(input))}`}`, { headers });

test("internal functions aren't exposed over HTTP", async () => {
  const res = await get("/rpc/todos:secretCount", {});
  expect(res.status).toBe(404);
});

test("ForgeError data reaches the caller; internal errors don't", async () => {
  const forge = (await (await post("/rpc/todos:forgeFail", {})).json()) as any;
  expect(forge.error.data).toEqual({ code: "LIMIT", max: 3 });

  const res = await get("/rpc/todos:crash", {}, { "x-request-id": "req-123" });
  const body = (await res.json()) as any;
  expect(res.headers.get("x-request-id")).toBe("req-123");
  expect(body.error.message).toBe("Server error (request req-123)");
  expect(JSON.stringify(body)).not.toContain("secret internal detail");
  expect(body.error.stack).toBeUndefined();
});

test("health, readiness and metrics", async () => {
  expect((await get("/health")).status).toBe(200);
  expect(((await (await get("/ready")).json()) as any).ready).toBe(true);
  expect((await get("/metrics")).status).toBe(404);
  const metrics = await (await get("/metrics", undefined, { authorization: "Bearer root-key" })).text();
  expect(metrics).toContain('forge_function_calls_total{function="todos:crash"}');
  expect(metrics).toContain("forge_subscriptions");
});

test("a call that blocks the runtime is killed, and the runtime comes back", async () => {
  const started = Date.now();
  const body = (await (await get("/rpc/todos:spin", { ms: 20_000 })).json()) as any;
  expect(body.error.code).toBe("TIMEOUT");
  expect(Date.now() - started).toBeLessThan(9000);
  for (let i = 0; i < 50 && (await get("/rpc/todos:events", {})).status !== 200; i++) await Bun.sleep(100);
  expect((await get("/rpc/todos:events", {})).status).toBe(200);
}, 15_000);

test("subscriptions per connection are capped", async () => {
  const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
  const errors: string[] = [];
  ws.addEventListener("message", (e) => {
    const msg = JSON.parse(String(e.data));
    if (msg.type === "error") errors.push(msg.error.message);
  });
  await new Promise((r) => ws.addEventListener("open", r));
  for (const id of ["1", "2", "3"]) ws.send(JSON.stringify({ type: "subscribe", id, name: "todos:events", args: {} }));
  for (let i = 0; i < 50 && errors.length === 0; i++) await Bun.sleep(50);
  expect(errors).toContain("At most 2 subscriptions per connection");
  ws.close();
});

test("dashboard sign-in, roles and audit log", async () => {
  const login = (email: string, password: string) => post("/_admin/login", { email, password }, { "x-forge-admin": "1" });
  expect((await login("viewer@example.com", "wrong-password-123")).status).toBe(401);
  const viewer = (await login("viewer@example.com", "viewer-password-123")).headers.get("set-cookie")!.split(";")[0]!;
  const admin = (await login("admin@example.com", "admin-password-123")).headers.get("set-cookie")!.split(";")[0]!;
  const as = (cookie: string) => ({ cookie, "x-forge-admin": "1" });

  expect(((await (await get("/_admin/me", undefined, { cookie: viewer })).json()) as any)).toEqual({ email: "viewer@example.com", role: "viewer" });
  expect((await get("/_admin/docs", { table: "lists" }, { cookie: viewer })).status).toBe(200);
  expect((await post("/_admin/run", { name: "todos:createList", kind: "mutation", args: { name: "x" } }, as(viewer))).status).toBe(403);
  // Without the CSRF header, writes are refused.
  expect((await post("/_admin/run", { name: "todos:createList", kind: "mutation", args: { name: "x" } }, { cookie: admin })).status).toBe(403);
  const ran = (await (await post("/_admin/run", { name: "todos:secretCount", kind: "query", args: {} }, as(admin))).json()) as any;
  expect(typeof ran).toBe("number"); // admins may run internal functions

  const audit = ((await (await get("/_admin/audit", {}, { cookie: viewer })).json()) as any);
  expect(audit[0]).toMatchObject({ actor: "admin@example.com", action: "run", target: "todos:secretCount" });

  await post("/_admin/logout", {}, as(viewer));
  expect((await get("/_admin/docs", { table: "lists" }, { cookie: viewer })).status).toBe(401);
});

test("rate limiting and the dashboard being off by default", async () => {
  const s = await startServer({ forgeDir: fixture, env: prodEnv({ RATE_LIMIT_PER_MINUTE: "3", DASHBOARD: "", DATA_DIR: tempDir() }) });
  try {
    const statuses = [];
    for (let i = 0; i < 5; i++) statuses.push((await fetch(`${s.url}/rpc/todos:events?input=%7B%7D`)).status);
    expect(statuses).toEqual([200, 200, 200, 429, 429]);
    expect((await fetch(`${s.url}/_admin/me`)).status).toBe(404);
  } finally {
    await s.stop({ graceful: false });
  }
});

test("graceful shutdown lets in-flight requests finish", async () => {
  const s = await startServer({ forgeDir: fixture, env: prodEnv({ DATA_DIR: tempDir(), FUNCTION_TIMEOUT_MS: "5000" }) });
  const inFlight = fetch(`${s.url}/rpc/todos:slowQuery?args=${encodeURIComponent('{"ms":500}')}`);
  await Bun.sleep(100);
  const stopping = s.stop();
  expect((await inFlight).status).toBe(200);
  await stopping;
});

test("a signed session cookie resolves the caller directly; a forged, tampered or revoked one doesn't", async () => {
  const signUp = await fetch(`${srv.url}/api/auth/sign-up/email`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: srv.url },
    body: JSON.stringify({ email: "direct@example.com", password: "correct horse battery", name: "Direct" }),
  });
  const cookie = signUp.headers
    .getSetCookie()
    .map((c) => c.split(";")[0])
    .join("; ");
  const whoami = async (c?: string) =>
    ((await (await fetch(`${srv.url}/rpc/todos:whoami`, { method: "POST", headers: { "content-type": "application/json", ...(c ? { cookie: c } : {}) }, body: "{}" })).json()) as any).result;
  expect(await whoami(cookie)).toMatchObject({ email: "direct@example.com", name: "Direct" });
  expect(await whoami()).toBeNull();
  // The signature covers the token: any other value fails, and so does a signature from another secret.
  const [name, value] = cookie.split("; ").find((c) => c.includes("session_token"))!.split(/=(.*)/s);
  const token = decodeURIComponent(value!).split(".")[0]!;
  expect(await whoami(`${name}=${encodeURIComponent(`${token}.AAAA`)}`)).toBeNull();
  expect(await whoami(`${name}=${encodeURIComponent(`${token}x.${decodeURIComponent(value!).split(".")[1]}`)}`)).toBeNull();
  // Signing out deletes the session; the very next call sees it.
  await fetch(`${srv.url}/api/auth/sign-out`, { method: "POST", headers: { "content-type": "application/json", origin: srv.url, cookie }, body: "{}" });
  expect(await whoami(cookie)).toBeNull();
});

test("past MAX_PENDING_CALLS new calls get a quick 503, and a runtime that is behind is not restarted", async () => {
  const s = await startServer({ forgeDir: fixture, env: prodEnv({ DATA_DIR: tempDir(), FUNCTION_TIMEOUT_MS: "5000", MAX_PENDING_CALLS: "2", RATE_LIMIT_PER_MINUTE: "0" }) });
  try {
    // Distinct arguments, so the cache can't answer or share them.
    const calls = Array.from({ length: 8 }, (_, i) => fetch(`${s.url}/rpc/todos:slowQuery?args=${encodeURIComponent(JSON.stringify({ ms: 300 + i }))}`));
    const responses = await Promise.all(calls);
    const statuses = responses.map((r) => r.status).sort();
    expect(statuses.filter((c) => c === 200).length).toBeGreaterThanOrEqual(2);
    expect(statuses.filter((c) => c === 503).length).toBeGreaterThan(0);
    const busy = responses.find((r) => r.status === 503)!;
    expect(busy.headers.get("retry-after")).toBe("1");
    expect(((await busy.json()) as any).error).toMatchObject({ code: "SERVICE_UNAVAILABLE", message: "Server is busy, try again" });
    // The runtime wasn't touched: it answers normally afterwards.
    expect((await fetch(`${s.url}/rpc/todos:slowQuery?args=${encodeURIComponent('{"ms":1}')}`)).status).toBe(200);
  } finally {
    await s.stop({ graceful: false });
  }
});
