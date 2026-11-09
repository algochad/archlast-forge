import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { library } from "../src/index";

const dir = mkdtempSync(join(tmpdir(), "afx-dbnative-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Engine {
  migrate(spec: string): void;
  beginRead(cached: boolean): number;
  beginWrite(): number;
  writerSql(sql: string): void;
  endTx(tx: number, ok: boolean): string;
  all(tx: number, sql: string, params: unknown[]): string;
  run(tx: number, sql: string, params: unknown[]): number;
  get(tx: number, id: string): string | null;
  query(tx: number, table: string, desc: string): string;
  count(tx: number, table: string, desc: string): number;
  insert(tx: number, table: string, docs: string[], maxBytes: number, trusted: boolean): string[];
  change(tx: number, id: string, value: string, patch: boolean, maxBytes: number, trusted: boolean): boolean;
  replace(tx: number, id: string, json: string): boolean;
  delete(tx: number, id: string): void;
  cacheStats(): string;
  paused(): boolean;
  close(): void;
}

const lib = library ? (require(library) as { Engine: new (path: string, options: string) => Engine }) : null;
const MAX = 1_000_000;
const spec = (tables: unknown) => JSON.stringify({ tables });
const notes = {
  name: "notes",
  creation: { fields: [], sql: "afx_creation" },
  indexes: [["by_tag_n", { fields: ["tag", "n"], sql: "afx_by_tag_n" }]],
  search: [["search_body", { field: "body", fts: "afx_fts_notes" }]],
};

describe.skipIf(!lib)("the native document engine", () => {
  let n = 0;
  const open = () => {
    const e = new lib!.Engine(join(dir, `e${n++}.db`), JSON.stringify({ readers: 2 }));
    e.migrate(spec([notes]));
    return e;
  };
  const write = (e: Engine, f: (tx: number) => void) => {
    const tx = e.beginWrite();
    e.writerSql("BEGIN IMMEDIATE");
    try {
      f(tx);
    } catch (err) {
      e.writerSql("ROLLBACK");
      e.endTx(tx, false);
      throw err;
    }
    e.writerSql("COMMIT");
    return e.endTx(tx, true);
  };
  const read = <T>(e: Engine, f: (tx: number) => T, cached = true) => {
    const tx = e.beginRead(cached);
    try {
      return f(tx);
    } finally {
      e.endTx(tx, true);
    }
  };

  test("documents are written, read back as text joined to their id and time, and replaced and deleted", () => {
    const e = open();
    let ids: string[] = [];
    write(e, (tx) => (ids = e.insert(tx, "notes", [JSON.stringify({ body: 'a "quoted"\nbody', tag: "x", n: 1 }), JSON.stringify({ body: "é 漢 😀", tag: "x", n: 2 })], MAX, true)));
    expect(ids[0]).toMatch(/^notes:[0-9a-f]{32}$/);
    const doc = JSON.parse(read(e, (tx) => e.get(tx, ids[0]!))!);
    expect(doc).toMatchObject({ _id: ids[0], body: 'a "quoted"\nbody', tag: "x", n: 1 });
    expect(typeof doc._creationTime).toBe("number");
    const range = JSON.parse(read(e, (tx) => e.query(tx, "notes", JSON.stringify({ table: "notes", index: "by_tag_n", eqs: [["tag", "x"]], desc: true }))));
    expect(range.map((d: any) => d.n)).toEqual([2, 1]);
    expect(read(e, (tx) => e.count(tx, "notes", JSON.stringify({ table: "notes", index: "by_tag_n", eqs: [["tag", "x"]] })))).toBe(2);
    write(e, (tx) => expect(e.replace(tx, ids[0]!, JSON.stringify({ body: "changed", tag: "y", n: 1 }))).toBe(true));
    write(e, (tx) => expect(e.replace(tx, ids[0]!, JSON.stringify({ body: "changed", tag: "y", n: 1 }))).toBe(false)); // stored as it is: nothing to write
    expect(JSON.parse(read(e, (tx) => e.get(tx, ids[0]!))!).body).toBe("changed");
    write(e, (tx) => e.delete(tx, ids[0]!));
    expect(read(e, (tx) => e.get(tx, ids[0]!))).toBeNull();
    e.close();
  });

  test("a transaction says what it read and wrote, as the topics JavaScript makes", () => {
    const e = open();
    let id = "";
    const wrote = write(e, (tx) => void (id = e.insert(tx, "notes", [JSON.stringify({ body: "b", tag: "t", n: 1.5 })], MAX, true)[0]!));
    const [reads, writes] = wrote.split("\u0001");
    expect(reads).toBe("");
    expect(writes!.split("\u0000").sort()).toEqual(["notes", `notes:by_id:["${id}"]`, 'notes:by_tag_n:["t"]', 'notes:by_tag_n:["t",1.5]'].sort());
    const tx = e.beginRead(true);
    e.query(tx, "notes", JSON.stringify({ table: "notes", index: "by_tag_n", eqs: [["tag", "t"]] }));
    e.get(tx, id);
    expect(e.endTx(tx, true).split("\u0000").sort()).toEqual([`notes:by_id:["${id}"]`, 'notes:by_tag_n:["t"]'].sort());
    e.close();
  });

  test("the cache answers a repeated read, and a write drops only what it wrote", () => {
    const e = open();
    let id = "";
    write(e, (tx) => void (id = e.insert(tx, "notes", [JSON.stringify({ body: "b", tag: "t", n: 1 })], MAX, true)[0]!));
    const desc = JSON.stringify({ table: "notes", index: "by_tag_n", eqs: [["tag", "t"]] });
    read(e, (tx) => e.query(tx, "notes", desc));
    const before = JSON.parse(e.cacheStats());
    read(e, (tx) => e.query(tx, "notes", desc));
    expect(JSON.parse(e.cacheStats())).toEqual({ hits: before.hits + 1, misses: before.misses });
    write(e, (tx) => void e.insert(tx, "notes", [JSON.stringify({ body: "c", tag: "other", n: 1 })], MAX, true));
    read(e, (tx) => e.query(tx, "notes", desc)); // another tag: this entry survives
    expect(JSON.parse(e.cacheStats()).hits).toBe(before.hits + 2);
    write(e, (tx) => void e.replace(tx, id, JSON.stringify({ body: "b2", tag: "t", n: 1 })));
    expect(JSON.parse(read(e, (tx) => e.query(tx, "notes", desc)))[0].body).toBe("b2");
    e.close();
  });

  test("a read that used the cache and then needs the database after a commit starts over", () => {
    const e = open();
    let id = "";
    write(e, (tx) => void (id = e.insert(tx, "notes", [JSON.stringify({ body: "b", tag: "t", n: 1 })], MAX, true)[0]!));
    read(e, (tx) => e.get(tx, id)); // cached
    const tx = e.beginRead(true);
    e.get(tx, id); // from the cache
    write(e, (w) => void e.insert(w, "notes", [JSON.stringify({ body: "c", tag: "t", n: 2 })], MAX, true)); // a commit lands mid-read
    expect(() => e.count(tx, "notes", JSON.stringify({ table: "notes", index: "by_tag_n", eqs: [["tag", "t"]] }))).toThrow(/^\u0001S/);
    e.endTx(tx, false);
    e.close();
  });

  test("search tables follow the documents", () => {
    const e = open();
    let id = "";
    write(e, (tx) => void (id = e.insert(tx, "notes", [JSON.stringify({ body: "hello world", tag: "t", n: 1 })], MAX, true)[0]!));
    const match = (word: string) => read(e, (tx) => JSON.parse(e.all(tx, `SELECT doc_id FROM "afx_fts_notes" WHERE afx_fts_notes MATCH ?`, [word])).map((r: any) => r.doc_id));
    expect(match("hello")).toEqual([id]);
    write(e, (tx) => void e.replace(tx, id, JSON.stringify({ body: "goodbye", tag: "t", n: 1 })));
    expect(match("hello")).toEqual([]);
    expect(match("goodbye")).toEqual([id]);
    write(e, (tx) => e.delete(tx, id));
    expect(match("goodbye")).toEqual([]);
    e.close();
  });

  test("bad input is told apart from failure: unknown tables and ids are validation errors", () => {
    const e = open();
    expect(() => read(e, (tx) => e.get(tx, "nothing:abc"))).toThrow(/^\u0001V.*Unknown table "nothing"/);
    expect(() => read(e, (tx) => e.get(tx, "no-colon"))).toThrow(/^\u0001V.*Invalid id/);
    expect(() => read(e, (tx) => e.query(tx, "notes", JSON.stringify({ table: "notes", eqs: [["bad field", 1]] })))).toThrow(/^\u0001V.*not a field name/);
    expect(() => write(e, (tx) => e.replace(tx, "notes:missing", "{}"))).toThrow(/^\u0001V.*not found/);
    expect(() => read(e, (tx) => e.insert(tx, "notes", ["{}"], MAX, true))).toThrow(/read-only/);
    e.close();
    expect(() => e.beginRead(true)).toThrow(/closed/);
  });

  test("a write is checked against the validators the engine was given; what it cannot vouch for goes to JavaScript", () => {
    const e = new lib!.Engine(join(dir, `v${n++}.db`), JSON.stringify({ readers: 2 }));
    const field = (kind: string, optional = false) => ({ kind, optional });
    e.migrate(spec([{ ...notes, fields: { body: field("string"), tag: field("string"), n: field("number", true) }, strict: true }]));
    let id = "";
    write(e, (tx) => void (id = e.insert(tx, "notes", [JSON.stringify({ body: "b", tag: "t" })], MAX, false)[0]!));
    expect(id).toMatch(/^notes:/);
    // wrong type, unknown field: refused natively with the marker that sends the write to the Zod schemas for their wording
    expect(() => write(e, (tx) => e.insert(tx, "notes", [JSON.stringify({ body: 1, tag: "t" })], MAX, false))).toThrow(/^\u0001X/);
    expect(() => write(e, (tx) => e.insert(tx, "notes", [JSON.stringify({ body: "b", tag: "t", extra: 1 })], MAX, false))).toThrow(/^\u0001X/);
    // patched natively: the result is checked, an undefined marker removes the field
    write(e, (tx) => void e.change(tx, id, JSON.stringify({ n: 2 }), true, MAX, false));
    expect(JSON.parse(read(e, (tx) => e.get(tx, id))!).n).toBe(2);
    write(e, (tx) => void e.change(tx, id, JSON.stringify({ n: { $undefined: true } }), true, MAX, false));
    expect("n" in JSON.parse(read(e, (tx) => e.get(tx, id))!)).toBe(false);
    expect(() => write(e, (tx) => e.change(tx, id, JSON.stringify({ n: "x" }), true, MAX, false))).toThrow(/^\u0001X/);
    // the size limit is the engine's own
    expect(() => write(e, (tx) => e.insert(tx, "notes", [JSON.stringify({ body: "x".repeat(100), tag: "t" })], 50, false))).toThrow(/^\u0001V.*bytes/);
    e.close();
  });

  test("the checkpoint thread starts and stops with the engine", () => {
    const e = open();
    expect(e.paused()).toBe(false);
    e.close();
  });
});
