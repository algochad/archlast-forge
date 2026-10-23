import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";
import { ReadCache } from "../src/server/read-cache";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
let db: Db;
let exec: Executor;
let cache: ReadCache;
let statements: string[];

beforeEach(async () => {
  const project = await loadProject(fixture);
  db = createSqliteDb(join(tempDir(), "app.db"));
  await db.migrate(tableSpecs(project.tables));
  cache = new ReadCache();
  statements = [];
  // Count the statements that reach the database, to see what the cache answered.
  const transaction = db.transaction.bind(db);
  db.transaction = ((mode: "read" | "write", fn: any) =>
    transaction(mode, (tx) => fn({ query: (sql: string, p?: unknown[]) => (statements.push(sql), tx.query(sql, p)), execute: tx.execute.bind(tx) }))) as Db["transaction"];
  exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {}, readCache: cache });
});
afterEach(() => db.close());

const titles = async (listId: string) => (await exec.read((s) => s.query("todos").withIndex("by_list", (q: any) => q.eq("listId", listId)).collect())).value.map((t: any) => t.title);

test("a repeated read is answered from the cache, and a write to its table is seen at once", async () => {
  const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
  await exec.mutate((s) => s.insert("todos", { listId, title: "a", done: false }));
  expect(await titles(listId)).toEqual(["a"]);
  const before = statements.length;
  expect(await titles(listId)).toEqual(["a"]);
  expect(statements.length).toBe(before); // from the cache
  await exec.mutate((s) => s.insert("todos", { listId, title: "b", done: false }));
  expect(await titles(listId)).toEqual(["a", "b"]);
  expect(statements.length).toBe(before + 1);
});

test("a write to another table keeps entries; a mutation sees its own writes, not the cache", async () => {
  const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
  await exec.read((s) => s.get(listId));
  const before = statements.length;
  await exec.mutate((s) => s.insert("todos", { listId, title: "x", done: false })); // todos, not lists
  await exec.read((s) => s.get(listId));
  expect(statements.length).toBe(before); // lists entry kept
  const seen = await exec.mutate(async (s) => {
    await s.patch(listId, { name: "renamed" });
    return (await s.get(listId))!.name;
  });
  expect(seen).toBe("renamed");
  expect((await exec.read((s) => s.get(listId))).value!.name).toBe("renamed");
});

test("a read whose snapshot predates a commit to its table neither stores nor uses entries for it", () => {
  const stamp = cache.now();
  cache.writing("todos"); // a write lands while that read is in flight...
  cache.set("k", "todos", [{ doc: "{}" }], cache.now(), ["todos"]);
  expect(cache.get("k", "todos", cache.now())).toBeUndefined(); // ...and while it is uncommitted, the table is off limits
  cache.settled("todos", ["todos"]);
  cache.set("k", "todos", [{ doc: "{}" }], stamp, ["todos"]); // the old snapshot can't store
  expect(cache.get("k", "todos", cache.now())).toBeUndefined();
  cache.set("k", "todos", [{ doc: "{}" }], cache.now(), ["todos"]); // a snapshot after the commit can
  expect(cache.get("k", "todos", cache.now())).toBeDefined();
  expect(cache.get("k", "todos", stamp)).toBeUndefined(); // but the old snapshot still can't use it
});

test("a query that used cached rows re-runs rather than read a newer snapshot after a commit", async () => {
  const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
  await exec.read((s) => s.get(listId)); // cached
  let runs = 0;
  const { value } = await exec.read(async (s) => {
    runs++;
    const list = await s.get(listId); // from the cache
    if (runs === 1) await exec.mutate((w) => w.insert("todos", { listId, title: "late", done: false })); // a commit lands mid-query
    const todos = await s.query("todos").withIndex("by_list", (q: any) => q.eq("listId", listId)).collect(); // needs the database
    return { list: list!.name, todos: todos.map((t: any) => t.title) };
  });
  expect(runs).toBe(2);
  expect(value).toEqual({ list: "l", todos: ["late"] });
});

test("concurrent mutations in one batch don't leave each other's uncommitted rows in the cache", async () => {
  const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
  const results = await Promise.allSettled([
    exec.mutate((s) => s.insert("todos", { listId, title: "kept", done: false })),
    exec.mutate(async (s) => {
      await s.insert("todos", { listId, title: "rolled back", done: false });
      throw new Error("no");
    }),
    exec.mutate(async (s) => (await s.query("todos").withIndex("by_list", (q: any) => q.eq("listId", listId)).collect()).map((t: any) => t.title)),
  ]);
  expect(results.map((r) => r.status)).toEqual(["fulfilled", "rejected", "fulfilled"]);
  expect((results[2] as PromiseFulfilledResult<string[]>).value).toEqual(["kept"]);
  expect(await titles(listId)).toEqual(["kept"]);
});

test("a write drops only the cached reads whose topics it wrote", async () => {
  const a = await exec.mutate((s) => s.insert("lists", { name: "a" }));
  const b = await exec.mutate((s) => s.insert("lists", { name: "b" }));
  await exec.mutate((s) => s.insert("todos", { listId: a, title: "a1", done: false }));
  await titles(a);
  await titles(b);
  const before = statements.length;
  await exec.mutate((s) => s.insert("todos", { listId: b, title: "b1", done: false })); // only list b's todos change
  expect(await titles(a)).toEqual(["a1"]);
  expect(statements.length).toBe(before); // a's entry survived
  expect(await titles(b)).toEqual(["b1"]);
  expect(statements.length).toBe(before + 1);
});
