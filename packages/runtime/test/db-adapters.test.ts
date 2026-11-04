// What the database adapters do for speed, checked against the slow, obvious way: the answer of a database's own aggregate against a loop over the
// documents, one statement for many parents against a query per parent, a bulk insert against what was inserted. Runs on every adapter.
import { afterEach, describe, expect, test } from "bun:test";
import type { Db, DbTx } from "../src/server/db/types";
import { DocStore, type TablesSpec } from "../src/server/docstore";
import { v } from "../src/values";
import { dbAdapters } from "./helpers";

const tables: TablesSpec = {
  lists: { fields: { name: v.string() }, indexes: {}, strict: true },
  todos: {
    fields: { listId: v.id("lists"), title: v.string(), done: v.boolean(), n: v.optional(v.number()) },
    indexes: { by_list: ["listId"], by_list_done: ["listId", "done"] },
    strict: true,
  },
  notes: { fields: { body: v.string(), tag: v.string(), n: v.number() }, indexes: { by_tag_n: ["tag", "n"] }, strict: true },
};
const specs = Object.entries(tables).map(([name, t]) => ({ name, indexes: t.indexes, searchIndexes: t.searchIndexes }));

for (const [label, make] of dbAdapters) {
  describe(`Adapter speed paths: ${label}`, () => {
    let db: Db;
    afterEach(() => db?.close());
    let statements: string[] = [];
    const spy = (tx: DbTx): DbTx => ({
      query: (q, p) => (statements.push(q), tx.query(q, p)),
      execute: (q, p) => (statements.push(q), tx.execute(q, p)),
    });
    const write = <T>(fn: (s: DocStore) => Promise<T>) => db.transaction("write", (tx) => fn(new DocStore(spy(tx), db.dialect, tables, new Set(), new Set())));
    const read = <T>(fn: (s: DocStore) => Promise<T>) => db.transaction("read", (tx) => fn(new DocStore(spy(tx), db.dialect, tables)));
    const setup = async () => {
      db = await make();
      await db.migrate(specs);
      statements = [];
    };
    /** Stores a document the way a loose table would: raw, so a field can hold anything. */
    let seq = 0;
    const raw = (doc: Record<string, unknown>) =>
      db.execute(`INSERT INTO "notes" ("_id", "_creationTime", "doc") VALUES (?, ?, ${db.dialect.jsonParam})`, [`notes:${String(++seq).padStart(6, "0")}`, seq, JSON.stringify({ body: "b", tag: "t", ...doc })]);
    const numbers = (xs: number[]) => ({ sum: xs.reduce((a, b) => a + b, 0), avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null, min: xs.length ? Math.min(...xs) : null, max: xs.length ? Math.max(...xs) : null });
    const aggregates = () =>
      read(async (s) => {
        const q = () => s.query("notes").withIndex("by_tag_n", (b: any) => b.eq("tag", "t"));
        return { sum: await q().sum("n"), avg: await q().avg("n"), min: await q().min("n"), max: await q().max("n") };
      });
    const documentsRead = () => statements.filter((q) => /"doc"/.test(q) && /SELECT "_id", "_creationTime", "doc"/.test(q)).length;

    describe("sum, avg, min and max", () => {
      test("integers, with nulls and missing fields, equal the loop, and no document is read", async () => {
        await setup();
        for (const n of [3, -7, 12, 0, 1, 1, 40]) await raw({ n });
        await raw({ n: null });
        await raw({});
        statements = [];
        expect(await aggregates()).toEqual(numbers([3, -7, 12, 0, 1, 1, 40]));
        if (db.dialect.numberStats) expect(documentsRead()).toBe(0);
      });

      test("an empty range: sum 0, the rest null", async () => {
        await setup();
        expect(await aggregates()).toEqual({ sum: 0, avg: null, min: null, max: null });
        await raw({});
        expect(await aggregates()).toEqual({ sum: 0, avg: null, min: null, max: null });
      });

      test("reals add as a loop adds them", async () => {
        await setup();
        for (const n of [0.1, 0.2, 0.3]) await raw({ n });
        const got = await aggregates();
        expect(got).toEqual(numbers([0.1, 0.2, 0.3])); // 0.6000000000000001
        expect(got.sum).not.toBe(0.6);
      });

      test("integers too big to add exactly are added as a loop adds them", async () => {
        await setup();
        const xs = [2 ** 53 - 1, 1, -(2 ** 53 - 1), 2 ** 52];
        for (const n of xs) await raw({ n });
        expect(await aggregates()).toEqual(numbers(xs));
      });

      test("a value that isn't a number is reported", async () => {
        await setup();
        await raw({ n: 1 });
        await raw({ n: "two" });
        for (const f of ["sum", "avg", "min", "max"] as const)
          await expect(read((s) => (s.query("notes") as any)[f]("n"))).rejects.toThrow('"notes.n" holds a string, not a number');
      });

      test("a boolean, an array and an object are not numbers either, 0 and 1 included", async () => {
        for (const bad of [true, false, [1], { a: 1 }]) {
          await setup();
          await raw({ n: 1 });
          await raw({ n: 0 });
          await raw({ n: bad });
          await expect(read((s) => s.query("notes").sum("n"))).rejects.toThrow(/holds a (boolean|object), not a number/);
          db.close();
        }
      });

      test("0 and 1 that are numbers still come from the database", async () => {
        await setup();
        for (const n of [1, 0, 1, 5]) await raw({ n });
        statements = [];
        expect(await aggregates()).toEqual(numbers([1, 0, 1, 5]));
        if (db.dialect.numberStats) expect(documentsRead()).toBe(0);
      });

      test("filter() and skip() read the documents; the range still decides what is added", async () => {
        await setup();
        for (const [n, tag] of [[1, "a"], [2, "a"], [3, "a"], [10, "b"]] as const) await raw({ n, tag });
        expect(await read((s) => s.query("notes").filter((d: any) => d.n > 1).sum("n"))).toBe(15);
        expect(await read((s) => s.query("notes").withIndex("by_tag_n").skip(1).sum("n"))).toBe(15);
        expect(await read((s) => s.query("notes").withIndex("by_tag_n", (b: any) => b.eq("tag", "a")).sum("n"))).toBe(6);
        expect(await read((s) => s.query("notes").withIndex("by_tag_n", (b: any) => b.eq("tag", "a").gt("n", 1)).max("n"))).toBe(3);
        expect(await read((s) => s.query("notes").where((b: any) => b.eq("tag", "b")).min("n"))).toBe(10);
      });
    });

    describe("includes", () => {
      const seed = async (parents: number, perParent: number) => {
        const lists: string[] = [];
        for (let i = 0; i < parents; i++) lists.push(await write((s) => s.insert("lists", { name: `list ${i}` })));
        for (const [i, listId] of lists.entries())
          await write((s) => s.insertMany("todos", Array.from({ length: (i * 3) % (perParent + 1) }, (_, k) => ({ listId, title: `t${i}.${k}`, done: k % 2 === 0, n: k }))));
        return lists;
      };
      const perParent = (lists: string[], take: number, order: "asc" | "desc") =>
        read(async (s) => Promise.all(lists.map((id) => s.query("todos").withIndex("by_list", (b: any) => b.eq("listId", id)).order(order).take(take))));

      for (const order of ["asc", "desc"] as const)
        for (const take of [1, 2, 5]) {
          test(`take ${take}, ${order}: the children of every parent equal a query for each`, async () => {
            await setup();
            const lists = await seed(23, 8);
            const got = await read((s) => s.query("lists").include({ todos: { table: "todos", index: "by_list", take, order } }).collect());
            expect(got.map((l: any) => l._id)).toEqual(lists);
            expect(got.map((l: any) => l.todos)).toEqual(await perParent(lists, take, order));
          });
        }

      test("take 0 and a parent with no children are empty lists; an include inside a take is applied", async () => {
        await setup();
        const lists = await seed(6, 4);
        const none = await read((s) => s.query("lists").include({ todos: { table: "todos", index: "by_list", take: 0 } }).collect());
        expect(none.map((l: any) => l.todos)).toEqual(lists.map(() => []));
        const nested = await read((s) => s.query("lists").include({ todos: { table: "todos", index: "by_list", take: 1, include: { list: "listId" } } }).collect());
        expect(nested[0]!.todos).toEqual([]); // 0 children
        expect(nested[1]!.todos[0].list._id).toBe(lists[1]);
      });

      test("counts equal a count for each parent", async () => {
        await setup();
        const lists = await seed(23, 8);
        const got = await read((s) => s.query("lists").include({ todos: { table: "todos", index: "by_list", count: true } }).collect());
        const expected = await read(async (s) => Promise.all(lists.map((id) => s.query("todos").withIndex("by_list", (b: any) => b.eq("listId", id)).count())));
        expect(got.map((l: any) => l.todos)).toEqual(expected);
      });

      test("where the database can do it in one statement, 23 parents are one statement, not 23", async () => {
        await setup();
        await seed(23, 8);
        statements = [];
        await read((s) => s.query("lists").include({ todos: { table: "todos", index: "by_list", take: 2 } }).collect());
        const reads = statements.filter((q) => q.includes('"todos"')).length;
        if (db.dialect.childrenOf) expect(reads).toBe(1);
        else expect(reads).toBeGreaterThan(1);
        statements = [];
        await read((s) => s.query("lists").include({ todos: { table: "todos", index: "by_list", count: true } }).collect());
        if (db.dialect.countChildren) expect(statements.filter((q) => q.includes('"todos"')).length).toBe(1);
      });
    });

    describe("writes and scans", () => {
      test("insertMany across the size of one statement keeps every document, whatever is in it", async () => {
        await setup();
        const listId = await write((s) => s.insert("lists", { name: "l" }));
        const titles = Array.from({ length: 4321 }, (_, i) => (i % 5 === 0 ? `He said "hi" \\ \\n \n 😀 ünï ' ${i}` : `todo ${i}`));
        const ids = (await write((s) => s.insertMany("todos", titles.map((title, i) => ({ listId, title, done: i % 2 === 0, n: i }))))) as string[];
        expect(new Set(ids).size).toBe(4321);
        const all = await read((s) => s.query("todos").withIndex("by_list", (b: any) => b.eq("listId", listId)).collect());
        expect(all.length).toBe(4321);
        expect(all.map((d) => d.title).sort()).toEqual([...titles].sort());
        expect(all.find((d) => d.n === 4320)).toMatchObject({ done: true, listId });
        const times = all.map((d) => d._creationTime);
        expect(new Set(times).size).toBe(4321); // each document has a creation time of its own
        expect(times).toEqual([...times].sort((a, b) => a - b)); // in the order inserted
      });

      test("a filter that looks through more than one batch finds the same documents as a loop", async () => {
        await setup();
        const listId = await write((s) => s.insert("lists", { name: "l" }));
        await write((s) => s.insertMany("todos", Array.from({ length: 3000 }, (_, i) => ({ listId, title: `t${i}`, done: false, n: i }))));
        const q = () => s.query("todos").withIndex("by_list", (b: any) => b.eq("listId", listId));
        let s!: DocStore;
        const [collected, firstFive, page] = await read(async (store) => {
          s = store;
          return [
            (await q().filter((d: any) => d.n % 7 === 0).collect()).map((d) => d.n),
            (await q().filter((d: any) => d.n > 2500).take(5)).map((d) => d.n),
            await q().filter((d: any) => d.n % 100 === 0).paginate({ numItems: 10, cursor: null }),
          ] as const;
        });
        expect(collected).toEqual(Array.from({ length: 3000 }, (_, i) => i).filter((n) => n % 7 === 0));
        expect(firstFive).toEqual([2501, 2502, 2503, 2504, 2505]);
        expect(page.page.map((d) => d.n)).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
        expect(page.isDone).toBe(false);
      });
    });

    describe("a read that runs without a transaction", () => {
      test("is run once when it makes one statement", async () => {
        await setup();
        await write((s) => s.insert("lists", { name: "only" }));
        let runs = 0;
        const rows = await db.transaction(
          "read",
          async (tx) => {
            runs++;
            return new DocStore(tx, db.dialect, tables).query("lists").collect();
          },
          { rerunnable: true },
        );
        expect(rows.length).toBe(1);
        expect(runs).toBe(1);
      });

      test("a read of several statements sees one snapshot, whatever is written between them", async () => {
        await setup();
        if (db.dialect.name === "sqlite" && (await db.query("PRAGMA database_list"))[0]?.file === "") return; // :memory: serializes everything
        await write((s) => s.insert("lists", { name: "first" }));
        let attempt = 0;
        let writing: Promise<unknown> = Promise.resolve();
        const counts = await db.transaction(
          "read",
          async (tx) => {
            attempt++;
            const s = new DocStore(tx, db.dialect, tables);
            const before = (await s.query("lists").collect()).length;
            if (attempt === 2 || db.dialect.name === "sqlite") writing = writing.then(() => write((w) => w.insert("lists", { name: `later ${attempt}` })));
            await writing;
            return [before, (await s.query("lists").collect()).length];
          },
          { rerunnable: true },
        );
        expect(counts[0]).toBe(counts[1]);
        if (db.dialect.name === "postgres") expect(attempt).toBe(2); // the first run, outside a transaction, was thrown away
      });

      test("a read that catches the error of its second statement is run again all the same", async () => {
        await setup();
        if (db.dialect.name !== "postgres") return;
        await write((s) => s.insert("lists", { name: "x" }));
        let runs = 0;
        const out = await db.transaction(
          "read",
          async (tx) => {
            runs++;
            const s = new DocStore(tx, db.dialect, tables);
            await s.query("lists").collect();
            const second = await s.query("lists").collect().catch(() => "swallowed");
            return second;
          },
          { rerunnable: true },
        );
        expect(runs).toBe(2);
        expect(Array.isArray(out)).toBe(true); // the answer of the run inside a transaction, not the swallowed one
      });
    });
  });
}
