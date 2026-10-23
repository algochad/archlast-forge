import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { addAdmin } from "../src/server/admin-ops";
import { compileCustom, CustomCodeError } from "../src/server/custom";
import { createLocalDb } from "../src/server/db/factory";
import { startServer, type RunningServer } from "../src/server/server";
import { migrateSystem } from "../src/server/system";
import { tempDir } from "./helpers";

describe("compileCustom", () => {
  test("a function file: imports are ignored, TypeScript is fine", async () => {
    const fn = await compileCustom(`
      import { query, v } from "./_generated/server";
      import type { Doc } from "./_generated/dataModel";
      const take = (n: number): number => n * 2;
      export default query({
        args: { n: v.number() },
        handler: async (ctx: any, { n }: { n: number }) => take(n),
      });
    `);
    expect(fn.kind).toBe("query");
    expect(await fn.handler({}, { n: 21 })).toBe(42);
    expect(Object.keys(fn.args)).toEqual(["n"]);
  });

  test("a multi-line import doesn't shift line numbers", async () => {
    const err = await compileCustom(`import {\n  query,\n  v,\n} from "x";\nexport default query({ handler: ( => 1 });`).catch((e) => e);
    expect(err).toBeInstanceOf(CustomCodeError);
    expect(err.line).toBe(5);
  });

  test("mutations are recognised, and a bare function is a query", async () => {
    expect((await compileCustom(`export default mutation({ handler: async () => 1 })`)).kind).toBe("mutation");
    const bare = await compileCustom(`export default async (ctx) => "hi"`);
    expect(bare.kind).toBe("query");
    expect(await bare.handler({}, {})).toBe("hi");
  });

  test("named exports are tolerated", async () => {
    const fn = await compileCustom(`export const limit = 3;\nexport default query({ handler: () => limit });`);
    expect(await fn.handler({}, {})).toBe(3);
  });

  test("says what's wrong when there is nothing to run", async () => {
    await expect(compileCustom(`const x = 1`)).rejects.toThrow("Export a function");
    await expect(compileCustom(``)).rejects.toThrow("Export a function");
    await expect(compileCustom(`export default 42`)).rejects.toThrow("Export a function");
    await expect(compileCustom(`export default action({ handler: () => 1 })`)).rejects.toThrow(/ReferenceError/);
    await expect(compileCustom(`export default internalQuery({ handler: () => 1 })`)).rejects.toThrow(/ReferenceError/);
  });
});

const fixture = join(import.meta.dir, "fixture");
const admin = { "x-admin-key": "secret", "x-forge-admin": "1", "content-type": "application/json" };

describe("runCustom in dev", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret" } });
  });
  afterAll(() => srv.stop());

  const run = async (code: string, extra: object = {}) => {
    const res = await fetch(`${srv.url}/_admin/runCustom`, { method: "POST", headers: admin, body: JSON.stringify({ code, ...extra }) });
    return ((await res.json()) as any);
  };
  const rpc = async (path: string, input: unknown, mutation = false) => {
    const res = mutation
      ? await fetch(`${srv.url}/rpc/${path}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } })
      : await fetch(`${srv.url}/rpc/${path}?args=${encodeURIComponent(JSON.stringify(input))}`);
    return ((await res.json()) as any).result;
  };

  test("a custom query reads the database and reports how long it took", async () => {
    const listId = await rpc("todos:createList", { name: "from custom" }, true);
    await rpc("todos:add", { listId, title: "one" }, true);
    const out = await run(`export default query({ handler: async (ctx) => ctx.db.query("todos").collect() })`);
    expect(out).toMatchObject({ ok: true, kind: "query", value: [{ title: "one", listId }] });
    expect(out.ms).toBeGreaterThanOrEqual(0);
  });

  test("arguments are validated like any function's", async () => {
    const code = `export default query({ args: { n: v.number() }, handler: async (_ctx, { n }) => n + 1 })`;
    expect(await run(code, { args: { n: 4 } })).toMatchObject({ ok: true, value: 5 });
    expect(await run(code, { args: { n: "x" } })).toMatchObject({ ok: false, phase: "run", error: expect.stringContaining("args.n must be a finite number") });
  });

  test("console output comes back with the result", async () => {
    const out = await run(`export default query({ handler: async () => { console.log("hello", { a: 1 }); console.warn("careful"); return 1; } })`);
    expect(out.logs.map((l: any) => l.level)).toEqual(["log", "warn"]);
    expect(out.logs[0].message).toStartWith("hello {");
    expect(out.logs[1].message).toBe("careful");
  });

  test("a failure comes back as data, with the console output up to that point", async () => {
    const out = await run(`export default query({ handler: async () => { console.log("before"); throw new Error("boom"); } })`);
    expect(out).toMatchObject({ ok: false, phase: "run", kind: "query", error: "boom" });
    expect(out.logs).toHaveLength(1);
  });

  test("a syntax error says which line", async () => {
    const out = await run(`\n\nexport default query({ handler: ( => 1 })`);
    expect(out).toMatchObject({ ok: false, phase: "compile", line: 3 });
  });

  test("a custom query is read-only", async () => {
    const out = await run(`export default query({ handler: async (ctx) => ctx.db.insert("lists", { name: "nope" }) })`);
    expect(out.ok).toBe(false);
  });

  test("a custom mutation writes, and live queries and the cache see it", async () => {
    const listId = await rpc("todos:createList", { name: "mutate me" }, true);
    expect(await rpc("todos:listByList", { listId })).toEqual([]); // now cached
    const code = `export default mutation({
      args: { listId: v.id("lists") },
      handler: async (ctx, { listId }) => { await ctx.db.insert("todos", { listId, title: "made in the dashboard", done: false }); return "ok"; },
    })`;
    expect(await run(code, { args: { listId } })).toMatchObject({ ok: true, kind: "mutation", value: "ok" });
    expect(await rpc("todos:listByList", { listId })).toMatchObject([{ title: "made in the dashboard" }]);
  });

  test("a mutation that throws rolls back", async () => {
    const before = (await run(`export default query({ handler: (ctx) => ctx.db.query("lists").collect() })`)).value.length;
    const out = await run(`export default mutation({ handler: async (ctx) => { await ctx.db.insert("lists", { name: "ghost" }); throw new ForgeError("changed my mind"); } })`);
    expect(out).toMatchObject({ ok: false, error: expect.stringContaining("changed my mind") });
    expect((await run(`export default query({ handler: (ctx) => ctx.db.query("lists").collect() })`)).value.length).toBe(before);
  });

  test("it can run as a signed-in user", async () => {
    const res = await fetch(`${srv.url}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: srv.url },
      body: JSON.stringify({ email: "asuser@example.com", password: "correct horse battery", name: "As User" }),
    });
    const cookie = res.headers
      .getSetCookie()
      .map((c) => c.split(";")[0])
      .join("; ");
    const me = ((await (await fetch(`${srv.url}/rpc/todos:whoami`, { headers: { cookie } })).json()) as any).result;
    const code = `export default query({ handler: async (ctx) => (await ctx.auth.getUserIdentity())?.email ?? null })`;
    expect(await run(code)).toMatchObject({ ok: true, value: null });
    expect(await run(code, { asUserId: me.userId })).toMatchObject({ ok: true, value: "asuser@example.com" });
  });

  test("every run is in the audit log, with the code", async () => {
    await run(`export default query({ handler: () => "audited" })`);
    const audit = ((await (await fetch(`${srv.url}/_admin/audit?input=${encodeURIComponent(JSON.stringify({ limit: 5 }))}`, { headers: admin })).json()) as any);
    const entry = audit.find((a: any) => a.action === "runCustom");
    expect(entry.actor).toBe("admin-key");
    expect(entry.details).toContain("audited");
  });

  test("the server says whether custom functions are on", async () => {
    expect(((await (await fetch(`${srv.url}/_admin/server`, { headers: admin })).json()) as any).customFunctions).toBe(true);
  });
});

describe("runCustom in production", () => {
  const dataDir = tempDir();
  const env = (extra: Record<string, string> = {}) => ({
    ...process.env,
    PORT: "0",
    DATA_DIR: dataDir,
    BETTER_AUTH_SECRET: "s".repeat(32),
    ALLOW_INSECURE_HTTP: "1",
    ADMIN_KEY: "root-key",
    DASHBOARD: "on",
    RATE_LIMIT_PER_MINUTE: "100000",
    LOG_FORMAT: "json",
    ...extra,
  });
  const body = JSON.stringify({ code: `export default query({ handler: () => 1 })` });
  const login = async (srv: RunningServer, email: string, password: string) => {
    const res = await fetch(`${srv.url}/_admin/login`, { method: "POST", headers: { "content-type": "application/json", "x-forge-admin": "1" }, body: JSON.stringify({ email, password }) });
    return res.headers.get("set-cookie")!.split(";")[0]!;
  };
  const post = (srv: RunningServer, headers: Record<string, string>) =>
    fetch(`${srv.url}/_admin/runCustom`, { method: "POST", headers: { "content-type": "application/json", "x-forge-admin": "1", ...headers }, body });

  beforeAll(async () => {
    const db = await createLocalDb(join(dataDir, "app.db"));
    await migrateSystem(db);
    await addAdmin(db, "admin@example.com", "admin-password-123", "admin");
    await addAdmin(db, "owner@example.com", "owner-password-123", "owner");
    await db.close();
  });

  test("off by default, even for the owner", async () => {
    const srv = await startServer({ forgeDir: fixture, env: env() });
    try {
      const res = await post(srv, { "x-admin-key": "root-key" });
      expect(res.status).toBe(403);
      expect(((await res.json()) as any).error.message).toContain("ALLOW_CUSTOM_FUNCTIONS");
      expect(((await (await fetch(`${srv.url}/_admin/server`, { headers: { "x-admin-key": "root-key" } })).json()) as any).customFunctions).toBe(false);
    } finally {
      await srv.stop();
    }
  });

  test("on: owners only", async () => {
    const srv = await startServer({ forgeDir: fixture, env: env({ ALLOW_CUSTOM_FUNCTIONS: "on" }) });
    try {
      expect((await post(srv, {})).status).toBe(401);
      expect((await post(srv, { cookie: await login(srv, "admin@example.com", "admin-password-123") })).status).toBe(403);
      const res = await post(srv, { cookie: await login(srv, "owner@example.com", "owner-password-123") });
      expect(((await res.json()) as any)).toMatchObject({ ok: true, value: 1 });
    } finally {
      await srv.stop();
    }
  });
});
