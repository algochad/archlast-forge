import { afterEach, beforeEach, expect, test } from "bun:test";
import { join } from "node:path";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";
import { Executor, serializeError, type LogEntry } from "../src/server/executor";
import { loadProject, tableSpecs, type Project } from "../src/server/project";
import { migrateScheduler, nextRun, SchedulerLoop } from "../src/server/scheduler";
import { dbAdapters, tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
let project: Project;
let db: Db;
let exec: Executor;
let published: string[][];
let logs: LogEntry[];

async function setup(makeDb: () => Promise<Db> = async () => createSqliteDb(join(tempDir(), "app.db"))) {
  project ??= await loadProject(fixture);
  db = await makeDb();
  await db.migrate(tableSpecs(project.tables));
  await migrateScheduler(db);
  published = [];
  logs = [];
  exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    limits: { functionTimeoutMs: 300, actionTimeoutMs: 1000, maxResultBytes: 1000, maxDocumentBytes: 1 << 20 },
    publish: (t) => published.push(t),
    log: (e) => logs.push(e),
  });
}

const run = async (name: string, kind: "query" | "mutation" | "action", args: object = {}) => (await exec.call(name, kind, args, null)).value;

beforeEach(() => setup());
afterEach(() => db.close());

test("loads function modules, auth defaults and crons", () => {
  expect([...project.functions.keys()]).toContain("todos:listByList");
  expect(project.functions.get("todos:add")?.kind).toBe("mutation");
  expect(project.authOptions).toEqual({ emailAndPassword: { enabled: true } });
  expect(project.crons.map((c) => c.name)).toEqual(["tick"]);
  expect(project.tables.users?.strict).toBe(false);
});

test("query, mutation and action round trip", async () => {
  const listId = (await run("todos:createList", "mutation", { name: "home" })) as string;
  const id = await run("todos:add", "mutation", { listId, title: "milk" });
  expect(await run("todos:listByList", "query", { listId })).toMatchObject([{ _id: id, title: "milk", done: false }]);
  await run("todos:toggle", "mutation", { id });
  expect(await run("todos:openCount", "query", { listId })).toBe(0);
  const viaAction = await run("todos:addViaAction", "action", { listId, title: "eggs" });
  expect(viaAction).toMatchObject({ title: "eggs" });
  expect(logs.some((l) => l.name === "todos:addViaAction" && l.level === "call" && l.ok)).toBe(true);
});

test("queries report their read topics", async () => {
  const listId = (await run("todos:createList", "mutation", { name: "home" })) as string;
  const r = await exec.call("todos:listByList", "query", { listId }, null);
  expect(r.topics).toEqual([`todos:by_list:["${listId}"]`]);
});

test("mutations publish after commit, and not at all when they fail", async () => {
  const listId = (await run("todos:createList", "mutation", { name: "home" })) as string;
  expect(published.at(-1)).toContain("lists");
  published = [];
  await expect(run("todos:failAfterInsert", "mutation", { listId })).rejects.toThrow("boom");
  expect(published).toEqual([]);
  expect(await run("todos:listByList", "query", { listId })).toEqual([]);
});

test("args are validated, and kinds must match", async () => {
  await expect(run("todos:add", "mutation", { listId: "lists:x", title: 1 })).rejects.toThrow("args.title must be a string");
  await expect(run("todos:add", "mutation", { title: "x" })).rejects.toThrow("args.listId is required");
  await expect(run("todos:add", "query", {})).rejects.toThrow("is a mutation, not a query");
  await expect(run("todos:nope", "query")).rejects.toThrow('Unknown function "todos:nope"');
});

test("actions get no ctx.db", async () => {
  expect(await run("todos:actionTouchesDb", "action")).toBe(true);
});

test("ctx.auth is null without a session", async () => {
  expect(await run("todos:whoami", "query")).toBeNull();
});

test("scheduled mutations run once, after their delay", async () => {
  const loop = new SchedulerLoop(exec, db, project.functions, []);
  await run("todos:scheduleEvent", "mutation", { kind: "later", delayMs: 0 });
  await run("todos:scheduleEvent", "mutation", { kind: "much-later", delayMs: 60_000 });
  await Promise.all([loop.tick(), loop.tick()]); // two servers polling at once
  const events = (await run("todos:events", "query")) as { kind: string }[];
  expect(events.map((e) => e.kind)).toEqual(["later"]);
  const states = await db.query<{ state: string }>(`SELECT "state" FROM "_scheduled_functions" ORDER BY "scheduledTime"`);
  expect(states.map((s) => s.state)).toEqual(["success", "pending"]);
});

test("scheduling a query or bad args fails in the scheduling mutation", async () => {
  await expect(
    exec.mutate((_s, tx) => import("../src/server/scheduler").then((m) => m.schedule(tx, project.functions, 0, { _name: "todos:events" }))),
  ).rejects.toThrow("Only mutations and actions can be scheduled");
});

test("cron runs are inserted once even when several servers tick", async () => {
  const start = Date.now();
  const a = new SchedulerLoop(exec, db, project.functions, project.crons);
  const b = new SchedulerLoop(exec, db, project.functions, project.crons);
  const later = start + 2500;
  await Promise.all([a.tick(later), b.tick(later)]);
  const events = (await run("todos:events", "query")) as { kind: string }[];
  expect(events.length).toBeGreaterThanOrEqual(2);
  expect(events.length).toBeLessThanOrEqual(3);
  expect(events.every((e) => e.kind === "cron")).toBe(true);
});

test("nextRun handles intervals and cron expressions in UTC", () => {
  expect(nextRun({ kind: "interval", ms: 1000 }, 1500)).toBe(2000);
  const t = Date.UTC(2026, 0, 1, 8, 59);
  expect(nextRun({ kind: "cron", expression: "0 9 * * *" }, t)).toBe(Date.UTC(2026, 0, 1, 9, 0));
});

const pg = dbAdapters.find(([l]) => l === "postgres");
if (pg)
  test("postgres: concurrent read-modify-write mutations retry on serialization conflicts", async () => {
    await db.close();
    await setup(pg[1]);
    const listId = (await run("todos:createList", "mutation", { name: "x" })) as string;
    const id = (await run("todos:add", "mutation", { listId, title: "t" })) as string;
    await Promise.all(Array.from({ length: 6 }, () => run("todos:toggle", "mutation", { id })));
    expect(((await run("todos:get", "query", { id })) as { done: boolean }).done).toBe(false); // 6 toggles
  });

test("returns validators: valid values pass, invalid ones fail the call", async () => {
  const listId = (await run("todos:createList", "mutation", { name: "r" })) as string;
  const id = (await run("todos:add", "mutation", { listId, title: "t" })) as string;
  expect(await run("todos:getChecked", "query", { id })).toMatchObject({ _id: id, title: "t" });
  expect(await run("todos:getChecked", "query", { id: "todos:0" })).toBeNull();
  expect(await run("todos:voidAction", "action")).toBeNull();
  await expect(run("todos:wrongQueryReturn", "query")).rejects.toThrow("Invalid return value: returns must be a string, got 5");
});

test("a mutation whose return value fails validation rolls back", async () => {
  const listId = (await run("todos:createList", "mutation", { name: "rollback" })) as string;
  published = [];
  await expect(run("todos:wrongMutationReturn", "mutation", { listId })).rejects.toThrow('Invalid return value: returns must be an Id<"lists">');
  expect(await run("todos:listByList", "query", { listId })).toEqual([]);
  expect(published).toEqual([]);
});

test("internal functions: hidden from requests, callable from functions", async () => {
  await run("todos:createList", "mutation", { name: "a" });
  await expect(exec.run("todos:secretCount", "query", {}, {})).rejects.toThrow('Unknown function "todos:secretCount"');
  expect((await exec.run("todos:secretCount", "query", {}, {}, { allowInternal: true })).value).toBe(1);
  expect(await run("todos:callsInternal", "action")).toBe(1);
});

test("calls time out; a timed-out mutation writes nothing, even if its handler keeps going", async () => {
  await expect(run("todos:slowQuery", "query", { ms: 1000 })).rejects.toThrow("todos:slowQuery timed out after 300 ms");
  const listId = (await run("todos:createList", "mutation", { name: "t" })) as string;
  await expect(run("todos:slowWrite", "mutation", { listId, ms: 600 })).rejects.toThrow("timed out");
  await Bun.sleep(500); // the handler wakes up and tries to insert
  expect(await run("todos:listByList", "query", { listId })).toEqual([]);
});

test("results over the size limit fail", async () => {
  expect(await run("todos:bigResult", "query", { bytes: 100 })).toHaveLength(100);
  await expect(run("todos:bigResult", "query", { bytes: 5000 })).rejects.toThrow("MAX_RESULT_BYTES");
});

test("errors are classified for the caller", async () => {
  const kind = async (p: Promise<unknown>) => serializeError(await p.then(() => undefined, (e) => e));
  expect(await kind(run("todos:forgeFail", "mutation"))).toMatchObject({ kind: "user", data: { code: "LIMIT", max: 3 } });
  expect(await kind(run("todos:add", "mutation", { title: 1 }))).toMatchObject({ kind: "validation" });
  expect(await kind(run("todos:slowQuery", "query", { ms: 1000 }))).toMatchObject({ kind: "timeout" });
  expect(await kind(run("todos:crash", "query"))).toMatchObject({ kind: "internal", message: "secret internal detail" });
});

test("an action whose server died is failed once its lease expires", async () => {
  const loop = new SchedulerLoop(exec, db, project.functions, [], 1000);
  await db.execute(`INSERT INTO "_scheduled_functions" ("_id", "_creationTime", "name", "args", "scheduledTime", "state", "completedTime") VALUES (?, ?, ?, ?, ?, 'running', ?)`, [
    "_scheduled_functions:dead", Date.now(), "todos:addViaAction", "{}", Date.now() - 5000, Date.now() - 5000,
  ]);
  await loop.sweep();
  const [job] = await db.query<{ state: string; error: string }>(`SELECT "state", "error" FROM "_scheduled_functions" WHERE "_id" = ?`, ["_scheduled_functions:dead"]);
  expect(job).toEqual({ state: "failed", error: "Interrupted: the server running this action stopped" });
});
