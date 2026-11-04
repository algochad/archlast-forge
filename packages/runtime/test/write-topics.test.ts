import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";
import { topic } from "../src/server/docstore";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs } from "../src/server/project";
import { ReadCache } from "../src/server/read-cache";
import { tempDir } from "./helpers";

let db: Db;
let exec: Executor;
let published: string[][];
let statements: string[];

beforeEach(async () => {
  const project = await loadProject(join(import.meta.dir, "fixture"));
  db = createSqliteDb(join(tempDir(), "app.db"));
  await db.migrate(tableSpecs(project.tables));
  published = [];
  statements = [];
  const transaction = db.transaction.bind(db);
  db.transaction = ((mode: "read" | "write", fn: any) =>
    transaction(mode, (tx) =>
      fn({
        query: tx.query.bind(tx),
        execute: (sql: string, p?: unknown[]) => (
          statements.push(sql),
          tx.execute(sql, p)
        ),
      }),
    )) as Db["transaction"];
  exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    publish: (t) => published.push(t),
    log: () => {},
    readCache: new ReadCache(),
  });
});
afterEach(() => db.close());

const updates = () => statements.filter((s) => s.startsWith("UPDATE"));
const todo = async () => {
  const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
  const id = await exec.mutate((s) =>
    s.insert("todos", { listId, title: "a", done: false }),
  );
  published.length = 0;
  statements.length = 0;
  return { listId, id };
};

test("a patch that changes nothing writes nothing and wakes nobody", async () => {
  const { id } = await todo();
  await exec.mutate((s) => s.patch(id, { title: "a", done: false }));
  expect(updates()).toEqual([]);
  expect(published).toEqual([]);
});

test("a patch to a field no index covers publishes the table, the document and each index prefix once", async () => {
  const { listId, id } = await todo();
  await exec.mutate((s) => s.patch(id, { title: "b" }));
  expect(updates().length).toBe(1);
  expect(new Set(published[0])).toEqual(
    new Set([
      "todos",
      topic("todos", "by_id", [id]),
      topic("todos", "by_list", [listId]),
      topic("todos", "by_list_done", [listId]),
      topic("todos", "by_list_done", [listId, false]),
    ]),
  );
});

test("a patch to an indexed field publishes the topics of both values", async () => {
  const { listId, id } = await todo();
  await exec.mutate((s) => s.patch(id, { done: true }));
  expect(new Set(published[0])).toEqual(
    new Set([
      "todos",
      topic("todos", "by_id", [id]),
      topic("todos", "by_list", [listId]),
      topic("todos", "by_list_done", [listId]),
      topic("todos", "by_list_done", [listId, false]),
      topic("todos", "by_list_done", [listId, true]),
    ]),
  );
});

test("moving a document to another list wakes both lists", async () => {
  const { listId, id } = await todo();
  const other = await exec.mutate((s) => s.insert("lists", { name: "other" }));
  published.length = 0;
  await exec.mutate((s) => s.patch(id, { listId: other }));
  const topics = new Set(published[0]);
  for (const list of [listId, other]) {
    expect(topics.has(topic("todos", "by_list", [list]))).toBe(true);
    expect(topics.has(topic("todos", "by_list_done", [list, false]))).toBe(
      true,
    );
  }
});

test("updateMany leaves out updates that change nothing, and applies the rest in order", async () => {
  const { listId, id } = await todo();
  const second = await exec.mutate((s) =>
    s.insert("todos", { listId, title: "z", done: false }),
  );
  statements.length = 0;
  published.length = 0;
  await exec.mutate((s) =>
    s.updateMany("todos", [
      { id, patch: { title: "a" } }, // same as stored
      { id: second, patch: { title: "y" } },
      { id: second, patch: { title: "x" } }, // on top of the one before
    ]),
  );
  expect(updates().length).toBe(2); // none for the first, one per real change for the second
  expect((await exec.read((s) => s.get(id))).value).toMatchObject({
    title: "a",
  });
  expect((await exec.read((s) => s.get(second))).value).toMatchObject({
    title: "x",
  });
  expect(published[0]).toContain(topic("todos", "by_id", [second]));
  expect(published[0]).not.toContain(topic("todos", "by_id", [id]));
});

test("updateMany that changes nothing publishes nothing", async () => {
  const { id } = await todo();
  await exec.mutate((s) =>
    s.updateMany("todos", [{ id, patch: { done: false } }]),
  );
  expect(updates()).toEqual([]);
  expect(published).toEqual([]);
});

test("an update that changes and then restores a value in one call still ends up with the right document", async () => {
  const { id } = await todo();
  await exec.mutate((s) =>
    s.updateMany("todos", [
      { id, patch: { title: "b" } },
      { id, patch: { title: "a" } },
    ]),
  );
  expect((await exec.read((s) => s.get(id))).value).toMatchObject({
    title: "a",
  });
  expect(updates().length).toBe(2);
});
