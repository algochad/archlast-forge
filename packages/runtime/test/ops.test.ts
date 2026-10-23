import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createLocalDb } from "../src/server/db/factory";
import * as ops from "../src/server/cli-ops";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
const opened: ops.ProjectDb[] = [];
const open = async (dataDir = tempDir()) => {
  const p = await ops.openProject(fixture, { ...process.env, DATA_DIR: dataDir });
  opened.push(p);
  return p;
};
afterEach(async () => {
  for (const p of opened.splice(0)) await p.close();
  delete process.env.CURE;
});

const insertEvents = (p: ops.ProjectDb, kinds: string[]) =>
  p.exec.mutate(async (s) => {
    for (const kind of kinds) await s.insert("events", { kind, at: 0 });
  });

test("finds stored documents that don't match the schema", async () => {
  const p = await open();
  await insertEvents(p, ["ok"]);
  await p.db.execute(`INSERT INTO "events" ("_id", "_creationTime", "doc") VALUES ('events:bad', 1, '{"kind":5}')`);
  const invalid = await ops.invalidDocuments(p);
  expect(invalid).toEqual([{ id: "events:bad", error: "events.kind must be a string, got 5" }]);
});

test("migrations run in batches to completion, then don't run again", async () => {
  const p = await open();
  await insertEvents(p, Array.from({ length: 100 }, (_, i) => (i % 2 ? "old" : "keep")));
  const progress: number[] = [];
  expect(await ops.runMigrations(p)).toEqual(["migrations:failOnPoison", "migrations:renameOldEvents"]);
  const events = (await p.exec.read((s) => s.query("events").collect())).value;
  expect(events.filter((e: any) => e.kind === "old")).toHaveLength(0);
  expect(events.filter((e: any) => e.kind === "new")).toHaveLength(50);
  const status = await ops.migrationStatus(p);
  expect(status.map((m) => [m.name, m.state, m.processed])).toEqual([
    ["migrations:failOnPoison", "done", 100],
    ["migrations:renameOldEvents", "done", 100],
  ]);
  expect(await ops.runMigrations(p)).toEqual([]);
  await ops.runMigrations(p, ["migrations:renameOldEvents"], (_, n) => progress.push(n)); // named: runs again
  expect(progress).toEqual([40, 80, 100]);
});

test("a failed migration records where it stopped and resumes", async () => {
  const p = await open();
  await insertEvents(p, ["a", "b", "poison", "c"]);
  await expect(ops.runMigrations(p, ["migrations:failOnPoison"])).rejects.toThrow("Migration migrations:failOnPoison failed after 0 documents: poisoned");
  expect((await ops.migrationStatus(p)).find((m) => m.name === "migrations:failOnPoison")).toMatchObject({ state: "failed", error: "poisoned" });
  process.env.CURE = "1";
  await ops.runMigrations(p, ["migrations:failOnPoison"]);
  expect((await ops.migrationStatus(p)).find((m) => m.name === "migrations:failOnPoison")).toMatchObject({ state: "done", processed: 4 });
});

test("export and import round-trip ids and data; import refuses non-empty tables", async () => {
  const a = await open();
  const listId = await a.exec.mutate((s) => s.insert("lists", { name: "home" }));
  await a.exec.mutate((s) => s.insert("todos", { listId, title: "milk", done: false }));
  await a.exec.mutate((s) => s.insert("notes", { body: "searchable text", tag: "x", n: 1 }));
  const file = join(tempDir(), "export.jsonl");
  expect(await ops.exportData(a, file)).toBe(3);

  const b = await open();
  expect(await ops.importData(b, file)).toBe(3);
  expect((await b.exec.read((s) => s.get(listId))).value).toMatchObject({ _id: listId, name: "home" });
  const found = (await b.exec.read((s) => s.query("notes").withSearchIndex("search_body", (q: any) => q.search("body", "search")).take(5))).value;
  expect(found).toHaveLength(1); // search index rebuilt on import
  await expect(ops.importData(b, file)).rejects.toThrow("pass --replace");
  expect(await ops.importData(b, file, { replace: true })).toBe(3);
  expect((await b.exec.read((s) => s.query("lists").collect())).value).toHaveLength(1);
});

test("SQLite backup is a usable copy", async () => {
  const p = await open();
  await insertEvents(p, ["backed-up"]);
  const file = join(tempDir(), "backup.db");
  await ops.backup(p, file);
  expect(existsSync(file)).toBe(true);
  const copy = await createLocalDb(file);
  expect(await copy.query(`SELECT COUNT(*) AS n FROM "events"`)).toEqual([{ n: 1 }]);
  await copy.close();
});

test("environment variables are stored and loaded for functions", async () => {
  const dir = tempDir();
  const db = await ops.openDb({ DATA_DIR: dir });
  await ops.setEnv(db, "REMINDER_URL", "https://example.com");
  await ops.setEnv(db, "REMINDER_URL", "https://example.org");
  await expect(ops.setEnv(db, "bad-name", "x")).rejects.toThrow("Invalid variable name");
  expect((await ops.listEnv(db)).map((e) => [e.name, e.value])).toEqual([["REMINDER_URL", "https://example.org"]]);
  await ops.removeEnv(db, "REMINDER_URL");
  expect(await ops.listEnv(db)).toEqual([]);
  await db.close();
});
