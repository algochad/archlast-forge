// The native database layer is a drop-in for the bun:sqlite one: the same ctx.db API (no method added, renamed or removed) and the same answers. These tests run
// both on the same operations and compare. They are skipped where the native library is not built.
import { afterAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { DocStore, type TablesSpec } from "../src/server/docstore";
import { NativeStore } from "../src/server/native-store";
import { createSqliteDb } from "../src/server/db/sqlite";
import { createNativeSqliteDb } from "../src/server/db/sqlite-native";
import { nativeDb } from "../src/server/db/native";
import type { Db } from "../src/server/db/types";
import { v } from "../src/values";
import { tempDir } from "./helpers";

const native = nativeDb();
const tables: TablesSpec = {
  notes: {
    fields: { name: v.string(), n: v.number(), tag: v.optional(v.string()), flag: v.optional(v.nullable(v.boolean())), meta: v.optional(v.any()) },
    indexes: { by_n: ["n"], by_tag_n: ["tag", "n"] },
    searchIndexes: { search_name: { searchField: "name", filterFields: ["tag"] } },
    strict: true,
  },
};
const specs = [{ name: "notes", indexes: tables.notes!.indexes, searchIndexes: tables.notes!.searchIndexes, fields: tables.notes!.fields, strict: true }];

/** The names of the functions an object offers (its own and inherited ones; the JavaScript-private `#` ones are not properties at all). */
const methods = (o: any) => {
  const out = new Set<string>();
  for (let p = o; p && p !== Object.prototype; p = Object.getPrototypeOf(p))
    for (const k of Object.getOwnPropertyNames(p)) if (k !== "constructor" && !k.startsWith("_") && typeof o[k] === "function") out.add(k);
  return [...out].sort();
};

describe.skipIf(!native)("the native layer is the same database API as the bun layer", () => {
  const dbs: Db[] = [];
  afterAll(() => Promise.all(dbs.map((d) => d.close())));
  const open = async (kind: "bun" | "native") => {
    const path = join(tempDir(), "app.db");
    const db = kind === "bun" ? createSqliteDb(path) : (createNativeSqliteDb(path, native!, 2, undefined, "NORMAL") as Db);
    dbs.push(db);
    await db.migrate(specs as never);
    return db;
  };
  const store = (db: Db, tx: any, writes = false) => new (tx.native ? NativeStore : DocStore)(tx, db.dialect, tables, new Set(), writes ? new Set() : undefined, 1 << 20);
  const write = <T>(db: Db, fn: (s: any) => Promise<T>) => db.transaction("write", (tx) => fn(store(db, tx, true)));
  const read = <T>(db: Db, fn: (s: any) => Promise<T>) => db.transaction("read", (tx) => fn(store(db, tx)));

  test("ctx.db offers the same methods", async () => {
    const [b, n] = [await open("bun"), await open("native")];
    const shape = (db: Db) =>
      write(db, async (s) => ({
        reader: methods(s.reader()),
        writer: methods(s.writer()),
        query: methods(s.query("notes")),
        indexed: methods(s.query("notes").withIndex("by_n")),
        search: methods(s.query("notes").withSearchIndex("search_name", (q: any) => q.search("name", "x"))),
      }));
    expect(await shape(n)).toEqual(await shape(b));
  });

  /** Ids by the order the documents were made in, and no creation times: what is left is the same for both layers. */
  const plain = (ids: string[]) => {
    const names = new Map(ids.map((id, i) => [id, `#${i}`]));
    const clean = (x: any): any =>
      Array.isArray(x)
        ? x.map(clean)
        : x && typeof x === "object"
          ? Object.fromEntries(Object.entries(x).filter(([k]) => k !== "_creationTime").map(([k, y]) => [k, k === "_id" ? names.get(y as string) : clean(y)]))
          : typeof x === "string"
            ? [...names].reduce((text, [id, name]) => text.replaceAll(id, name), x) // an error message names the document
            : x;
    return clean;
  };
  const seed = (db: Db) =>
    write(db, async (s) => {
      const ids: string[] = [];
      const rows: Record<string, unknown>[] = [];
      for (let i = 0; i < 40; i++)
        rows.push({
          name: i % 7 === 0 ? `quote " and \\ and \n newline ${i}` : i % 5 === 0 ? `héllo 漢字 😀 ${i}` : `note ${i}`,
          n: i % 9 === 0 ? i / 7 : i % 11 === 0 ? -i : i,
          ...(i % 3 === 0 ? { tag: i % 2 ? "odd" : "even" } : {}),
          ...(i % 4 === 0 ? { flag: null } : i % 4 === 1 ? { flag: true } : {}),
          ...(i % 6 === 0 ? { meta: { deep: [1, { x: "y,}" }], z: null } } : {}),
        });
      for (const r of rows) ids.push(await s.insert("notes", r));
      return ids;
    });

  test("the same answers to the same queries", async () => {
    const [b, n] = [await open("bun"), await open("native")];
    const [bi, ni] = [await seed(b), await seed(n)];
    const queries: [string, (s: any) => Promise<unknown>][] = [
      ["collect", (s) => s.query("notes").collect()],
      ["index range", (s) => s.query("notes").withIndex("by_n", (q: any) => q.gte("n", 3).lt("n", 20)).collect()],
      ["desc take", (s) => s.query("notes").withIndex("by_n").order("desc").take(6)],
      ["eq + range", (s) => s.query("notes").withIndex("by_tag_n", (q: any) => q.eq("tag", "even").gt("n", 4)).collect()],
      ["first", (s) => s.query("notes").withIndex("by_n", (q: any) => q.eq("n", 5)).first()],
      ["first of nothing", (s) => s.query("notes").withIndex("by_n", (q: any) => q.eq("n", 12345)).first()],
      ["count", (s) => s.query("notes").withIndex("by_n", (q: any) => q.gt("n", 10)).count()],
      ["skip + take", (s) => s.query("notes").skip(3).take(5)],
      ["select", (s) => s.query("notes").select(["name", "flag", "tag"]).collect()],
      ["select with null and nested", (s) => s.query("notes").select(["meta", "flag"]).collect()],
      ["select desc take", (s) => s.query("notes").withIndex("by_n").order("desc").select(["n"]).take(4)],
      ["sum", (s) => s.query("notes").sum("n")],
      ["avg", (s) => s.query("notes").avg("n")],
      ["min", (s) => s.query("notes").min("n")],
      ["max", (s) => s.query("notes").max("n")],
      ["where", (s) => s.query("notes").where((b: any) => b.and(b.gt("n", 8), b.eq("tag", "odd"))).collect()],
      ["search", (s) => s.query("notes").withSearchIndex("search_name", (q: any) => q.search("name", "note")).take(5)],
      ["JSON text", async (s) => JSON.parse(await s.query("notes").withIndex("by_n").take(3).then((d: unknown[]) => JSON.stringify(d)))],
      ["get", async (s) => s.get((await s.query("notes").first())._id)],
    ];
    for (const [name, q] of queries) {
      const got = plain(ni)(await read(n, q));
      const want = plain(bi)(await read(b, q));
      expect({ name, got }).toEqual({ name, got: want });
    }
    // pages, with and without a projection, to the end
    for (const select of [undefined, ["name", "n"]]) {
      const pages = async (db: Db, ids: string[]) => {
        const out: unknown[] = [];
        let cursor: string | null = null;
        for (;;) {
          const page: any = await read(db, (s) => {
            const q = s.query("notes").withIndex("by_n");
            return (select ? q.select(select) : q).paginate({ numItems: 7, cursor });
          });
          out.push(plain(ids)({ page: page.page, isDone: page.isDone }));
          if (page.isDone) return out;
          cursor = page.continueCursor;
        }
      };
      expect(await pages(n, ni)).toEqual(await pages(b, bi));
    }
  });

  test("the same effects of the same writes, and the same errors", async () => {
    const [b, n] = [await open("bun"), await open("native")];
    const [bi, ni] = [await seed(b), await seed(n)];
    const run = async (db: Db, ids: string[]) => {
      const out: unknown[] = [];
      const step = async (f: (s: any) => Promise<unknown>) => out.push(await write(db, f).catch((e: Error) => `error: ${e.message}`));
      await step((s) => s.patch(ids[1]!, { name: "patched", tag: "t", flag: undefined }));
      await step((s) => s.patch(ids[2]!, { n: "not a number" }));
      await step((s) => s.patch(ids[3]!, { unknown: 1 }));
      await step((s) => s.replace(ids[4]!, { name: "replaced", n: 99 }));
      await step((s) => s.replace(ids[5]!, { name: 5, n: 1 }));
      await step((s) => s.insert("notes", { name: "x" }));
      await step((s) => s.insert("notes", { name: "with é 漢 😀", n: 1.5, meta: [1, 2, { a: null }] }).then(() => "inserted"));
      await step((s) => s.insertMany("notes", [{ name: "a", n: 1 }, { name: "b", n: 2 }]).then((r: string[]) => r.length));
      await step((s) => s.delete(ids[6]!));
      await step((s) => s.delete(ids[6]!)); // already gone: nothing happens
      await step((s) => s.patch(ids[6]!, { n: 1 })); // not found
      await step((s) => s.query("notes").collect());
      return plain(ids)(out);
    };
    expect(await run(n, ni)).toEqual(await run(b, bi));
  });
});
