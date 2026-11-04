// One workload through the engine's own Executor and DocStore, on any database adapter: the same operations, the same data, so the numbers of
// SQLite, Postgres and MongoDB can be put side by side.
//   DB=sqlite|postgres|mongodb  [DATABASE_URL=…]  [SCALE=1]  [SECONDS=3]  [ONLY=name,name]  [JSON=file]  bun benchmarks/db-adapters/bench.ts
// SCALE multiplies the data: 1 is 200,000 todos, 120,000 comments and 50,000 notes.
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresDb } from "../../packages/runtime/src/server/db/postgres";
import { createSqliteDb, serverMemory } from "../../packages/runtime/src/server/db/sqlite";
import type { Db } from "../../packages/runtime/src/server/db/types";
import { Executor } from "../../packages/runtime/src/server/executor";
import { loadProject, tableSpecs } from "../../packages/runtime/src/server/project";
import { ReadCache } from "../../packages/runtime/src/server/read-cache";

const kind = process.env.DB ?? "sqlite";
const SCALE = Number(process.env.SCALE ?? 1);
const SECONDS = Number(process.env.SECONDS ?? 3);
const only = process.env.ONLY?.split(",");
const LISTS = Math.max(4, Math.round(100 * SCALE));
const PER = 2000;
const N = LISTS * PER;

const project = await loadProject(join(import.meta.dir, "../../packages/runtime/test/fixture"));
async function open(): Promise<Db> {
  if (kind === "sqlite") return createSqliteDb(join(mkdtempSync(join(tmpdir(), "dbbench-")), "app.db"), 4, serverMemory());
  if (kind === "postgres") return createPostgresDb(process.env.DATABASE_URL ?? "postgres://forge:forge@localhost:55432/forge", Number(process.env.POOL) || undefined);
  if (kind === "mongodb") {
    const { createMongoDb } = await import("../../packages/runtime/src/server/db/mongodb");
    return createMongoDb(process.env.DATABASE_URL ?? "mongodb://localhost:57017/?replicaSet=rs0&directConnection=true", { database: "bench" + Date.now() });
  }
  throw new Error(`DB=${kind}?`);
}
const db = await open();
// The row cache is only exact with one writer on SQLite; the others don't have it.
await db.migrate(tableSpecs(project.tables));
const exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {}, readCache: kind === "sqlite" ? new ReadCache() : undefined });
for (const t of ["todos", "lists", "comments", "notes"]) {
  await exec.rewrite(async (s) => { await s.truncate(t); });
}

// ---- data ----
const t0 = performance.now();
const listIds: string[] = [];
for (let i = 0; i < LISTS; i++) listIds.push(await exec.mutate((s: any) => s.insert("lists", { name: "l" + i })));
const ids: string[] = [];
for (let l = 0; l < LISTS; l++) ids.push(...((await exec.mutate((s: any) => s.insertMany("todos", Array.from({ length: PER }, (_, i) => ({ listId: listIds[l], title: `todo ${l}-${i} some title text here`, done: i % 3 === 0, tags: ["a", "b"] }))))) as string[]));
for (let l = 0; l < LISTS; l++) {
  const base = l * PER;
  await exec.mutate((s: any) => s.insertMany("comments", Array.from({ length: 1200 }, (_, i) => ({ todoId: ids[base + (i % 400)], body: "comment " + i, score: i % 10 }))));
}
for (let c = 0; c < Math.max(1, Math.round(5 * SCALE)); c++) await exec.mutate((s: any) => s.insertMany("notes", Array.from({ length: 10000 }, (_, i) => ({ body: "note " + i, tag: "x", n: (i * 7) % 1000 }))));
const seeded = N + LISTS * 1200 + Math.max(1, Math.round(5 * SCALE)) * 10000;
const seedMs = performance.now() - t0;

// ---- measuring ----
const results: { op: string; p50?: number; p99?: number; perSec?: number; note?: string }[] = [];
const pct = (xs: number[], p: number) => xs.slice().sort((a, b) => a - b)[Math.min(xs.length - 1, Math.floor(xs.length * p))]!;
const rnd = (n: number) => Math.floor(Math.random() * n);
/** The last 600 todos are the ones the delete step removes; nothing else touches them. */
const LIVE = N - 600;
const want = (name: string) => !only || only.some((o) => name.includes(o));
async function lat(op: string, f: () => Promise<unknown>, n = 300) {
  if (!want(op)) return;
  for (let i = 0; i < Math.min(20, n); i++) await f();
  const xs: number[] = [];
  for (let i = 0; i < n; i++) {
    const s = performance.now();
    await f();
    xs.push(performance.now() - s);
  }
  results.push({ op, p50: pct(xs, 0.5), p99: pct(xs, 0.99) });
  console.log(op.padEnd(48), `p50 ${pct(xs, 0.5).toFixed(3).padStart(8)}  p99 ${pct(xs, 0.99).toFixed(3).padStart(8)} ms`);
}
async function rate(op: string, concurrency: number, f: () => Promise<unknown>) {
  if (!want(op)) return;
  for (let i = 0; i < 50; i++) await f();
  let done = 0;
  const end = performance.now() + SECONDS * 1000;
  await Promise.all(Array.from({ length: concurrency }, async () => { while (performance.now() < end) { await f(); done++; } }));
  const perSec = Math.round(done / SECONDS);
  results.push({ op, perSec });
  console.log(op.padEnd(48), `${perSec.toLocaleString().padStart(10)} ops/s`);
}
const read = (f: (s: any) => Promise<unknown>) => () => exec.read(f);
const mutate = (f: (s: any) => Promise<unknown>) => () => exec.mutate(f);
const byList = (s: any, l = rnd(LISTS)) => s.query("todos").withIndex("by_list", (x: any) => x.eq("listId", listIds[l]));
let k = 0;

console.log(`${kind}: ${seeded.toLocaleString()} documents seeded in ${(seedMs / 1000).toFixed(1)} s (${Math.round(seeded / (seedMs / 1000)).toLocaleString()} docs/s through insertMany)`);
results.push({ op: "seed (docs/s)", perSec: Math.round(seeded / (seedMs / 1000)) });

await lat("read: get(id)", read((s) => s.get(ids[rnd(LIVE)])), 500);
await lat("read: getMany(50)", read((s) => s.getMany(Array.from({ length: 50 }, () => ids[rnd(LIVE)]))));
await lat("read: withIndex.take(100)", read((s) => byList(s).take(100)));
await lat("read: withIndex.collect() 2000 docs", read((s) => byList(s).collect()), 80);
await lat("read: paginate(100)", read((s) => byList(s).paginate({ numItems: 100, cursor: null })));
await lat("read: count() 2000 docs", read((s) => byList(s).count()));
await lat("read: where(eq done).collect()", read((s) => byList(s).where((b: any) => b.eq("done", true)).collect()), 60);
await lat("read: filter(done).collect()", read((s) => byList(s).filter((d: any) => d.done).collect()), 40);
await lat("read: orderBy(title).take(100)", read((s) => byList(s).orderBy([["title", "desc"]]).take(100)), 60);
await lat("read: select(['title']).collect()", read((s) => byList(s).select(["title"]).collect()), 60);
await lat("join: include forward (list) x100", read((s) => byList(s).include({ list: "listId" }).take(100)));
await lat("join: include reverse all x100", read((s) => byList(s).include({ comments: { table: "comments", index: "by_todo" } }).take(100)), 150);
await lat("join: include reverse take:2 x100", read((s) => byList(s).include({ comments: { table: "comments", index: "by_todo", take: 2 } }).take(100)), 100);
await lat("join: include reverse count x100", read((s) => byList(s).include({ comments: { table: "comments", index: "by_todo", count: true } }).take(100)), 150);
const nq = (s: any) => s.query("notes").withIndex("by_tag_n", (x: any) => x.eq("tag", "x"));
await lat("agg: sum(n) notes", read((s) => nq(s).sum("n")), 15);
await lat("agg: avg(n) notes", read((s) => nq(s).avg("n")), 15);
await lat("agg: min/max(n) notes", read(async (s) => [await nq(s).min("n"), await nq(s).max("n")]), 15);
await lat("write: insert 1", mutate((s) => s.insert("todos", { listId: listIds[rnd(LISTS)], title: "new " + k++, done: false })), 300);
await lat("write: patch 1", mutate((s) => s.patch(ids[rnd(LIVE)], { title: "t" + k++ })), 300);
await lat("write: patch 1 (indexed field)", mutate((s) => s.patch(ids[rnd(LIVE)], { done: k++ % 2 === 0 })), 300);
await lat("write: delete 1", mutate((s) => s.delete(ids[LIVE + k++ % 600]!)), 300);
await lat("write: insertMany 100", mutate((s) => s.insertMany("comments", Array.from({ length: 100 }, (_, i) => ({ todoId: ids[rnd(LIVE)], body: "c" + i, score: i % 10 })))), 60);
await lat("write: insertMany 1000", mutate((s) => s.insertMany("comments", Array.from({ length: 1000 }, (_, i) => ({ todoId: ids[rnd(LIVE)], body: "c" + i, score: i % 10 })))), 15);
await lat("write: updateMany 100", mutate((s) => s.updateMany("todos", Array.from({ length: 100 }, () => ({ id: ids[LIVE / 2 + rnd(LIVE / 2 - 1)]!, patch: { title: "u" + k++ } })))), 40);
await rate("throughput: get(id), 64 concurrent", 64, read((s) => s.get(ids[rnd(LIVE)])));
await rate("throughput: take(100), 32 concurrent", 32, read((s) => byList(s).take(100)));
await rate("throughput: patch 1, 32 concurrent", 32, mutate((s) => s.patch(ids[rnd(LIVE)], { title: "w" + k++ })));
await rate("throughput: insert 1, 32 concurrent", 32, mutate((s) => s.insert("todos", { listId: listIds[rnd(LISTS)], title: "w" + k++, done: false })));
await rate("throughput: 90% read / 10% write, 64 concurrent", 64, () => (Math.random() < 0.1 ? exec.mutate((s: any) => s.patch(ids[rnd(LIVE)], { title: "m" + k++ })) : exec.read((s: any) => s.get(ids[rnd(LIVE)]))));

if (process.env.JSON) writeFileSync(process.env.JSON, JSON.stringify({ db: kind, seeded, scale: SCALE, results }, null, 1));
await db.close();
process.exit(0);
