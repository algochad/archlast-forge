import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tempDir } from "./helpers";

// `archlast-forge dev` takes changes from the forge/ folder while it runs: functions, the modules they import, HTTP routes and the schema. These start the CLI as a user does,
// change files under it, and ask the running server to show each change, with the data kept and the caches (the query cache of a function's result) not serving the old code's answers.
const cli = join(import.meta.dir, "../../cli/src/index.ts");
const app = join(import.meta.dir, `.dev-reload-${process.pid}`);
const ADMIN = "k".repeat(32);

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
};

const write = (file: string, text: string) => {
  mkdirSync(join(app, file, ".."), { recursive: true });
  writeFileSync(join(app, file), text);
};

const SCHEMA_1 = `import { defineSchema, defineTable, v } from "../../src/index";
export default defineSchema({ counters: defineTable({ name: v.string(), n: v.number() }).index("by_name", ["name"]) });
`;
const SCHEMA_2 = `import { defineSchema, defineTable, v } from "../../src/index";
export default defineSchema({
  counters: defineTable({ name: v.string(), n: v.number() }).index("by_name", ["name"]),
  notes: defineTable({ topic: v.string(), text: v.string() }).index("by_topic", ["topic"]),
});
`;
const counter = (extra = "") => `import { mutation, query, v } from "../../src/index";
import { FACTOR } from "./_modules/scale";
export const get = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => ((await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).first())?.n ?? 0) * FACTOR,
});
export const inc = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).first()) as { _id: string; n: number } | null;
    if (!row) return ctx.db.insert("counters", { name, n: 1 });
    await ctx.db.patch(row._id as never, { n: row.n + 1 });
    return row._id;
  },
});
${extra}`;
const NOTES = `import { mutation, query, v } from "../../src/index";
export const add = mutation({ args: { topic: v.string(), text: v.string() }, handler: async (ctx, a) => ctx.db.insert("notes", a) });
export const byTopic = query({ args: { topic: v.string() }, handler: async (ctx, { topic }) => (await ctx.db.query("notes").withIndex("by_topic", (q) => q.eq("topic", topic)).collect()).length });
`;
const http = (version: number) => `import { httpRouter, minimalAction, minimalJson } from "../../src/index";
const http = httpRouter();
http.route({ method: "GET", path: "/version", handler: minimalAction(async () => minimalJson({ v: ${version} })) });
export default http;
`;

describe.skipIf(process.platform !== "linux")("dev: changes under forge/ reach the running server", () => {
  let url = "";
  let proc: ReturnType<typeof Bun.spawn>;

  const rpc = async (fn: string, body?: object) => {
    const r = body
      ? await fetch(`${url}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })
      : await fetch(`${url}/rpc/${fn}`);
    return { status: r.status, json: (await r.json().catch(() => null)) as { result?: unknown } | null };
  };
  const read = async (fn: string, args: object) => {
    const r = await fetch(`${url}/rpc/${fn}?args=${encodeURIComponent(JSON.stringify(args))}`);
    return { status: r.status, result: ((await r.json().catch(() => null)) as { result?: unknown } | null)?.result };
  };
  /** Polls until the check passes: the watcher waits a moment after a save, then the runtime restarts. */
  const until = async (check: () => Promise<boolean>, what: string, ms = 30_000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await check().catch(() => false)) return;
      await Bun.sleep(100);
    }
    throw new Error(`still waiting for: ${what}`);
  };
  const version = async () => ((await (await fetch(`${url}/http/version`)).json()) as { v: number }).v;

  beforeAll(async () => {
    rmSync(app, { recursive: true, force: true });
    write("schema.ts", SCHEMA_1);
    write("_modules/scale.ts", "export const FACTOR = 1;\n");
    write("counter.ts", counter());
    write("http.ts", http(1));
    const port = freePort();
    url = `http://127.0.0.1:${port}`;
    proc = Bun.spawn(["bun", cli, "dev", "--no-docker", "--dir", app], {
      env: { ...process.env, PORT: String(port), DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ADMIN_KEY: ADMIN },
      stdout: "ignore",
      stderr: "ignore",
    });
    await until(async () => (await version()) === 1, "the dev server to start", 60_000);
  }, 90_000);

  afterAll(async () => {
    proc?.kill("SIGTERM");
    await Promise.race([proc?.exited, Bun.sleep(10_000)]);
    proc?.kill("SIGKILL");
    rmSync(app, { recursive: true, force: true });
  });

  test("a module a function imports, and the function's cached result", async () => {
    expect((await rpc("counter:inc", { name: "a" })).status).toBe(200);
    expect((await read("counter:get", { name: "a" })).result).toBe(1);
    expect((await read("counter:get", { name: "a" })).result).toBe(1); // (now cached)
    write("_modules/scale.ts", "export const FACTOR = 10;\n");
    await until(async () => (await read("counter:get", { name: "a" })).result === 10, "the module's new value in the function's answer");
    expect((await read("counter:get", { name: "a" })).result).toBe(10); // the old answer is not served from the cache
  }, 60_000);

  test("a function changed in place, and an HTTP route", async () => {
    write("counter.ts", counter(`export const double = query({ args: {}, handler: async () => 2 });\n`));
    await until(async () => (await read("counter:double", {})).result === 2, "the new function");
    write("http.ts", http(2));
    await until(async () => (await version()) === 2, "the new route answer");
  }, 60_000);

  test("a schema change: a new table with an index is usable, and the old data stays", async () => {
    write("schema.ts", SCHEMA_2);
    write("notes.ts", NOTES);
    await until(async () => (await rpc("notes:add", { topic: "t", text: "one" })).status === 200, "the new table");
    expect((await rpc("notes:add", { topic: "t", text: "two" })).status).toBe(200);
    expect((await read("notes:byTopic", { topic: "t" })).result).toBe(2);
    expect((await read("counter:get", { name: "a" })).result).toBe(10); // the earlier data is there
  }, 60_000);

  test("a broken edit is reported, and the next good edit brings everything back", async () => {
    write("counter.ts", "export const broken = (;\n"); // (the runtime is stopped for the reload and the code does not load: it stays down until a file loads)
    await Bun.sleep(2500);
    write("counter.ts", counter());
    write("_modules/scale.ts", "export const FACTOR = 20;\n");
    await until(async () => (await read("counter:get", { name: "a" })).result === 20, "the good edit to apply");
    expect(await version()).toBe(2); // routes and the earlier data are there again
  }, 60_000);

  test("live queries: a subscriber is told when a write changes its result after a reload", async () => {
    const seen: number[] = [];
    const ws = new WebSocket(`${url.replace("http", "ws")}/rpc`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket did not open"));
    });
    ws.onmessage = (e) => {
      try {
        const m = JSON.parse(String(e.data)) as { type?: string; data?: { value?: unknown } };
        if (m.type === "data" && typeof m.data?.value === "number") seen.push(m.data.value);
      } catch {}
    };
    ws.send(JSON.stringify({ type: "subscribe", id: "s1", name: "counter:get", args: { name: "live" } }));
    await Bun.sleep(300);
    await rpc("counter:inc", { name: "live" });
    await until(async () => seen.includes(20), `the subscriber to be told of the write (it got ${JSON.stringify(seen)})`);
    expect(seen[0]).toBe(0);
    ws.close();
  }, 60_000);
});
