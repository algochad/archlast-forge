// What each layer costs, one request at a time, with no HTTP and no IPC: the functions run directly on the seeded database.
//   BETTER_AUTH_SECRET=… bun micro.ts --data <dir with app.db copy> --tokens <tokens.json>
// Compares: raw SQLite for the same statements, a function call, and a function call that also resolves a Better Auth session.
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { createSqliteDb } from "../../packages/runtime/src/server/db/sqlite";
import { loadConfig } from "../../packages/runtime/src/server/config";
import { createAuth } from "../../packages/runtime/src/server/auth";
import { Executor } from "../../packages/runtime/src/server/executor";
import { loadProject, tableSpecs } from "../../packages/runtime/src/server/project";
import { migrateSystem } from "../../packages/runtime/src/server/system";

const { values } = parseArgs({ options: { data: { type: "string" }, tokens: { type: "string" }, n: { type: "string", default: "400" } } });
const N = Number(values.n);
const tokens: { cookie: string; username: string }[] = JSON.parse(readFileSync(values.tokens!, "utf8"));
const dbPath = join(values.data!, "app.db");
const config = loadConfig({ ...process.env, DATA_DIR: values.data!, BETTER_AUTH_URL: "http://127.0.0.1:3100", ALLOW_INSECURE_HTTP: "1", NODE_ENV: "production" }, false);

const db = createSqliteDb(dbPath);
await migrateSystem(db);
const project = await loadProject(join(import.meta.dir, "forge"));
await db.migrate(tableSpecs(project.tables));
let logged = 0;
const exec = new Executor({ db, tables: project.tables, functions: project.functions, limits: config.limits, publish: () => {}, log: () => void logged++ });
createAuth(exec, project.tables, project.authOptions, config);

const stat = (ms: number[]) => {
  const s = [...ms].sort((a, b) => a - b);
  const at = (p: number) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)]!;
  return { mean: +(s.reduce((a, b) => a + b, 0) / s.length).toFixed(3), p50: +at(0.5).toFixed(3), p99: +at(0.99).toFixed(3), max: +s.at(-1)!.toFixed(3) };
};
async function time(label: string, fn: (i: number) => Promise<unknown>, n = N) {
  for (let i = 0; i < 30; i++) await fn(i); // warm up the JIT and caches
  const ms: number[] = [];
  for (let i = 0; i < n; i++) {
    const t = performance.now();
    await fn(i);
    ms.push(performance.now() - t);
  }
  console.log(`${label.padEnd(58)} ${JSON.stringify(stat(ms))}`);
  return stat(ms);
}

// ---- the same statements, straight at SQLite ----
const raw = new Database(dbPath, { readonly: true });
console.log("== raw SQLite (bun:sqlite, prepared, one connection)");
const post = raw.query(`SELECT "_id", "_creationTime", "doc" FROM "posts" ORDER BY "_creationTime" DESC, "_id" DESC LIMIT 20`);
const ids = (post.all() as any[]).map((r) => r._id as string);
const count = raw.query(`SELECT COUNT(*) AS n FROM "likes" WHERE json_extract("doc", '$.postId') = ?`);
const feedSql = () => {
  const rows = post.all() as any[];
  for (const r of rows) count.get(r._id);
};
await time("feed: 20 newest posts + 20 like counts (SQL only)", async () => feedSql());
await time("one like count", async (i) => count.get(ids[i % 20]));
const plan = (sql: string, ...p: unknown[]) => (raw.query(`EXPLAIN QUERY PLAN ${sql}`).all(...(p as any[])) as any[]).map((r) => r.detail).join(" | ");
console.log("plan: newest posts   ->", plan(`SELECT "_id" FROM "posts" ORDER BY "_creationTime" DESC, "_id" DESC LIMIT 20`));
console.log("plan: like count     ->", plan(`SELECT COUNT(*) FROM "likes" WHERE json_extract("doc", '$.postId') = ?`, ids[0]));
console.log("plan: session lookup ->", plan(`SELECT * FROM "sessions" WHERE json_extract("doc", '$.token') = ?`, "x"));
console.log("plan: has user liked ->", plan(`SELECT * FROM "likes" WHERE json_extract("doc", '$.userId') = ? AND json_extract("doc", '$.postId') = ?`, "u", "p"));

// ---- the engine's functions, in process ----
console.log("\n== functions through the executor (validation, transaction, joins, logging; no HTTP, no IPC)");
const call = (name: string, kind: "query" | "mutation", args: object, cookie?: string) => exec.run(name, kind, args, cookie ? { cookie } : {});
await time("feed.list", () => call("feed:list", "query", {}));
await time("feed.get", (i) => call("feed:get", "query", { id: ids[i % 20] }));
console.log("\n== the session lookup that every signed-in call pays");
await time("resolve a Better Auth session (cookie -> user)", (i) => exec.identityOf({ cookie: tokens[i % tokens.length]!.cookie }));
console.log("\n== writes (each is a SQLite write transaction)");
await time("feed.like (session + checks + insert)", (i) => call("feed:like", "mutation", { postId: ids[i % 20] }, tokens[(i * 7) % tokens.length]!.cookie), 200);
await time("feed.create (session + insert)", (i) => call("feed:create", "mutation", { body: `micro ${i} ${Math.random()}` }, tokens[i % tokens.length]!.cookie), 200);
console.log(`\nlog entries emitted: ${logged}`);
await db.close();
