// The whole engine on MongoDB (DATABASE_URL=mongodb://…): calls over HTTP, live queries over a socket, the scheduler, the dashboard's data and
// settings, restarts, and a pool of function runtimes sharing one database. Needs TEST_MONGODB_URL (`bun run services:up`).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runCommand, openProject } from "../src/server/cli-ops";
import { loadConfig } from "../src/server/config";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
const KEY = "m".repeat(32);
const url = process.env.TEST_MONGODB_URL;
/** A database of its own, so engine collections of other runs aren't there. */
const freshUrl = () => url!.replace(/\/(\?|$)/, `/afx_engine_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}$1`);

test("DATABASE_URL accepts mongodb:// and mongodb+srv://, and says what it takes", () => {
  expect(loadConfig({ DATABASE_URL: "mongodb://db:27017/app?replicaSet=rs0", BETTER_AUTH_SECRET: "x".repeat(32) }, true).databaseKind).toBe("mongodb");
  expect(loadConfig({ DATABASE_URL: "mongodb+srv://u:p@cluster.example.net/app", BETTER_AUTH_SECRET: "x".repeat(32) }, true).databaseKind).toBe("mongodb");
  expect(loadConfig({ DATABASE_URL: "postgres://u:p@db/app", BETTER_AUTH_SECRET: "x".repeat(32) }, true).databaseKind).toBe("postgres");
  expect(loadConfig({}, true).databaseKind).toBe("sqlite");
  expect(() => loadConfig({ DATABASE_URL: "mysql://u@db/app" }, true)).toThrow("DATABASE_URL must be a postgres:// or mongodb:// URL");
  const shared = { REPLICAS: "2", REDIS_URL: "redis://r", S3_ENDPOINT: "http://s3", S3_BUCKET: "b", BETTER_AUTH_SECRET: "x".repeat(32) };
  expect(() => loadConfig(shared, true)).toThrow("requires a Postgres or MongoDB DATABASE_URL");
  expect(loadConfig({ ...shared, DATABASE_URL: "mongodb://db/app" }, true).replicas).toBe(2);
});

describe.if(Boolean(url))("the engine on MongoDB", () => {
  for (const workers of [1, 2]) {
    describe(`${workers} function runtime${workers > 1 ? "s" : ""}`, () => {
      let srv: RunningServer;
      const databaseUrl = url ? freshUrl() : "";
      const start = () =>
        startServer({
          forgeDir: fixture,
          dev: true,
          env: { ...process.env, PORT: "0", DATA_DIR: dataDir, DATABASE_URL: databaseUrl, ADMIN_KEY: KEY, RUNTIME_WORKERS: String(workers), CRON_ENABLED: "1" },
        });
      const dataDir = tempDir();
      beforeAll(async () => {
        srv = await start();
      });
      afterAll(() => srv?.stop({ graceful: false }));

      const rpc = async (name: string, input: unknown, mutation = false) => {
        const res = mutation
          ? await fetch(`${srv.url}/rpc/${name}`, { method: "POST", body: JSON.stringify(input), headers: { "content-type": "application/json" } })
          : await fetch(`${srv.url}/rpc/${name}?args=${encodeURIComponent(JSON.stringify(input))}`);
        const body = (await res.json()) as any;
        if (body.error) throw new Error(body.error.message);
        return body.result;
      };
      const admin = async (op: string, input?: unknown, method: "GET" | "POST" = input === undefined ? "GET" : "POST") => {
        const res = method === "GET"
          ? await fetch(`${srv.url}/_admin/${op}${input ? `?input=${encodeURIComponent(JSON.stringify(input))}` : ""}`, { headers: { "x-admin-key": KEY } })
          : await fetch(`${srv.url}/_admin/${op}`, { method: "POST", body: JSON.stringify(input), headers: { "x-admin-key": KEY, "x-forge-admin": "1", "content-type": "application/json" } });
        const body = (await res.json()) as any;
        if (!res.ok) throw new Error(body?.error?.message ?? body?.message ?? `HTTP ${res.status}`);
        return body;
      };
      const until = async <T>(get: () => Promise<T> | T, ok: (v: T) => boolean, ms = 10_000): Promise<T> => {
        for (const end = Date.now() + ms; ; await Bun.sleep(25)) {
          const v = await get();
          if (ok(v)) return v;
          if (Date.now() > end) throw new Error(`timed out; last: ${JSON.stringify(v).slice(0, 300)}`);
        }
      };
      function subscribe(name: string, args: unknown) {
        const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
        const updates: any[] = [];
        ws.addEventListener("message", (e) => {
          const msg = JSON.parse(String(e.data));
          if (msg.type === "data") updates.push(msg.data);
        });
        ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "subscribe", id: "1", name, args })));
        return { updates, close: () => ws.close() };
      }

      test("queries, mutations, validation, and writes in batches", async () => {
        const listId = await rpc("todos:createList", { name: "home" }, true);
        const ids = await rpc("todos:addMany", { listId, titles: ["a", "b", "c"] }, true);
        expect((await rpc("todos:listByList", { listId })).map((t: any) => t.title)).toEqual(["a", "b", "c"]);
        await rpc("todos:completeMany", { ids }, true);
        expect(await rpc("todos:openCount", { listId })).toBe(0);
        await expect(rpc("todos:add", { listId, title: 5 }, true)).rejects.toThrow("args.title must be a string");
        // a mutation that fails after writing leaves nothing
        await expect(rpc("todos:failAfterInsert", { listId }, true)).rejects.toThrow();
        expect((await rpc("todos:listByList", { listId })).length).toBe(3);
      });

      test("a write wakes the live queries it touches, and only them", async () => {
        const listId = await rpc("todos:createList", { name: "live" }, true);
        const other = await rpc("todos:createList", { name: "quiet" }, true);
        const mine = subscribe("todos:listByList", { listId });
        const theirs = subscribe("todos:listByList", { listId: other });
        await until(() => [mine.updates.length, theirs.updates.length], ([a, b]) => a === 1 && b === 1);
        await rpc("todos:add", { listId, title: "pushed" }, true);
        await until(() => mine.updates.length, (n) => n === 2);
        expect(mine.updates[1].value.map((t: any) => t.title)).toEqual(["pushed"]);
        await Bun.sleep(200);
        expect(theirs.updates).toHaveLength(1);
        mine.close();
        theirs.close();
      });

      test("concurrent read-modify-write mutations are retried on write conflicts", async () => {
        const listId = await rpc("todos:createList", { name: "contended" }, true);
        const id = await rpc("todos:add", { listId, title: "t" }, true);
        await Promise.all(Array.from({ length: 8 }, () => rpc("todos:toggle", { id }, true)));
        expect((await rpc("todos:get", { id })).done).toBe(false); // 8 toggles
      });

      test("scheduled mutations run once; the dashboard lists them and counts documents", async () => {
        await rpc("todos:scheduleEvent", { kind: "later", delayMs: 100 }, true);
        await until(() => rpc("todos:events", {}), (e: any[]) => e.some((x) => x.kind === "later"));
        const jobs = await admin("scheduled", { state: "success" }, "GET");
        expect(jobs.some((j: any) => j.name === "todos:logEvent")).toBe(true);
        const counts = await admin("counts", { tables: ["lists", "todos", "events"] }, "GET");
        expect(counts.lists).toBeGreaterThan(0);
        expect(counts.events).toBeGreaterThanOrEqual(1);
        // the one-off job ran once (the fixture's cron adds events of its own, of another kind)
        expect(((await rpc("todos:events", {})) as { kind: string }[]).filter((e) => e.kind === "later")).toHaveLength(1);
      });

      test("settings and environment variables saved from the dashboard persist, and the next start reads them", async () => {
        await admin("saveSetting", { name: "CACHE_TTL_MS", value: "1234" });
        await admin("env.set", { name: "FROM_MONGO", value: "yes" });
        expect((await admin("settings")).settings.find((s: any) => s.name === "CACHE_TTL_MS")).toMatchObject({ source: "dashboard", value: "1234" });
        expect((await admin("env")).map((e: any) => e.name)).toContain("FROM_MONGO");
        const before = await rpc("todos:createList", { name: "survives" }, true);
        await srv.stop({ graceful: false });
        srv = await start();
        expect(srv.config.cacheTtlMs).toBe(1234);
        expect((await admin("env")).map((e: any) => e.name)).toContain("FROM_MONGO");
        expect(before).toMatch(/^lists:/);
        expect((await admin("counts", { tables: ["lists"] }, "GET")).lists).toBeGreaterThan(0);
      });

      test("the dashboard's performance pages work (the telemetry store is a SQLite file next to the engine)", async () => {
        await fetch(`${srv.url}/rpc/todos:crash`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
        const range = encodeURIComponent(JSON.stringify({ from: Date.now() - 600_000, to: Date.now() + 60_000 }));
        const overview = await until(
          async () => (await (await fetch(`${srv.url}/_admin/obs.overview?input=${range}`, { headers: { "x-admin-key": KEY } })).json()) as any,
          (o) => o?.requests?.count >= 1,
        );
        expect(overview.requests.count).toBeGreaterThanOrEqual(1);
      });
    });
  }
});

describe.if(Boolean(url))("accounts and the CLI on MongoDB", () => {
  test("sign up, sign in and the sessions Better Auth keeps in MongoDB; the dashboard hides credentials", async () => {
    const srv = await startServer({
      forgeDir: join(import.meta.dir, "fixture-auth"),
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), DATABASE_URL: freshUrl(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", ADMIN_KEY: "root-key", DASHBOARD: "on" },
    });
    try {
      const post = (path: string, body: unknown) => fetch(`${srv.url}/api/auth${path}`, { method: "POST", headers: { "content-type": "application/json", origin: srv.url }, body: JSON.stringify(body) });
      expect((await post("/sign-up/email", { email: "ada@example.com", password: "ada password 123", name: "Ada" })).status).toBe(200);
      expect((await post("/sign-up/email", { email: "ada@example.com", password: "another one 123", name: "Ada" })).status).not.toBe(200); // the unique email
      expect((await post("/sign-in/email", { email: "ada@example.com", password: "wrong password" })).status).toBe(401);
      const ok = await post("/sign-in/email", { email: "ada@example.com", password: "ada password 123" });
      expect(ok.status).toBe(200);
      const cookie = ok.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
      const session = (await (await fetch(`${srv.url}/api/auth/get-session`, { headers: { cookie } })).json()) as any;
      expect(session.user.email).toBe("ada@example.com");
      const accounts = (await (await fetch(`${srv.url}/_admin/docs?input=${encodeURIComponent(JSON.stringify({ table: "accounts" }))}`, { headers: { "x-admin-key": "root-key" } })).json()) as any;
      expect(accounts.page.find((a: any) => a.accountId).password).toBe("[hidden]");
    } finally {
      await srv.stop({ graceful: false });
    }
  });

  test("the CLI's data commands: export and import, migrations, a full backup and its restore, env and admins", async () => {
    const forgeDir = join(import.meta.dir, "fixture-backup");
    const env = { ...process.env, DATA_DIR: tempDir(), DATABASE_URL: freshUrl(), ADMIN_KEY: KEY } as Record<string, string>;
    const p = await openProject(forgeDir, env);
    const dir = tempDir();
    try {
      const add = (title: string) => p.exec.mutate((s) => s.insert("posts", { title, body: `body of ${title}`, tag: "t" } as never));
      for (const t of ["one", "two", "three"]) await add(t);
      const run = (cmd: string, args: Record<string, unknown> = {}) => runCommand(p, cmd, args);

      expect(await run("export", { file: join(dir, "out.jsonl") })).toBeGreaterThanOrEqual(3);
      await expect(run("import", { file: join(dir, "out.jsonl") })).rejects.toThrow("already has");
      expect(await run("import", { file: join(dir, "out.jsonl"), replace: true })).toBeGreaterThanOrEqual(3);
      expect((await run("migrate.status")) as unknown[]).toBeInstanceOf(Array);
      expect((await run("migrate.check")).invalid).toEqual([]);

      await run("env.set", { name: "A_B", value: "1" });
      expect((await run("env.list")).map((e: any) => e.name)).toEqual(["A_B"]);
      await run("env.rm", { name: "A_B" });
      await run("admin.add", { email: "o@example.com", password: "a long password!", role: "owner" });
      expect((await run("admin.list")).map((a: any) => a.email)).toEqual(["o@example.com"]);
      await run("admin.remove", { email: "o@example.com" });
      await expect(run("backup", { file: join(dir, "db.sqlite") })).rejects.toThrow("mongodump");

      const archive = join(dir, "full.tar.gz");
      await run("backup.full", { file: archive, files: false });
      await add("four (after the backup)");
      const titles = async () => ((await p.exec.read((s) => s.query("posts").collect())).value as { title: string }[]).map((d) => d.title).sort();
      expect(await titles()).toHaveLength(4);
      const restored = await run("restore", { file: archive, files: false });
      expect(restored.documents).toBe(3);
      expect(await titles()).toEqual(["one", "three", "two"]);
    } finally {
      await p.close();
    }
  });
});
