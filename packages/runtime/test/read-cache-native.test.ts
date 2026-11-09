import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { nativeDb } from "../src/server/db/native";
import { createNativeSqliteDb } from "../src/server/db/sqlite-native";
import type { Db } from "../src/server/db/types";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";
import { ReadCache } from "../src/server/read-cache";
import { tempDir } from "./helpers";

// The native engine's read cache, held to the rules of the JavaScript one (read-cache.test.ts): what reached the database is told by the engine's counters.
const native = nativeDb();
let db: Db;
let exec: Executor;

const stats = () => JSON.parse(db.engine!.cacheStats()) as { hits: number; misses: number };

describe.skipIf(!native)("the native engine's read cache", () => {
  beforeEach(async () => {
    const project = await loadProject(join(import.meta.dir, "fixture"));
    db = createNativeSqliteDb(join(tempDir(), "app.db"), native!);
    await db.migrate(tableSpecs(project.tables));
    exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {}, readCache: new ReadCache() });
  });
  afterEach(() => db.close());

  const titles = async (listId: string) => (await exec.read((s) => s.query("todos").withIndex("by_list", (q: any) => q.eq("listId", listId)).collect())).value.map((t: any) => t.title);

  test("a repeated read is answered from the cache, and a write to its table is seen at once", async () => {
    const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
    await exec.mutate((s) => s.insert("todos", { listId, title: "a", done: false }));
    expect(await titles(listId)).toEqual(["a"]);
    const before = stats();
    expect(await titles(listId)).toEqual(["a"]);
    expect(stats()).toEqual({ hits: before.hits + 1, misses: before.misses }); // from the cache
    await exec.mutate((s) => s.insert("todos", { listId, title: "b", done: false }));
    expect(await titles(listId)).toEqual(["a", "b"]);
    expect(stats().misses).toBe(before.misses + 1);
  });

  test("a write to another table keeps entries; a mutation sees its own writes, not the cache", async () => {
    const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
    await exec.read((s) => s.get(listId));
    const before = stats();
    await exec.mutate((s) => s.insert("todos", { listId, title: "x", done: false })); // todos, not lists
    await exec.read((s) => s.get(listId));
    expect(stats().misses).toBe(before.misses); // lists entry kept
    const seen = await exec.mutate(async (s) => {
      await s.patch(listId, { name: "renamed" });
      return (await s.get(listId))!.name;
    });
    expect(seen).toBe("renamed");
    expect((await exec.read((s) => s.get(listId))).value!.name).toBe("renamed");
  });

  test("a query that used cached text re-runs rather than read a newer snapshot after a commit", async () => {
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
    const before = stats();
    await exec.mutate((s) => s.insert("todos", { listId: b, title: "b1", done: false })); // only list b's todos change
    expect(await titles(a)).toEqual(["a1"]);
    expect(stats().misses).toBe(before.misses); // a's entry survived
    expect(await titles(b)).toEqual(["b1"]);
    expect(stats().misses).toBe(before.misses + 1);
  });

  test("the cache can be switched off, and then every read reaches the database", async () => {
    const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
    await exec.read((s) => s.get(listId));
    exec.setReadCache(undefined);
    const before = stats();
    await exec.read((s) => s.get(listId));
    await exec.read((s) => s.get(listId));
    expect(stats().misses).toBe(before.misses + 2);
    exec.setReadCache(new ReadCache());
  });
});
