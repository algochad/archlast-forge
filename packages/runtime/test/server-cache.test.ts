import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
const admin = { "x-admin-key": "secret", "x-forge-admin": "1", "content-type": "application/json" };
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

const cacheInfo = async () => ((await (await fetch(`${srv.url}/_admin/cache`, { headers: admin })).json()) as any);
const fn = (info: any, name: string) => info.functions.find((f: any) => f.name === name);

test("repeat queries are served from the cache, writes evict, and all of it is measured", async () => {
  const listId = await rpc("todos:createList", { name: "cached" }, { mutation: true });
  const first = await rpc("todos:listByList", { listId });
  const second = await rpc("todos:listByList", { listId });
  expect(second).toEqual(first);
  let info = await cacheInfo();
  expect(info).toMatchObject({ enabled: true, backend: "memory" });
  expect(fn(info, "todos:listByList")).toMatchObject({ hits: 1, misses: 1 });
  expect(info.entries).toBeGreaterThan(0);

  await rpc("todos:add", { listId, title: "milk" }, { mutation: true });
  expect(await rpc("todos:listByList", { listId })).toMatchObject([{ title: "milk" }]); // never stale
  info = await cacheInfo();
  expect(fn(info, "todos:listByList")).toMatchObject({ hits: 1, misses: 2 });
  expect(info.invalidatedEntries).toBeGreaterThan(0);

  const prom = await (await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer secret" } })).text();
  expect(prom).toContain('forge_cache_hits_total{function="todos:listByList"} 1');
  expect(prom).toContain('forge_cache_misses_total{function="todos:listByList"} 2');
  expect(prom).toMatch(/forge_cache_entries \d+/);
});

test("a cached query that counts related documents is never stale after one is added", async () => {
  const listId = await rpc("todos:createList", { name: "counted" }, { mutation: true });
  const total = async () => (await rpc("todos:listCounts", {})).find((l: any) => l._id === listId).total;
  expect(await total()).toBe(0);
  expect(await total()).toBe(0); // from the cache
  await rpc("todos:add", { listId, title: "one" }, { mutation: true });
  expect(await total()).toBe(1);
  await rpc("todos:add", { listId, title: "two" }, { mutation: true });
  expect(await total()).toBe(2);
});

test("queries that read ctx.auth are cached per user and never leak between them", async () => {
  const signUp = async (name: string) => {
    const res = await fetch(`${srv.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ email: `${name}@example.com`, password: "correct horse battery", name }),
    });
    return res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
  };
  const [ada, bo] = [await signUp("Ada"), await signUp("Bo")];
  const who = async (cookie?: string) => (await rpc("todos:whoami", {}, { headers: cookie ? { cookie } : {} }))?.name ?? null;
  expect(await who(ada)).toBe("Ada"); // first run reveals the query reads ctx.auth
  expect(await who(ada)).toBe("Ada");
  expect(await who(ada)).toBe("Ada");
  expect(await who(bo)).toBe("Bo");
  expect(await who()).toBeNull();
  expect(await who(ada)).toBe("Ada");
  const f = fn(await cacheInfo(), "todos:whoami");
  expect(f.perUser).toBe(true);
  expect(f.hits).toBeGreaterThanOrEqual(2);
});

test("two sessions of one user share cache entries", async () => {
  const email = "cy@example.com";
  const cookieOf = (res: Response) => res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
  const auth = (path: string, body: object) => fetch(`${srv.url}/api/auth/${path}`, { method: "POST", headers: { "content-type": "application/json", origin: srv.url }, body: JSON.stringify(body) });
  const first = cookieOf(await auth("sign-up/email", { email, password: "correct horse battery", name: "Cy" }));
  const second = cookieOf(await auth("sign-in/email", { email, password: "correct horse battery" })); // another device: another session
  expect(second).not.toBe(first);
  const who = async (cookie: string) => (await rpc("todos:whoami", {}, { headers: { cookie } }))?.name;
  await who(first); // reveals the query reads ctx.auth
  await who(first); // stored under this user
  const before = fn(await cacheInfo(), "todos:whoami").hits;
  expect(await who(second)).toBe("Cy");
  expect(fn(await cacheInfo(), "todos:whoami").hits).toBe(before + 1); // a hit, not a second entry per session
});

test("clearing the cache empties it, and the dashboard action is audited", async () => {
  await rpc("todos:createList", { name: "x" }, { mutation: true });
  await rpc("todos:openCount", { listId: await rpc("todos:createList", { name: "y" }, { mutation: true }) });
  expect((await cacheInfo()).entries).toBeGreaterThan(0);
  const res = await fetch(`${srv.url}/_admin/clearCache`, { method: "POST", headers: admin, body: "{}" });
  expect(((await res.json()) as any)).toBeGreaterThan(0);
  expect((await cacheInfo()).entries).toBe(0);
  const audit = ((await (await fetch(`${srv.url}/_admin/audit?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`, { headers: admin })).json()) as any);
  expect(audit.some((a: any) => a.action === "clearCache")).toBe(true);
});

test("clearing the cache needs an admin session", async () => {
  const denied = await fetch(`${srv.url}/_admin/clearCache`, { method: "POST", headers: { "content-type": "application/json", "x-forge-admin": "1" }, body: "{}" });
  expect(denied.status).toBe(401);
});

test("reloading the function runtime flushes the cache, since the code may have changed", async () => {
  const listId = await rpc("todos:createList", { name: "reload" }, { mutation: true });
  await rpc("todos:listByList", { listId });
  expect((await cacheInfo()).entries).toBeGreaterThan(0);
  await srv.reload();
  expect((await cacheInfo()).entries).toBe(0);
});
