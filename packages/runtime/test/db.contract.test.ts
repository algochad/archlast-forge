import { afterEach, describe, expect, test } from "bun:test";
import { DocStore, type TablesSpec } from "../src/server/docstore";
import type { Db } from "../src/server/db/types";
import { v } from "../src/values";
import { dbAdapters } from "./helpers";

const tables: TablesSpec = {
  lists: { fields: { name: v.string() }, indexes: {}, strict: true },
  todos: {
    fields: { listId: v.id("lists"), title: v.string(), done: v.boolean(), n: v.optional(v.number()) },
    indexes: { by_list: ["listId"], by_list_done: ["listId", "done"] },
    strict: true,
  },
  notes: {
    fields: { body: v.string(), tag: v.string(), n: v.number() },
    indexes: { by_n: ["n"], by_tag_n: ["tag", "n"] },
    searchIndexes: { search_body: { searchField: "body", filterFields: ["tag"] } },
    strict: true,
  },
};
const specs = Object.entries(tables).map(([name, t]) => ({ name, indexes: t.indexes, searchIndexes: t.searchIndexes }));

for (const [label, make] of dbAdapters) {
  describe(`Db contract: ${label}`, () => {
    let db: Db;
    afterEach(() => db?.close());

    const write = <T>(fn: (s: DocStore) => Promise<T>) =>
      db.transaction("write", (tx) => fn(new DocStore(tx, db.dialect, tables, new Set(), new Set())));
    const read = <T>(fn: (s: DocStore) => Promise<T>) => db.transaction("read", (tx) => fn(new DocStore(tx, db.dialect, tables)));

    test("migrate is idempotent and syncs indexes", async () => {
      db = await make();
      await db.migrate(specs);
      await db.migrate(specs);
      const before = (await db.query<{ name: string }>(db.dialect.listIndexesSql, ["todos"])).filter((r) => r.name.startsWith("afx_"));
      expect(before.length).toBe(3); // by_creation_time + 2
      await db.migrate([{ name: "todos", indexes: { by_list: ["listId"] } }]);
      const after = (await db.query<{ name: string }>(db.dialect.listIndexesSql, ["todos"])).filter((r) => r.name.startsWith("afx_"));
      expect(after.length).toBe(2);
    });

    test("insert, get, index queries, patch, replace, delete", async () => {
      db = await make();
      await db.migrate(specs);
      const listId = await write((s) => s.insert("lists", { name: "home" }));
      const other = await write((s) => s.insert("lists", { name: "work" }));
      expect(listId).toMatch(/^lists:[0-9a-f]{32}$/);
      const a = await write((s) => s.insert("todos", { listId, title: "a", done: false, n: 1 }));
      await write((s) => s.insert("todos", { listId, title: "b", done: true }));
      await write((s) => s.insert("todos", { listId: other, title: "c", done: false }));

      expect(await read((s) => s.get(a))).toMatchObject({ _id: a, title: "a", n: 1 });
      const inList = await read((s) => s.query("todos").withIndex("by_list", (q: any) => q.eq("listId", listId)).collect());
      expect(inList.map((d) => d.title)).toEqual(["a", "b"]);
      const open = await read((s) => s.query("todos").withIndex("by_list_done", (q: any) => q.eq("listId", listId).eq("done", false)).collect());
      expect(open.map((d) => d.title)).toEqual(["a"]);
      expect((await read((s) => s.query("todos").take(2))).length).toBe(2);
      expect((await read((s) => s.query("todos").first()))?.title).toBe("a");

      await write((s) => s.patch(a, { title: "a2", n: undefined }));
      const patched = await read((s) => s.get(a));
      expect(patched?.title).toBe("a2");
      expect("n" in patched!).toBe(false);
      await write((s) => s.replace(a, { listId, title: "a3", done: true }));
      expect((await read((s) => s.get(a)))?.done).toBe(true);
      await write((s) => s.delete(a));
      expect(await read((s) => s.get(a))).toBeNull();
    });

    test("writes are validated against the schema", async () => {
      db = await make();
      await db.migrate(specs);
      const listId = await write((s) => s.insert("lists", { name: "x" }));
      await expect(write((s) => s.insert("todos", { listId, title: 1, done: false }))).rejects.toThrow("todos.title must be a string");
      await expect(write((s) => s.insert("todos", { listId: "todos:abc", title: "t", done: false }))).rejects.toThrow('Id<"lists">');
      await expect(write((s) => s.insert("todos", { listId, title: "t", done: false, extra: 1 }))).rejects.toThrow("not in the validator");
      await expect(write((s) => s.insert("nope", {}))).rejects.toThrow('Unknown table "nope"');
    });

    test("a failed write transaction rolls back", async () => {
      db = await make();
      await db.migrate(specs);
      await expect(
        write(async (s) => {
          await s.insert("lists", { name: "ghost" });
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await read((s) => s.query("lists").collect())).toEqual([]);
    });

    test("queries can't write", async () => {
      db = await make();
      await db.migrate(specs);
      await expect(read((s) => s.insert("lists", { name: "x" }))).rejects.toThrow("read-only");
    });

    test("read and write topics", async () => {
      db = await make();
      await db.migrate(specs);
      const listId = await write((s) => s.insert("lists", { name: "x" }));
      const reads = new Set<string>();
      await db.transaction("read", async (tx) => {
        const s = new DocStore(tx, db.dialect, tables, reads);
        await s.query("todos").withIndex("by_list", (q: any) => q.eq("listId", listId)).collect();
        await s.query("lists").collect();
        await s.get(listId);
      });
      expect([...reads].sort()).toEqual([`lists`, `lists:by_id:["${listId}"]`, `todos:by_list:["${listId}"]`].sort());

      const writes = new Set<string>();
      const id = await db.transaction("write", (tx) =>
        new DocStore(tx, db.dialect, tables, new Set(), writes).insert("todos", { listId, title: "t", done: false }),
      );
      expect([...writes].sort()).toEqual(
        [
          "todos",
          `todos:by_id:["${id}"]`,
          `todos:by_list:["${listId}"]`,
          `todos:by_list_done:["${listId}"]`,
          `todos:by_list_done:["${listId}",false]`,
        ].sort(),
      );
    });

    test("a read transaction is one consistent snapshot", async () => {
      db = await make();
      await db.migrate(specs);
      if (db.dialect.name === "sqlite" && (await db.query("PRAGMA database_list"))[0]?.file === "") return; // :memory: serializes everything
      await write((s) => s.insert("lists", { name: "first" }));
      let concurrentWrite!: Promise<unknown>;
      const counts = await read(async (s) => {
        const before = (await s.query("lists").collect()).length;
        concurrentWrite = write((w) => w.insert("lists", { name: "second" }));
        await concurrentWrite;
        const after = (await s.query("lists").collect()).length;
        return [before, after];
      });
      expect(counts).toEqual([1, 1]);
      expect((await read((s) => s.query("lists").collect())).length).toBe(2);
    });
  
    test("range bounds, order and pagination", async () => {
      db = await make();
      await db.migrate(specs);
      for (let n = 1; n <= 10; n++) await write((s) => s.insert("notes", { body: `note ${n}`, tag: n % 2 ? "odd" : "even", n }));
      const ns = (docs: any[]) => docs.map((d) => d.n);
      expect(ns(await read((s) => s.query("notes").withIndex("by_n", (q: any) => q.gt("n", 3).lte("n", 6)).collect()))).toEqual([4, 5, 6]);
      expect(ns(await read((s) => s.query("notes").withIndex("by_n", (q: any) => q.gte("n", 8)).order("desc").collect()))).toEqual([10, 9, 8]);
      expect(ns(await read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "even").lt("n", 7)).collect()))).toEqual([2, 4, 6]);
      expect(ns(await read((s) => s.query("notes").order("desc").take(2)))).toEqual([10, 9]);
      await expect(read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.gt("n", 1)).collect())).rejects.toThrow("must be on");

      // Pages cover everything exactly once, ascending and descending.
      for (const order of ["asc", "desc"] as const) {
        const seen: number[] = [];
        let cursor: string | null = null;
        for (;;) {
          const page: any = await read((s) => s.query("notes").withIndex("by_n").order(order).paginate({ numItems: 3, cursor }));
          seen.push(...ns(page.page));
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
        expect(seen).toEqual(order === "asc" ? [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] : [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
      }
      const first: any = await read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "odd")).paginate({ numItems: 2, cursor: null }));
      expect(ns(first.page)).toEqual([1, 3]);
      // Inserting before the cursor doesn't shift the next page.
      await write((s) => s.insert("notes", { body: "zero", tag: "odd", n: 0 }));
      const second: any = await read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "odd")).paginate({ numItems: 2, cursor: first.continueCursor }));
      expect(ns(second.page)).toEqual([5, 7]);
      await expect(read((s) => s.query("notes").paginate({ numItems: 2, cursor: "garbage" }))).rejects.toThrow("Invalid pagination cursor");
    });

    test("full-text search with filters stays in sync with writes", async () => {
      db = await make();
      await db.migrate(specs);
      const a = await write((s) => s.insert("notes", { body: "Buy oat milk today", tag: "home", n: 1 }));
      await write((s) => s.insert("notes", { body: "Milkshake recipe", tag: "food", n: 2 }));
      await write((s) => s.insert("notes", { body: "Call the bank", tag: "home", n: 3 }));
      const search = (text: string, tag?: string) =>
        read((s) => s.query("notes").withSearchIndex("search_body", (q: any) => (tag ? q.search("body", text).eq("tag", tag) : q.search("body", text))).take(10)).then((d) => d.map((x: any) => x.n).sort());
      expect(await search("milk")).toEqual([1, 2]); // last term matches as a prefix
      expect(await search("milk", "home")).toEqual([1]);
      expect(await search("oat milk")).toEqual([1]); // every term must match
      expect(await search("  ")).toEqual([]);
      await write((s) => s.patch(a, { body: "Buy bread" }));
      expect(await search("milk")).toEqual([2]);
      await write((s) => s.delete(a));
      expect(await search("bread")).toEqual([]);
      // Re-running migrations keeps the index and backfills nothing twice.
      await db.migrate(specs);
      expect(await search("bank")).toEqual([3]);
    });

    test("documents over the size limit are rejected", async () => {
      db = await make();
      await db.migrate(specs);
      const store = (tx: any) => new DocStore(tx, db.dialect, tables, new Set(), new Set(), 100);
      await expect(db.transaction("write", (tx) => store(tx).insert("notes", { body: "x".repeat(200), tag: "t", n: 1 }))).rejects.toThrow("MAX_DOCUMENT_BYTES");
    });

    test("a transaction handle refuses use after the transaction ends", async () => {
      db = await make();
      await db.migrate(specs);
      let leaked: any;
      await db.transaction("write", async (tx) => {
        leaked = tx;
      });
      await expect(Promise.resolve().then(() => leaked.query(`SELECT 1`))).rejects.toThrow("Transaction already finished");
    });
  });
}
