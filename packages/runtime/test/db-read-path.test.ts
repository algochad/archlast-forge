import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";

let db: Db;
let exec: Executor;
let statements: string[];

beforeEach(async () => {
  const project = await loadProject(join(import.meta.dir, "fixture"));
  db = createSqliteDb(":memory:");
  await db.migrate(tableSpecs(project.tables));
  statements = [];
  const transaction = db.transaction.bind(db);
  db.transaction = ((mode: "read" | "write", fn: any) =>
    transaction(mode, (tx) =>
      fn({
        query: (sql: string, p?: unknown[]) => (
          statements.push(sql),
          tx.query(sql, p)
        ),
        execute: tx.execute.bind(tx),
      }),
    )) as Db["transaction"];
  exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    publish: () => {},
    log: () => {},
  });
});
afterEach(() => db.close());

const read = async <T>(fn: (s: any) => Promise<T>) =>
  (await exec.read((s) => fn(s.reader()))).value as T;
const usedSql = () => statements.some((s) => s.includes("TOTAL("));

describe("sum, avg, min and max in SQL", () => {
  /** Stores documents the way a loose table would: raw, so a field can hold anything. */
  const store = async (docs: Record<string, unknown>[]) => {
    for (const [i, d] of docs.entries())
      await db.execute(
        `INSERT INTO "notes" ("_id", "_creationTime", "doc") VALUES (?, ?, ?)`,
        [`notes:${i}`, i + 1, JSON.stringify({ body: "b", tag: "t", ...d })],
      );
  };
  const all = async (field = "n") => {
    statements.length = 0;
    const out = await read(async (s) => {
      const q = () =>
        s.query("notes").withIndex("by_tag_n", (b: any) => b.eq("tag", "t"));
      return {
        sum: await q().sum(field),
        avg: await q().avg(field),
        min: await q().min(field),
        max: await q().max(field),
      };
    });
    return out;
  };
  const byHand = (xs: number[]) => ({
    sum: xs.reduce((a, b) => a + b, 0),
    avg: xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null,
    min: xs.length ? Math.min(...xs) : null,
    max: xs.length ? Math.max(...xs) : null,
  });

  test("integers (some documents without the field or with null) come from the database and equal the loop", async () => {
    await store([{ n: 3 }, { n: -7 }, { n: 12 }, {}, { n: null }, { n: 0 }]);
    expect(await all()).toEqual(byHand([3, -7, 12, 0]));
    expect(usedSql()).toBe(true);
  });

  test("0 and 1 are checked against the documents' own types, and still come from the database", async () => {
    await store([{ n: 1 }, { n: 0 }, { n: 1 }, { n: 5 }]);
    expect(await all()).toEqual(byHand([1, 0, 1, 5]));
    expect(statements.some((s) => s.includes("json_type"))).toBe(true);
    expect(usedSql()).toBe(true);
  });

  test("nothing in the range: sum 0, the rest null", async () => {
    expect(await all()).toEqual({ sum: 0, avg: null, min: null, max: null });
  });

  test("a range with no values for the field is the same", async () => {
    await store([{}, { n: null }]);
    expect(await all()).toEqual({ sum: 0, avg: null, min: null, max: null });
  });

  test("reals: min and max from the database, sum and avg from the documents (SQLite adds reals differently from a loop)", async () => {
    await store([{ n: 0.1 }, { n: 0.2 }, { n: 0.3 }]);
    const r = await all();
    expect(r).toEqual(byHand([0.1, 0.2, 0.3])); // 0.6000000000000001, not SQLite's 0.6
    expect(r.sum).not.toBe(0.6);
    expect(statements.filter((s) => s.includes("TOTAL(")).length).toBe(4); // each call asks; two answer from it
    expect(
      statements.filter(
        (s) => !s.includes("TOTAL(") && s.includes('FROM "notes"'),
      ).length,
    ).toBeGreaterThan(0);
  });

  test("integers too big to add exactly fall back to the loop's answer", async () => {
    await store([{ n: 2 ** 53 - 1 }, { n: 1 }, { n: -(2 ** 53 - 1) }]);
    expect(await all()).toEqual(byHand([2 ** 53 - 1, 1, -(2 ** 53 - 1)]));
  });

  test("a value that isn't a number is reported as before", async () => {
    await store([{ n: 1 }, { n: "two" }]);
    await expect(read((s) => s.query("notes").sum("n"))).rejects.toThrow(
      '"notes.n" holds a string, not a number',
    );
    await expect(read((s) => s.query("notes").min("n"))).rejects.toThrow(
      '"notes.n" holds a string, not a number',
    );
  });

  test("a boolean is not a number either", async () => {
    await store([{ n: true }]);
    await expect(read((s) => s.query("notes").max("n"))).rejects.toThrow(
      "holds a boolean, not a number",
    );
  });

  test("filter() and skip() read the documents", async () => {
    await store([{ n: 1 }, { n: 2 }, { n: 3 }, { n: 4 }]);
    statements.length = 0;
    expect(
      await read((s) =>
        s
          .query("notes")
          .filter((d: any) => d.n > 1)
          .sum("n"),
      ),
    ).toBe(9);
    expect(
      await read((s) => s.query("notes").withIndex("by_n").skip(1).sum("n")),
    ).toBe(9);
    expect(usedSql()).toBe(false);
  });

  test("the range still decides what is added", async () => {
    await store([
      { n: 1, tag: "a" },
      { n: 2, tag: "a" },
      { n: 10, tag: "b" },
    ]);
    statements.length = 0;
    expect(
      await read((s) =>
        s
          .query("notes")
          .withIndex("by_tag_n", (b: any) => b.eq("tag", "a"))
          .sum("n"),
      ),
    ).toBe(3);
    expect(
      await read((s) =>
        s
          .query("notes")
          .withIndex("by_tag_n", (b: any) => b.eq("tag", "a").gt("n", 1))
          .sum("n"),
      ),
    ).toBe(2);
    expect(
      await read((s) =>
        s
          .query("notes")
          .where((b: any) => b.eq("tag", "b"))
          .max("n"),
      ),
    ).toBe(10);
    expect(usedSql()).toBe(true);
  });
});

describe("include with take", () => {
  const seed = async () => {
    const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
    const todos: string[] = [];
    for (let i = 0; i < 4; i++)
      todos.push(
        await exec.mutate((s) =>
          s.insert("todos", { listId, title: `t${i}`, done: false }),
        ),
      );
    for (const [i, todoId] of todos.entries())
      for (let c = 0; c < i; c++)
        await exec.mutate((s) =>
          s.insert("comments", { todoId, body: `c${i}.${c}`, score: c }),
        );
    return { listId, todos };
  };
  const viaBuilder = (todos: string[], take: number, order: "asc" | "desc") =>
    read(async (s) => {
      const out: unknown[] = [];
      for (const id of todos)
        out.push(
          await s
            .query("comments")
            .withIndex("by_todo", (b: any) => b.eq("todoId", id))
            .order(order)
            .take(take),
        );
      return out;
    });

  for (const order of ["asc", "desc"] as const)
    for (const take of [0, 1, 2, 10]) {
      test(`take ${take}, ${order}: the same documents as one query per parent`, async () => {
        const { listId, todos } = await seed();
        const got = await read<any[]>((s) =>
          s
            .query("todos")
            .withIndex("by_list", (b: any) => b.eq("listId", listId))
            .include({
              comments: { table: "comments", index: "by_todo", take, order },
            })
            .collect(),
        );
        expect(got.map((t: any) => t._id)).toEqual(todos);
        expect(got.map((t: any) => t.comments)).toEqual(
          await viaBuilder(todos, take, order),
        );
      });
    }

  test("a parent without children gets an empty list, and an include inside it is applied", async () => {
    const { listId, todos } = await seed();
    const got = await read<any[]>((s) =>
      s
        .query("todos")
        .withIndex("by_list", (b: any) => b.eq("listId", listId))
        .include({
          comments: {
            table: "comments",
            index: "by_todo",
            take: 1,
            include: { todo: "todoId" },
          },
        })
        .collect(),
    );
    expect(got[0].comments).toEqual([]);
    expect(got[3].comments.length).toBe(1);
    expect(got[3].comments[0].todo._id).toBe(todos[3]);
  });

  test("a write to a parent's children re-reads only that parent's topic", async () => {
    const { listId, todos } = await seed();
    const { reads } = await exec.read((s) =>
      s
        .query("todos")
        .withIndex("by_list", (b: any) => b.eq("listId", listId))
        .include({ comments: { table: "comments", index: "by_todo", take: 1 } })
        .collect(),
    );
    for (const id of todos)
      expect(reads.has(`comments:by_todo:${JSON.stringify([id])}`)).toBe(true);
  });
});

describe("getMany", () => {
  test("keeps the order asked for, repeats, missing ids, and reads one topic per document", async () => {
    const a = await exec.mutate((s) => s.insert("lists", { name: "a" }));
    const b = await exec.mutate((s) => s.insert("lists", { name: "b" }));
    const { value, reads } = await exec.read((s) =>
      s.getMany([b, a, b, "lists:nope"]),
    );
    expect(value.map((d) => d?.name ?? null)).toEqual(["b", "a", "b", null]);
    for (const id of [a, b, "lists:nope"])
      expect(reads.has(`lists:by_id:${JSON.stringify([id])}`)).toBe(true);
  });
});
