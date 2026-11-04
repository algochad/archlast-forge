// ACID, checked on every database adapter (SQLite always; Postgres with TEST_POSTGRES_URL, MongoDB with TEST_MONGODB_URL).
//
// What each letter means for this engine, and where these tests stop:
//   Atomicity   a mutation (and what it schedules, and a multi-step auth flow) commits whole or not at all.
//   Consistency every write is validated against the schema first; invariants an app keeps in its mutations hold under concurrency.
//   Isolation   mutations behave as if run one at a time (no lost updates, no write skew, no phantoms); a query sees one snapshot.
//   Durability  what was answered survives a crash of the process (kill -9 below) and, on SQLite with SQLITE_SYNCHRONOUS=FULL, a power cut
//               (argued in docs/decisions.md; a test cannot cut the power). Postgres and MongoDB keep their own guarantees.
// Actions and files are not transactions by design (docs/decisions.md): they are not tested here.
import { afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import type { Db } from "../src/server/db/types";
import { Executor } from "../src/server/executor";
import { loadProject, tableSpecs, type Project } from "../src/server/project";
import { migrateScheduler, schedule } from "../src/server/scheduler";
import { createMongoDb } from "../src/server/db/mongodb";
import { createSqliteDb } from "../src/server/db/sqlite";
import { dbAdapters, tempDir } from "./helpers";

// Contended transactions on Postgres and MongoDB abort and run again, so the concurrent cases take a while there.
setDefaultTimeout(60_000);

const fixture = join(import.meta.dir, "fixture");
let project: Project | undefined;
let open: Db | undefined;
afterEach(async () => {
  await open?.close();
  open = undefined;
});

async function setup(makeDb: () => Promise<Db>) {
  project ??= await loadProject(fixture);
  const db = (open = await makeDb());
  await db.migrate(tableSpecs(project.tables));
  await migrateScheduler(db);
  const published: string[][] = [];
  const exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    limits: { functionTimeoutMs: 10_000, actionTimeoutMs: 10_000, maxResultBytes: 1 << 20, maxDocumentBytes: 1 << 20 },
    publish: (t) => published.push(t),
    log: () => {},
  });
  return { db, exec, published, project };
}
const count = async (exec: Executor, table: string) => (await exec.read((s) => s.query(table as "lists").collect())).value.length;
const boom = new Error("boom");

describe.each(dbAdapters)("ACID on %s", (_name, makeDb) => {
  // ---- Atomicity ----
  test("A: a mutation that fails after writing leaves none of its writes, and publishes nothing", async () => {
    const { exec, published } = await setup(makeDb);
    await expect(
      exec.mutate(async (s) => {
        const listId = await s.insert("lists", { name: "l" });
        await s.insert("todos", { listId, title: "t", done: false });
        throw boom;
      }),
    ).rejects.toThrow("boom");
    expect([await count(exec, "lists"), await count(exec, "todos")]).toEqual([0, 0]);
    expect(published).toEqual([]);
  });

  test("A: a write the schema refuses undoes the writes before it in the same mutation", async () => {
    const { exec } = await setup(makeDb);
    await expect(
      exec.mutate(async (s) => {
        const listId = await s.insert("lists", { name: "l" });
        await s.insert("todos", { listId, title: 42 as unknown as string, done: false }); // wrong type
      }),
    ).rejects.toThrow();
    expect(await count(exec, "lists")).toBe(0);
  });

  test("A: what a mutation schedules exists only if the mutation commits", async () => {
    const { db, exec, project } = await setup(makeDb);
    const jobs = async () => ((await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "_scheduled_functions"`))[0] as { n: number }).n;
    await expect(
      exec.mutate(async (_s, tx) => {
        await schedule(tx, project.functions, Date.now() + 60_000, "todos:logEvent", { kind: "x" });
        throw boom;
      }),
    ).rejects.toThrow("boom");
    expect(Number(await jobs())).toBe(0);
    await exec.mutate((_s, tx) => schedule(tx, project.functions, Date.now() + 60_000, "todos:logEvent", { kind: "x" }));
    expect(Number(await jobs())).toBe(1);
  });

  test("A: concurrent mutations, some failing after writing: exactly the successful ones remain", async () => {
    const { exec } = await setup(makeDb);
    const results = await Promise.allSettled(
      Array.from({ length: 60 }, (_, i) =>
        exec.mutate(async (s) => {
          await s.insert("events", { kind: `e${i}`, at: i });
          if (i % 5 === 0) throw boom; // after its write
        }),
      ),
    );
    const ok = results.flatMap((r, i) => (r.status === "fulfilled" ? [i] : []));
    expect(ok).toHaveLength(48);
    const stored = (await exec.read((s) => s.query("events").collect())).value.map((e) => e.at).sort((a, b) => a - b);
    expect(stored).toEqual(ok);
  });

  test("A: a batch import changes nothing when it fails, and the replace and the rows are one step", async () => {
    const { exec } = await setup(makeDb);
    await exec.mutate((s) => s.insert("events", { kind: "old", at: 1 }));
    await expect(
      exec.rewrite(async (s) => {
        for (const d of await s.query("events").collect()) await s.delete(d._id);
        await s.insert("events", { kind: "new", at: 2 });
        throw boom; // cut off halfway
      }),
    ).rejects.toThrow("boom");
    expect((await exec.read((s) => s.query("events").collect())).value.map((e) => e.kind)).toEqual(["old"]);
  });

  // ---- Consistency ----
  test("C: a document the schema refuses is never stored, whatever else the mutation did", async () => {
    const { exec } = await setup(makeDb);
    const listId = await exec.mutate((s) => s.insert("lists", { name: "l" }));
    await expect(exec.mutate((s) => s.insert("todos", { listId, title: "t", done: "yes" as unknown as boolean }))).rejects.toThrow();
    await expect(exec.mutate((s) => s.insert("todos", { listId, title: "t", done: false, extra: 1 } as never))).rejects.toThrow();
    expect(await count(exec, "todos")).toBe(0);
  });

  test("C: money moved between accounts concurrently: the total never changes and nothing goes negative", async () => {
    const { exec } = await setup(makeDb);
    const ids: string[] = [];
    for (let i = 0; i < 8; i++) ids.push(await exec.mutate((s) => s.insert("notes", { body: `a${i}`, tag: "acct", n: 100 })));
    const transfer = (from: string, to: string, amount: number) =>
      exec.mutate(async (s) => {
        const a = (await s.get(from))!;
        const b = (await s.get(to))!;
        if (a.n < amount) return false;
        await s.patch(from, { n: a.n - amount });
        await s.patch(to, { n: b.n + amount });
        return true;
      });
    // Under this much contention a database that retries conflicts (Postgres) can run a mutation out of its ten attempts and answer it with the
    // conflict; that is an honest failure, not a lost update, so what is checked is what the mutations that were answered left behind.
    await Promise.allSettled(
      Array.from({ length: 300 }, (_, i) => transfer(ids[i % 8]!, ids[(i * 3 + 1) % 8]! === ids[i % 8] ? ids[(i + 1) % 8]! : ids[(i * 3 + 1) % 8]!, 1 + (i % 40))),
    );
    const balances = (await exec.read((s) => s.query("notes").collect())).value.map((n) => n.n);
    expect(balances.reduce((a, b) => a + b, 0)).toBe(800);
    expect(Math.min(...balances)).toBeGreaterThanOrEqual(0);
  });

  // ---- Isolation ----
  test("I: 200 concurrent read-modify-write increments of one document: every one that was answered is counted, none lost", async () => {
    const { exec } = await setup(makeDb);
    const id = await exec.mutate((s) => s.insert("notes", { body: "counter", tag: "c", n: 0 }));
    const results = await Promise.allSettled(
      Array.from({ length: 200 }, () =>
        exec.mutate(async (s) => {
          const d = (await s.get(id))!;
          await s.patch(id, { n: d.n + 1 });
        }),
      ),
    );
    const answered = results.filter((r) => r.status === "fulfilled").length;
    expect(answered).toBeGreaterThan(0);
    // A database that retries conflicts (Postgres) can run a mutation out of its ten attempts under this much contention and answer it with the
    // conflict. That is a failure the caller sees, not a lost update: the count is exactly the increments that were answered.
    expect((await exec.read((s) => s.get(id))).value?.n).toBe(answered);
  });

  test("I: no phantoms: 40 concurrent claims of one name, checked by a query, store exactly one", async () => {
    const { exec } = await setup(makeDb);
    const results = await Promise.allSettled(
      Array.from({ length: 40 }, () =>
        exec.mutate(async (s) => {
          const taken = await s.query("notes").withIndex("by_tag_n", (q) => q.eq("tag", "claim")).collect();
          if (taken.length) return false;
          await s.insert("notes", { body: "owner", tag: "claim", n: 1 });
          return true;
        }),
      ),
    );
    expect(results.filter((r) => r.status === "fulfilled" && r.value)).toHaveLength(1);
    expect((await exec.read((s) => s.query("notes").withIndex("by_tag_n", (q) => q.eq("tag", "claim")).collect())).value).toHaveLength(1);
  });

  test("I: no write skew: two on-call doctors, each leaves only if the other stays; one always stays", async () => {
    const { exec } = await setup(makeDb);
    for (let round = 0; round < 12; round++) {
      const a = await exec.mutate((s) => s.insert("notes", { body: "doctor", tag: `oncall${round}`, n: 1 }));
      const b = await exec.mutate((s) => s.insert("notes", { body: "doctor", tag: `oncall${round}`, n: 1 }));
      const leave = (me: string) =>
        exec.mutate(async (s) => {
          const on = (await s.query("notes").withIndex("by_tag_n", (q) => q.eq("tag", `oncall${round}`)).collect()).filter((d) => d.n === 1);
          if (on.length >= 2) await s.patch(me, { n: 0 });
        });
      await Promise.all([leave(a), leave(b)]);
      const still = (await exec.read((s) => s.query("notes").withIndex("by_tag_n", (q) => q.eq("tag", `oncall${round}`)).collect())).value.filter((d) => d.n === 1);
      expect(still.length).toBeGreaterThanOrEqual(1);
    }
  });

  test("I: a query sees one snapshot: while transfers run, the total it reads is always the same", async () => {
    const { exec } = await setup(makeDb);
    const ids: string[] = [];
    for (let i = 0; i < 6; i++) ids.push(await exec.mutate((s) => s.insert("notes", { body: `a${i}`, tag: "acct", n: 50 })));
    let running = true;
    const writers = Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        exec.mutate(async (s) => {
          const from = ids[i % 6]!;
          const to = ids[(i + 1) % 6]!;
          const a = (await s.get(from))!;
          const b = (await s.get(to))!;
          await s.patch(from, { n: a.n - 1 });
          await s.patch(to, { n: b.n + 1 });
        }),
      ),
    ).finally(() => (running = false));
    const totals = new Set<number>();
    while (running) {
      totals.add((await exec.read((s) => s.query("notes").collect())).value.reduce((sum, d) => sum + d.n, 0));
      await Bun.sleep(0); // reads on SQLite finish in microtasks: without a turn of the event loop the writers would never run
    }
    await writers;
    totals.add((await exec.read((s) => s.query("notes").collect())).value.reduce((sum, d) => sum + d.n, 0));
    expect([...totals]).toEqual([300]);
  });

  test("I: a write that was answered is visible to the next read", async () => {
    const { exec } = await setup(makeDb);
    for (let i = 0; i < 100; i++) {
      await exec.mutate((s) => s.insert("events", { kind: "k", at: i }));
      expect(await count(exec, "events")).toBe(i + 1);
    }
  });
});

// ---- Durability ----
test("D: after the engine is closed and opened again, everything that was answered is there", async () => {
  const file = join(tempDir(), "app.db");
  const first = await setup(async () => createSqliteDb(file));
  for (let i = 0; i < 50; i++) await first.exec.mutate((s) => s.insert("events", { kind: "k", at: i }));
  await first.db.close();
  open = undefined;
  const again = await setup(async () => createSqliteDb(file));
  expect(await count(again.exec, "events")).toBe(50);
});

test("D+A: a process killed in the middle of a mutation keeps what was answered and none of what was not", async () => {
  const file = join(tempDir(), "crash.db");
  const child = Bun.spawn(["bun", join(import.meta.dir, "fixture-crash-midway.ts"), file], { stdout: "pipe", stderr: "inherit" });
  const reader = child.stdout.getReader();
  let seen = "";
  while (!seen.includes("MIDWAY")) {
    const { value, done } = await reader.read();
    if (done) break;
    seen += new TextDecoder().decode(value);
  }
  child.kill("SIGKILL"); // between the two inserts of the second transaction
  await child.exited;
  expect(seen).toContain("MIDWAY");
  const db = createSqliteDb(file, 1);
  const kinds = (await db.query<{ k: string }>(`SELECT k FROM "t" ORDER BY k`)).map((r) => r.k);
  expect(kinds).toEqual(["answered-1", "answered-2"]); // neither half of the unfinished transaction
  await db.close();
}, 30_000);

// MongoDB is serializable through a shared guard document that only some mutations write (docs/decisions.md). The ones that do not need it must
// not pay for it: blind inserts and read-modify-write of the documents they read stay as concurrent as they were.
test.skipIf(!process.env.TEST_MONGODB_URL)("MongoDB: blind inserts and read-modify-write never take the guard; a scan does", async () => {
  const url = process.env.TEST_MONGODB_URL!;
  const name = `afx_guard_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`;
  const { exec } = await setup(async () => createMongoDb(url, { database: name }));
  const { MongoClient } = await import("mongodb");
  const client = new MongoClient(url);
  await client.connect();
  try {
    const taken = async () => ((await client.db(name).collection("_serial_guard").findOne({ _id: "serializable" } as never)) as { n?: number } | null)?.n ?? 0;
    await Promise.all(Array.from({ length: 50 }, (_, i) => exec.mutate((s) => s.insert("events", { kind: "k", at: i }))));
    expect(await taken()).toBe(0); // blind inserts
    const id = await exec.mutate((s) => s.insert("notes", { body: "c", tag: "c", n: 0 }));
    await Promise.all(
      Array.from({ length: 50 }, () =>
        exec.mutate(async (s) => {
          const d = (await s.get(id))!;
          await s.patch(id, { n: d.n + 1 });
        }),
      ),
    );
    expect(await taken()).toBe(0); // read-modify-write of one document
    const other = await exec.mutate((s) => s.insert("notes", { body: "d", tag: "d", n: 5 }));
    await exec.mutate(async (s) => {
      const a = (await s.get(id))!;
      const b = (await s.get(other))!;
      await s.patch(id, { n: a.n + 1 });
      await s.patch(other, { n: b.n - 1 });
    });
    expect(await taken()).toBe(0); // read-modify-write of two documents it read and wrote
    await exec.mutate(async (s) => {
      await s.query("notes").collect();
      await s.insert("events", { kind: "scan", at: 1 });
    });
    expect(await taken()).toBeGreaterThan(0); // a scan
  } finally {
    await client.db(name).dropDatabase();
    await client.close();
  }
});
