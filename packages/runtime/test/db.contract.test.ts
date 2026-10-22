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
};
const specs = Object.entries(tables).map(([name, t]) => ({ name, indexes: t.indexes }));

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
  });
}
