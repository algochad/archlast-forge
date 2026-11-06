import { afterEach, describe, expect, test } from "bun:test";
import { DocStore, type TablesSpec } from "../src/server/docstore";
import type { Db, DbTx } from "../src/server/db/types";
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
      const indexNames = async (table: string) => (db.dialect.name === "mongodb" ? ((await (db as any).indexNames(table)) as string[]) : (await db.query<{ name: string }>(db.dialect.listIndexesSql, [table])).map((r) => r.name)).filter((n) => n.startsWith("afx_"));
      const before = await indexNames("todos");
      expect(before.length).toBe(3); // by_creation_time + 2
      await db.migrate([{ name: "todos", indexes: { by_list: ["listId"] } }]);
      const after = await indexNames("todos");
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
      if (db.dialect.name === "mongodb") {
        // A cursor comes from the client: an operator in it is a value to compare with, not part of the filter ({ "$ne": null } matched every row).
        const forged = JSON.parse(Buffer.from(first.continueCursor, "base64url").toString());
        forged[0] = { $ne: null };
        forged[1] = 0;
        const cursor = Buffer.from(JSON.stringify(forged)).toString("base64url");
        const page: any = await read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "odd")).paginate({ numItems: 10, cursor }));
        expect(ns(page.page)).toEqual([]);
      }
    });

    test("skip: numbered pages, skipped in the database unless a filter has to see them", async () => {
      db = await make();
      if (db.dialect.name === "mongodb") return; // inspects the SQL statements; MongoDB's version is in db-adapters.test.ts
      await db.migrate(specs);
      for (let n = 1; n <= 10; n++) await write((s) => s.insert("notes", { body: `note ${n}`, tag: n % 2 ? "odd" : "even", n }));
      const ns = (docs: any[]) => docs.map((d) => d.n);
      // Every statement the query sends, and how many rows come back.
      const traced = async <T>(fn: (s: DocStore) => Promise<T>) => {
        const sql: string[] = [];
        let rows = 0;
        const result = await db.transaction("read", (tx) =>
          fn(new DocStore({ query: async (q: string, p?: unknown[]) => (sql.push(q), tx.query(q, p).then((r) => ((rows += r.length), r))), execute: tx.execute } as DbTx, db.dialect, tables)),
        );
        return { result, sql, rows };
      };
      const byN = (s: DocStore) => s.query("notes").withIndex("by_n");

      const page3 = await traced((s) => byN(s).skip(4).take(3));
      expect(ns(page3.result)).toEqual([5, 6, 7]);
      expect(page3.rows).toBe(3); // the four before were never loaded
      expect(page3.sql).toEqual([expect.stringContaining("LIMIT 3 OFFSET 4")]);
      expect(ns(await read((s) => byN(s).order("desc").skip(4).take(3)))).toEqual([6, 5, 4]);
      expect(ns(await read((s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "odd")).skip(1).take(2)))).toEqual([3, 5]);
      expect(ns(await read((s) => byN(s).skip(8).collect()))).toEqual([9, 10]);
      expect((await read((s) => byN(s).skip(2).first()))?.n).toBe(3);

      // With a filter, skip counts the documents that pass it, wherever it is in the chain.
      expect(ns(await read((s) => byN(s).filter((d: any) => d.tag === "even").skip(2).take(2)))).toEqual([6, 8]);
      expect(ns(await read((s) => byN(s).skip(2).filter((d: any) => d.tag === "even").take(2)))).toEqual([6, 8]);

      // Counts and aggregates see what's left after the skip.
      expect(await read((s) => byN(s).skip(3).count())).toBe(7);
      expect(await read((s) => byN(s).skip(20).count())).toBe(0);
      expect(await read((s) => byN(s).filter((d: any) => d.tag === "even").skip(1).count())).toBe(4);
      expect(await read((s) => byN(s).skip(8).sum("n"))).toBe(19);

      // Past the end: an empty page.
      expect(await read((s) => byN(s).skip(20).take(5))).toEqual([]);
      const past: any = await read((s) => byN(s).skip(20).paginate({ numItems: 3, cursor: null }));
      expect(past).toMatchObject({ page: [], isDone: true });
      const last: any = await read((s) => byN(s).skip(9).paginate({ numItems: 3, cursor: null }));
      expect(last).toMatchObject({ page: [expect.objectContaining({ n: 10 })], isDone: true });

      // With paginate(), skip places the first page and the cursor carries on from there.
      const first: any = await read((s) => byN(s).skip(2).paginate({ numItems: 3, cursor: null }));
      expect(ns(first.page)).toEqual([3, 4, 5]);
      const next: any = await read((s) => byN(s).skip(2).paginate({ numItems: 3, cursor: first.continueCursor }));
      expect(ns(next.page)).toEqual([6, 7, 8]);

      await expect(read((s) => byN(s).skip(-1).take(1))).rejects.toThrow("skip() expects a non-negative integer, got -1");
      await expect(read((s) => byN(s).skip(1.5).take(1))).rejects.toThrow("skip() expects a non-negative integer, got 1.5");
      await expect(read((s) => byN(s).skip(60_000).skip(60_000).take(1))).rejects.toThrow("skip() passes over at most 100000 documents, got 120000");
    });

    test("paginate takes a cursor, an offset or both, and can count the range", async () => {
      db = await make();
      await db.migrate(specs);
      for (let n = 1; n <= 10; n++) await write((s) => s.insert("notes", { body: `note ${n}`, tag: n % 2 ? "odd" : "even", n }));
      const ns = (r: any) => r.page.map((d: any) => d.n);
      const page = (opts: any, q = (s: DocStore) => s.query("notes").withIndex("by_n")) => read((s) => q(s).paginate(opts)) as Promise<any>;

      // Numbered: page 2 of 4, with the total; a cursor from it carries on with keyset paging.
      const p2 = await page({ numItems: 3, cursor: null, offset: 3, withTotal: true });
      expect(ns(p2)).toEqual([4, 5, 6]);
      expect(p2).toMatchObject({ isDone: false, total: 10 });
      expect(ns(await page({ numItems: 3, cursor: p2.continueCursor }))).toEqual([7, 8, 9]);
      expect(await page({ numItems: 3, cursor: null, offset: 9, withTotal: true })).toMatchObject({ page: [expect.objectContaining({ n: 10 })], isDone: true, total: 10 });
      expect(await page({ numItems: 3, cursor: null, offset: 30 })).toMatchObject({ page: [], isDone: true });
      // An offset counts from the cursor; skip() and an offset add up on the first page.
      expect(ns(await page({ numItems: 2, cursor: p2.continueCursor, offset: 1 }))).toEqual([8, 9]);
      expect(ns(await page({ numItems: 2, cursor: null, offset: 2 }, (s) => s.query("notes").withIndex("by_n").skip(1)))).toEqual([4, 5]);
      // Without withTotal there is no total; with a filter, the total counts what passes it.
      expect(await page({ numItems: 2, cursor: null })).not.toHaveProperty("total");
      const evens = await page({ numItems: 2, cursor: null, offset: 2, withTotal: true }, (s) => s.query("notes").withIndex("by_n").filter((d: any) => d.tag === "even"));
      expect(ns(evens)).toEqual([6, 8]);
      expect(evens.total).toBe(5);
      expect((await page({ numItems: 2, cursor: null, withTotal: true }, (s) => s.query("notes").withIndex("by_n").skip(4))).total).toBe(10); // the range, not what's left

      await expect(page({ numItems: 2, cursor: null, offset: -1 })).rejects.toThrow("paginate() offset must be a non-negative integer, got -1");
      await expect(page({ numItems: 2, cursor: null, offset: 100_001 })).rejects.toThrow("paginate() passes over at most 100000 documents, got 100001");
    });

    test("where(): predicates run in the database, and rows they reject are never loaded", async () => {
      db = await make();
      if (db.dialect.name === "mongodb") return; // inspects the SQL statements; MongoDB's version is in db-adapters.test.ts
      await db.migrate(specs);
      const tags = ["alpha", "beta", "Alpine", "gamma", "alps"];
      for (let n = 1; n <= 10; n++) await write((s) => s.insert("notes", { body: `note ${n}`, tag: tags[n % 5]!, n }));
      const ns = (docs: any[]) => docs.map((d) => d.n);
      const where = (build: (q: any) => any, q = (s: DocStore) => s.query("notes").withIndex("by_n")) => read<any[]>((s) => (q(s) as any).where(build).collect()).then(ns);

      expect(await where((q) => q.eq("tag", "beta"))).toEqual([1, 6]);
      expect(await where((q) => q.gt("n", 8))).toEqual([9, 10]);
      expect(await where((q) => q.lte("n", 2))).toEqual([1, 2]);
      expect(await where((q) => q.between("n", 4, 6))).toEqual([4, 5, 6]);
      expect(await where((q) => q.in("n", [2, 7, 99]))).toEqual([2, 7]);
      expect(await where((q) => q.in("n", []))).toEqual([]);
      expect(await where((q) => q.prefix("tag", "alp"))).toEqual([4, 5, 9, 10]); // case-sensitive: not "Alpine"
      expect(await where((q) => q.or(q.eq("n", 1), q.and(q.gt("n", 5), q.prefix("tag", "gam"))))).toEqual([1, 8]);
      expect(await where((q) => q.not(q.lt("n", 9)))).toEqual([9, 10]);
      expect(await where((q) => q.and(q.neq("tag", "alpha"), q.neq("tag", "alps"), q.gt("n", 4)))).toEqual([6, 7, 8]);
      expect(await where((q) => q.eq("n", 3)).then(() => where((q) => q.gt("_creationTime", 0)))).toHaveLength(10);
      // With an index range, a second where(), skip, count and pages: all of it in SQL.
      expect(await where((q) => q.gte("n", 3), (s) => s.query("notes").withIndex("by_n", (q: any) => q.lte("n", 6)))).toEqual([3, 4, 5, 6]);
      expect(ns(await read((s) => (s.query("notes") as any).where((q: any) => q.gt("n", 2)).where((q: any) => q.lt("n", 6)).skip(1).take(2)))).toEqual([4, 5]);
      expect(await read((s) => (s.query("notes") as any).where((q: any) => q.prefix("tag", "a")).count())).toBe(4);
      const seen: number[] = [];
      for (let cursor: string | null = null; ; ) {
        const page: any = await read((s) => (s.query("notes").withIndex("by_n") as any).where((q: any) => q.neq("tag", "beta")).paginate({ numItems: 3, cursor }));
        seen.push(...ns(page.page));
        if (page.isDone) break;
        cursor = page.continueCursor;
      }
      expect(seen).toEqual([2, 3, 4, 5, 7, 8, 9, 10]);
      // Only the matching rows come back from the database.
      let rows = 0;
      await db.transaction("read", (tx) =>
        (new DocStore({ query: (q: string, p?: unknown[]) => tx.query(q, p).then((r) => ((rows += r.length), r)), execute: tx.execute } as DbTx, db.dialect, tables).query("notes") as any)
          .where((q: any) => q.eq("tag", "gamma"))
          .collect(),
      );
      expect(rows).toBe(2);

      await expect(read((s) => (s.query("notes") as any).where((q: any) => q.eq("n; DROP TABLE notes", 1)).collect())).rejects.toThrow("is not a field name");
      await expect(read((s) => (s.query("notes") as any).where((q: any) => q.eq("nope", 1)).collect())).rejects.toThrow('"nope" is not a field of "notes"');
      await expect(read((s) => (s.query("notes") as any).where(() => ({ sql: "1 = 1", params: [] })).collect())).rejects.toThrow("must return a predicate");
    });

    test("orderBy() sorts by several keys each way, pages cover everything once, and select() keeps what's asked", async () => {
      db = await make();
      await db.migrate(specs);
      for (let n = 1; n <= 9; n++) await write((s) => s.insert("notes", { body: `b${n}`, tag: ["x", "y", "z"][n % 3]!, n }));
      const pairs = (docs: any[]) => docs.map((d) => `${d.tag}${d.n}`);
      const sorted = (s: DocStore) => (s.query("notes") as any).orderBy([["tag", "desc"], ["n", "asc"]]);
      const want = ["z2", "z5", "z8", "y1", "y4", "y7", "x3", "x6", "x9"];
      expect(pairs(await read((s) => sorted(s).collect()))).toEqual(want);
      expect(pairs(await read((s) => sorted(s).order("desc").collect()))).toEqual([...want].reverse());
      for (const order of ["asc", "desc"] as const) {
        const seen: string[] = [];
        for (let cursor: string | null = null; ; ) {
          const page: any = await read((s) => sorted(s).order(order).paginate({ numItems: 2, cursor }));
          seen.push(...pairs(page.page));
          if (page.isDone) break;
          cursor = page.continueCursor;
        }
        expect(seen).toEqual(order === "asc" ? want : [...want].reverse());
      }
      const slim: any[] = await read((s) => (s.query("notes").withIndex("by_n") as any).select(["n"]).take(2));
      expect(slim.map((d) => Object.keys(d).sort())).toEqual([["_creationTime", "_id", "n"], ["_creationTime", "_id", "n"]]);
      await expect(read((s) => (s.query("notes") as any).orderBy([["n", "up"]]).collect())).rejects.toThrow('orderBy() expects [field, "asc" | "desc"] pairs');
      await expect(read((s) => (s.query("notes") as any).select([]).collect())).rejects.toThrow("select() expects field names");
    });

    test("insertMany and updateMany validate every row first: all or nothing, or partial with the reasons", async () => {
      db = await make();
      await db.migrate(specs);
      const ids: string[] = await write((s: any) => s.insertMany("notes", [1, 2, 3].map((n) => ({ body: `b${n}`, tag: "t", n }))));
      expect(ids).toHaveLength(3);
      expect((await read((s) => s.query("notes").collect())).map((d: any) => d.n)).toEqual([1, 2, 3]); // in the order given
      await expect(write((s: any) => s.insertMany("notes", [{ body: "ok", tag: "t", n: 4 }, { body: "bad", tag: "t", n: "five" }]))).rejects.toThrow(
        'insertMany() on "notes": 1 of 2 documents are invalid, so none was inserted. Document 1: notes.n must be a finite number',
      );
      expect(await read((s) => s.query("notes").count())).toBe(3);
      const partial: any = await write((s: any) => s.insertMany("notes", [{ body: "ok", tag: "t", n: 4 }, { body: "bad", tag: "t" }], { mode: "partial" }));
      expect(partial.ids[0]).toMatch(/^notes:/);
      expect(partial.ids[1]).toBeNull();
      expect(partial.errors).toEqual([{ index: 1, message: expect.stringContaining("notes.n") }]);

      await write((s: any) => s.updateMany("notes", [{ id: ids[0], patch: { tag: "u" } }, { id: ids[0], patch: { n: 10 } }, { id: ids[1], patch: { tag: "u" } }]));
      expect(await read((s) => s.get(ids[0]!))).toMatchObject({ tag: "u", n: 10 }); // the second update applies on top of the first
      await expect(write((s: any) => s.updateMany("notes", [{ id: ids[2], patch: { tag: "v" } }, { id: ids[1], patch: { n: "x" } }]))).rejects.toThrow("so none was applied. Update 1");
      expect(await read((s) => s.get(ids[2]!))).toMatchObject({ tag: "t" });
      const result: any = await write((s: any) => s.updateMany("notes", [{ id: ids[2], patch: { tag: "v" } }, { id: "notes:missing", patch: { n: 1 } }, { id: ids[0], patch: { n: "x" } }], { mode: "partial" }));
      expect(result.errors.map((e: any) => e.index)).toEqual([1, 2]);
      expect(result.errors[0].message).toContain("not found");
      expect(await read((s) => s.get(ids[2]!))).toMatchObject({ tag: "v" });
      await expect(write((s: any) => s.insertMany("notes", [], { mode: "some" }))).rejects.toThrow('mode must be "all" or "partial"');
      await expect(read((s: any) => s.insertMany("notes", []))).rejects.toThrow("read-only");
    });

    test("skip with include joins only the documents returned", async () => {
      db = await make();
      if (db.dialect.name === "mongodb") return; // inspects the SQL statements; MongoDB's version is in db-adapters.test.ts
      await db.migrate(specs);
      for (let i = 0; i < 5; i++) {
        const listId = await write((s) => s.insert("lists", { name: `list ${i}` }));
        await write((s) => s.insert("todos", { listId, title: `todo ${i}`, done: false }));
      }
      const listReads: unknown[][] = [];
      const docs: any[] = await db.transaction("read", (tx) =>
        new DocStore(
          { query: (q: string, p?: unknown[]) => (q.includes('FROM "lists"') && listReads.push(p ?? []), tx.query(q, p)), execute: tx.execute },
          db.dialect,
          tables,
        )
          .query("todos")
          .skip(3)
          .include({ list: "listId" })
          .take(1),
      );
      expect(docs.map((d) => [d.title, d.list.name])).toEqual([["todo 3", "list 3"]]);
      expect(listReads).toEqual([[docs[0].listId]]); // one list looked up, not four
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
