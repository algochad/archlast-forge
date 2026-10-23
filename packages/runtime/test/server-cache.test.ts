import { afterAll, beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
const admin = { "x-admin-key": "secret", "x-forge-admin": "1", "content-type": "application/json" };
let srv: RunningServer;

beforeAll(async () => {
  srv = await startServer({ convexDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret" } });
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

const cacheInfo = async () => ((await (await fetch(`${srv.url}/_admin/cache`, { headers: admin })).json()) as any).result.data;
const fn = (info: any, name: string) => info.functions.find((f: any) => f.name === name);

test("repeat queries are served from the cache, writes evict, and all of it is measured", async () => {
  const listId = await trpc("todos.createList", { name: "cached" }, { mutation: true });
  const first = await trpc("todos.listByList", { listId });
  const second = await trpc("todos.listByList", { listId });
  expect(second).toEqual(first);
  let info = await cacheInfo();
  expect(info).toMatchObject({ enabled: true, backend: "memory" });
  expect(fn(info, "todos:listByList")).toMatchObject({ hits: 1, misses: 1 });
  expect(info.entries).toBeGreaterThan(0);

  await trpc("todos.add", { listId, title: "milk" }, { mutation: true });
  expect(await trpc("todos.listByList", { listId })).toMatchObject([{ title: "milk" }]); // never stale
  info = await cacheInfo();
  expect(fn(info, "todos:listByList")).toMatchObject({ hits: 1, misses: 2 });
  expect(info.invalidatedEntries).toBeGreaterThan(0);

  const prom = await (await fetch(`${srv.url}/metrics`, { headers: { authorization: "Bearer secret" } })).text();
  expect(prom).toContain('forge_cache_hits_total{function="todos:listByList"} 1');
  expect(prom).toContain('forge_cache_misses_total{function="todos:listByList"} 2');
  expect(prom).toMatch(/forge_cache_entries \d+/);
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
  const who = async (cookie?: string) => (await trpc("todos.whoami", {}, { headers: cookie ? { cookie } : {} }))?.name ?? null;
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

test("clearing the cache empties it, and the dashboard action is audited", async () => {
  await trpc("todos.createList", { name: "x" }, { mutation: true });
  await trpc("todos.openCount", { listId: await trpc("todos.createList", { name: "y" }, { mutation: true }) });
  expect((await cacheInfo()).entries).toBeGreaterThan(0);
  const res = await fetch(`${srv.url}/_admin/clearCache`, { method: "POST", headers: admin, body: "{}" });
  expect(((await res.json()) as any).result.data).toBeGreaterThan(0);
  expect((await cacheInfo()).entries).toBe(0);
  const audit = ((await (await fetch(`${srv.url}/_admin/audit?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`, { headers: admin })).json()) as any).result.data;
  expect(audit.some((a: any) => a.action === "clearCache")).toBe(true);
});

test("clearing the cache needs an admin session", async () => {
  const denied = await fetch(`${srv.url}/_admin/clearCache`, { method: "POST", headers: { "content-type": "application/json", "x-forge-admin": "1" }, body: "{}" });
  expect(denied.status).toBe(401);
});

test("reloading the function runtime flushes the cache, since the code may have changed", async () => {
  const listId = await trpc("todos.createList", { name: "reload" }, { mutation: true });
  await trpc("todos.listByList", { listId });
  expect((await cacheInfo()).entries).toBeGreaterThan(0);
  await srv.reload();
  expect((await cacheInfo()).entries).toBe(0);
});
