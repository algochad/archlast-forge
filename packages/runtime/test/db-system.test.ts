// The engine's own tables (the scheduler, admins, audit, environment, settings, migrations, backups) on every adapter: the same statements, the same
// answers. MongoDB has no SQL, so mongodb-sql.ts runs them there; this is what keeps it to what the engine really writes.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  addAdmin,
  adminOp,
  listAdmins,
  removeAdmin,
} from "../src/server/admin-ops";
import type { Db } from "../src/server/db/types";
import { removeEnv, setEnv, listEnv } from "../src/server/env-store";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs, type Project } from "../src/server/project";
import {
  cancelScheduled,
  migrateScheduler,
  retryScheduled,
  schedule,
  SchedulerLoop,
} from "../src/server/scheduler";
import { dbAdapters } from "./helpers";

const fixture = join(import.meta.dir, "fixture");
let project: Project;

for (const [label, make] of dbAdapters) {
  describe(`engine tables: ${label}`, () => {
    let db: Db;
    let exec: Executor;
    beforeEach(async () => {
      project ??= await loadProject(fixture);
      db = await make();
      await db.migrate(tableSpecs(project.tables));
      await migrateScheduler(db);
      await migrateScheduler(db); // every server runs it at startup
      exec = new Executor({
        db,
        tables: project.tables,
        functions: project.functions,
        limits: {
          functionTimeoutMs: 5000,
          actionTimeoutMs: 5000,
          maxResultBytes: 1 << 20,
          maxDocumentBytes: 1 << 20,
        },
        publish: () => {},
        log: () => {},
      });
    });
    afterEach(() => db.close());

    const jobs = () =>
      db.query<{
        _id: string;
        name: string;
        state: string;
        error: string | null;
        completedTime: number | null;
      }>(
        `SELECT * FROM "_scheduled_functions" ORDER BY "scheduledTime", "_id"`,
      );
    const events = async () =>
      (
        (await exec.call("todos:events", "query", {}, null)).value as {
          kind: string;
        }[]
      )
        .map((e) => e.kind)
        .sort();

    test("a scheduled mutation commits with the mutation that scheduled it, and not without it", async () => {
      await exec.call(
        "todos:scheduleEvent",
        "mutation",
        { kind: "kept", delayMs: 0 },
        null,
      );
      expect(await jobs()).toMatchObject([
        {
          name: "todos:logEvent",
          state: "pending",
          error: null,
          completedTime: null,
        },
      ]);
      // the same transaction fails: its job and its document both disappear
      await expect(
        exec.mutate(async (store, tx) => {
          await store.insert("lists", { name: "gone" });
          await schedule(
            tx,
            project.functions,
            0,
            { _name: "todos:logEvent" },
            { kind: "rolled back" },
          );
          throw new Error("boom");
        }),
      ).rejects.toThrow("boom");
      expect(await jobs()).toHaveLength(1);
      expect(
        Number(
          (
            await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "lists"`)
          )[0]!.n,
        ),
      ).toBe(0);
    });

    test("a due job runs once even when two servers poll at once; later ones wait", async () => {
      const a = new SchedulerLoop(exec, db, project.functions, []);
      const b = new SchedulerLoop(exec, db, project.functions, []);
      await exec.call(
        "todos:scheduleEvent",
        "mutation",
        { kind: "soon", delayMs: 0 },
        null,
      );
      await exec.call(
        "todos:scheduleEvent",
        "mutation",
        { kind: "later", delayMs: 60_000 },
        null,
      );
      await Promise.all([a.tick(), b.tick()]);
      expect(await events()).toEqual(["soon"]);
      expect((await jobs()).map((j) => j.state)).toEqual([
        "success",
        "pending",
      ]);
    });

    test("cancel and retry", async () => {
      const id = (
        await exec.call(
          "todos:scheduleEvent",
          "mutation",
          { kind: "x", delayMs: 60_000 },
          null,
        )
      ).value as string;
      await exec.mutate((_s, tx) => cancelScheduled(tx, id));
      expect((await jobs())[0]).toMatchObject({ _id: id, state: "canceled" });
      expect((await jobs())[0]!.completedTime).toBeGreaterThan(0);
      const again = await exec.mutate((_s, tx) => retryScheduled(tx, id));
      expect((await jobs()).map((j) => j.state).sort()).toEqual([
        "canceled",
        "pending",
      ]);
      expect((await jobs()).find((j) => j._id === again)?.name).toBe(
        "todos:logEvent",
      );
      await expect(
        exec.mutate((_s, tx) => retryScheduled(tx, again)),
      ).rejects.toThrow("Only failed or canceled jobs can be retried");
    });

    test("a cron run is inserted once, whoever computes it; leases expire; finished jobs are pruned", async () => {
      const cron = {
        name: "tick",
        fn: "todos:logEvent",
        args: { kind: "cron" },
        schedule: { kind: "interval" as const, ms: 1000 },
      };
      const loops = [0, 1, 2].map(
        () =>
          new SchedulerLoop(
            exec,
            db,
            project.functions,
            [cron as never],
            700_000,
            500,
            1000,
          ),
      );
      await Promise.all(loops.map((l) => l.tick(Date.now() + 1500)));
      const cronJobs = (await jobs()).filter((j) =>
        j._id.startsWith("_scheduled_functions:cron:"),
      );
      expect(new Set(cronJobs.map((j) => j._id)).size).toBe(cronJobs.length);
      expect((await events()).every((k) => k === "cron")).toBe(true);
      expect((await events()).length).toBe(cronJobs.length);
      // a running action whose server died
      await db.execute(
        `INSERT INTO "_scheduled_functions" ("_id", "_creationTime", "name", "args", "scheduledTime", "state", "completedTime") VALUES (?, ?, ?, ?, ?, 'running', ?)`,
        [
          "_scheduled_functions:dead",
          Date.now(),
          "todos:addViaAction",
          "{}",
          1,
          1,
        ],
      );
      await loops[0]!.sweep();
      expect(
        (await jobs()).find((j) => j._id === "_scheduled_functions:dead"),
      ).toMatchObject({
        state: "failed",
        error: "Interrupted: the server running this action stopped",
      });
      await loops[0]!.prune(Date.now() + 10_000);
      expect(await jobs()).toEqual([]);
    });

    test("admins, sessions and the audit log", async () => {
      await addAdmin(db, "Ada@Example.com", "correct horse battery", "admin");
      await addAdmin(db, "bob@example.com", "another long password", "viewer");
      await addAdmin(
        db,
        "ada@example.com",
        "a different long password",
        "viewer",
      ); // the same email: updated, not added
      expect(await listAdmins(db)).toMatchObject([
        { email: "ada@example.com", role: "viewer" },
        { email: "bob@example.com", role: "viewer" },
      ]);
      const deps = {
        db,
        exec,
        functions: project.functions,
        tables: project.tables,
        crons: [],
        storage: undefined,
        serverId: "t",
        dev: true,
      } as never;
      const login = (await adminOp(
        deps,
        "login",
        { email: "ada@example.com", password: "a different long password" },
        "x",
      )) as { token: string };
      expect(typeof login.token).toBe("string");
      expect(
        await adminOp(deps, "session", { token: login.token }, "x"),
      ).toMatchObject({ email: "ada@example.com", role: "viewer" });
      await adminOp(deps, "logout", { token: login.token }, "x");
      expect(
        await adminOp(deps, "session", { token: login.token }, "x"),
      ).toBeNull();
      await removeAdmin(db, "bob@example.com");
      await expect(removeAdmin(db, "bob@example.com")).rejects.toThrow(
        "No admin",
      );
      expect((await listAdmins(db)).map((a) => a.email)).toEqual([
        "ada@example.com",
      ]);
      const audit = (await db.query<{ action: string; actor: string }>(
        `SELECT * FROM "_audit" ORDER BY "time" DESC LIMIT ?`,
        [10],
      )) as { action: string }[];
      expect(Array.isArray(audit)).toBe(true);
    });

    test("environment variables and settings", async () => {
      await setEnv(db, "B", "2");
      await setEnv(db, "A", "1");
      await setEnv(db, "B", "two");
      expect(await listEnv(db)).toMatchObject([
        { name: "A", value: "1" },
        { name: "B", value: "two" },
      ]);
      await removeEnv(db, "A");
      expect((await listEnv(db)).map((e) => e.name)).toEqual(["B"]);
      expect(Object.keys((await listEnv(db))[0]!).sort()).toEqual([
        "name",
        "updatedAt",
        "value",
      ]);
      await db.execute(
        `INSERT INTO "_settings" ("name", "value", "updatedAt", "updatedBy") VALUES (?, ?, ?, ?) ON CONFLICT ("name") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt", "updatedBy" = excluded."updatedBy"`,
        ["CACHE_TTL_MS", "5", 1, "me"],
      );
      await db.execute(
        `INSERT INTO "_settings" ("name", "value", "updatedAt", "updatedBy") VALUES (?, ?, ?, ?) ON CONFLICT ("name") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt", "updatedBy" = excluded."updatedBy"`,
        ["CACHE_TTL_MS", "7", 2, "you"],
      );
      await db.execute(
        `INSERT INTO "_settings" ("name", "value", "updatedAt", "updatedBy") VALUES (?, ?, ?, ?)`,
        ["BACKUP_KEEP", "3", 3, null],
      );
      expect(
        await db.query(
          `SELECT "name", "value", "updatedAt", "updatedBy" FROM "_settings" ORDER BY "name"`,
        ),
      ).toEqual([
        { name: "BACKUP_KEEP", value: "3", updatedAt: 3, updatedBy: null },
        { name: "CACHE_TTL_MS", value: "7", updatedAt: 2, updatedBy: "you" },
      ]);
      expect(
        await db.query(
          `SELECT "name", "value" FROM "_settings" WHERE "name" LIKE 'BACKUP_%'`,
        ),
      ).toEqual([{ name: "BACKUP_KEEP", value: "3" }]);
      await db.execute(`DELETE FROM "_settings" WHERE "name" = ?`, [
        "BACKUP_KEEP",
      ]);
      expect(await db.query(`SELECT "name" FROM "_settings"`)).toEqual([
        { name: "CACHE_TTL_MS" },
      ]);
    });

    test("migrations, backups rows, counts and the documents a backup reads", async () => {
      await db.execute(
        `INSERT INTO "_migrations" ("name", "state", "cursor", "processed", "error", "updatedAt") VALUES (?, ?, ?, ?, ?, ?)`,
        ["m1", "running", null, 0, null, 1],
      );
      await db.execute(
        `UPDATE "_migrations" SET "state" = ?, "cursor" = ?, "processed" = ?, "updatedAt" = ? WHERE "name" = ?`,
        ["done", "c", 7, 2, "m1"],
      );
      expect(
        await db.query(`SELECT * FROM "_migrations" WHERE "name" = ?`, ["m1"]),
      ).toEqual([
        {
          name: "m1",
          state: "done",
          cursor: "c",
          processed: 7,
          error: null,
          updatedAt: 2,
        },
      ]);
      expect(await db.query(`SELECT * FROM "_migrations"`)).toHaveLength(1);

      const claim = (id: string, at: number, kind = "scheduled") =>
        db.execute(
          `INSERT INTO "_backups" ("_id", "name", "createdAt", "kind", "state", "location", "progress", "actor", "server") VALUES (?, ?, ?, ?, 'running', ?, ?, ?, ?) ON CONFLICT ("_id") DO NOTHING`,
          [id, `n-${id}`, at, kind, "disk", id, "me", "s1"],
        );
      await claim("_backups:a", 10);
      await claim("_backups:a", 20); // another server, same slot: it lost
      await claim("_backups:b", 30);
      await claim("_backups:c", 5, "manual");
      const [a] = await db.query<{
        createdAt: number;
        progress: string;
        bytes: number | null;
        manifest: string | null;
      }>(`SELECT * FROM "_backups" WHERE "_id" = ?`, ["_backups:a"]);
      expect(a).toMatchObject({
        createdAt: 10,
        progress: "_backups:a",
        bytes: null,
        manifest: null,
      });
      await db.execute(
        `UPDATE "_backups" SET "state" = 'done', "bytes" = ?, "manifest" = ?, "progress" = NULL, "finishedAt" = ? WHERE "_id" = ?`,
        [99, "{}", 11, "_backups:a"],
      );
      await db.execute(
        `UPDATE "_backups" SET "progress" = ? WHERE "_id" = ? AND "state" = 'running'`,
        ["x", "_backups:a"],
      ); // finished: not touched
      expect(
        (
          await db.query<any>(`SELECT * FROM "_backups" WHERE "_id" = ?`, [
            "_backups:a",
          ])
        )[0],
      ).toMatchObject({
        state: "done",
        bytes: 99,
        progress: null,
        finishedAt: 11,
      });
      expect(
        (
          await db.query<any>(
            `SELECT * FROM "_backups" WHERE "kind" = 'scheduled' ORDER BY "createdAt" DESC`,
          )
        ).map((r) => r._id),
      ).toEqual(["_backups:b", "_backups:a"]);
      expect(
        (
          await db.query<any>(
            `SELECT MAX("createdAt") AS "at" FROM "_backups" WHERE "kind" = 'scheduled'`,
          )
        )[0].at,
      ).toBe(30);
      expect(
        (
          await db.query<any>(
            `SELECT MAX("createdAt") AS "at" FROM "_backups" WHERE "kind" = 'nothing'`,
          )
        )[0].at,
      ).toBeNull();
      await db.execute(
        `UPDATE "_backups" SET "state" = 'failed', "error" = ?, "finishedAt" = ? WHERE "state" = 'running' AND "server" = ?`,
        ["restarted", 40, "s1"],
      );
      expect(
        (
          await db.query<any>(
            `SELECT * FROM "_backups" ORDER BY "createdAt" DESC LIMIT 500`,
          )
        ).map((r) => r.state),
      ).toEqual(["failed", "done", "failed"]);
      await db.execute(`DELETE FROM "_backups" WHERE "_id" = ?`, [
        "_backups:c",
      ]);
      expect(
        Number(
          (
            await db.query<{ n: number }>(
              `SELECT COUNT(*) AS n FROM "_backups"`,
            )
          )[0]!.n,
        ),
      ).toBe(2);

      // document tables through SQL: what the dashboard counts and a backup reads, in pages by id
      const ids: string[] = [];
      for (let i = 0; i < 5; i++)
        ids.push(
          (
            await exec.call(
              "todos:createList",
              "mutation",
              { name: `l${i}` },
              null,
            )
          ).value as string,
        );
      expect(
        Number(
          (
            await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "lists"`)
          )[0]!.n,
        ),
      ).toBe(5);
      const page1 = await db.query<{
        _id: string;
        _creationTime: number;
        doc: unknown;
      }>(
        `SELECT "_id", "_creationTime", "doc" FROM "lists" WHERE "_id" > ? ORDER BY "_id" LIMIT 3`,
        [""],
      );
      const page2 = await db.query<{
        _id: string;
        _creationTime: number;
        doc: unknown;
      }>(
        `SELECT "_id", "_creationTime", "doc" FROM "lists" WHERE "_id" > ? ORDER BY "_id" LIMIT 3`,
        [page1.at(-1)!._id],
      );
      expect([...page1, ...page2].map((r) => r._id)).toEqual([...ids].sort());
      const doc = page1[0]!.doc;
      expect(
        JSON.parse(typeof doc === "string" ? doc : JSON.stringify(doc)),
      ).toMatchObject({ name: expect.stringMatching(/^l\d$/) });
    });
  });
}

describe("what mongodb-sql refuses", () => {
  const mongo = dbAdapters.find(([l]) => l === "mongodb");
  if (!mongo) return test.skip("needs TEST_MONGODB_URL", () => {});
  test("statements outside the engine's own shapes fail loudly", async () => {
    const db = await mongo[1]();
    try {
      await expect(
        db.query(`SELECT "a" FROM "t" WHERE "a" = ? OR "b" = ?`, [1, 2]),
      ).rejects.toThrow("MongoDB can't run this SQL");
      await expect(db.execute(`CREATE TABLE "x" ("a" TEXT)`)).rejects.toThrow(
        "only SELECT, INSERT, UPDATE and DELETE",
      );
      await expect(db.query(`SELECT "a" FROM "t" JOIN "u"`)).rejects.toThrow(
        "MongoDB can't run this SQL",
      );
    } finally {
      await db.close();
    }
  });
});
