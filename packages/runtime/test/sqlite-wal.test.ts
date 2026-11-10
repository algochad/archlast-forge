import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBunSqliteDb, createSqliteDb } from "../src/server/db/sqlite";

const MiB = 2 ** 20;

test("writes that never pause do not make the WAL grow without a limit, and nothing is lost", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-wal-"));
  const path = join(dir, "app.db");
  const db = createSqliteDb(path, 2, undefined, "NORMAL");
  await db.transaction("write", async (tx) => void (await tx.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, doc TEXT, k INTEGER)")));
  await db.transaction("write", async (tx) => void (await tx.execute("CREATE INDEX tk ON t (k)")));
  const payload = "x".repeat(900); // about four pages of WAL per insert with the index
  let inserted = 0;
  let peak = 0;
  const started = performance.now();
  // 32 writers that start the next write as soon as the last one is answered, for 5 seconds, as a client under load does
  await Promise.all(
    Array.from({ length: 32 }, async (_, w) => {
      while (performance.now() - started < 5000) {
        await db.transaction("write", async (tx) => void (await tx.execute("INSERT INTO t (doc, k) VALUES (?, ?)", [payload, inserted++ * 7919 + w])));
        if (inserted % 200 === 0) peak = Math.max(peak, statSync(`${path}-wal`).size);
      }
    }),
  );
  const n = (await db.transaction("read", async (tx) => ((await tx.query("SELECT count(*) AS n FROM t")) as { n: number }[])[0]!.n)) as number;
  expect(n).toBe(inserted); // every acknowledged write is there
  // The checkpoint thread asks the writer to pause past 64 MiB; a busy reader can delay a restart.
  expect(inserted).toBeGreaterThan(20_000); // the test wrote enough for the old behavior to reach gigabytes
  const bounded = peak < 400 * MiB;
  await db.close();
  rmSync(dir, { recursive: true, force: true }); // before the assertion: a failing run must not leave gigabytes behind
  expect(bounded).toBe(true);
}, 30_000);

test("a continuously queued burst lets the checkpointer restart the WAL", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-wal-"));
  const path = join(dir, "app.db");
  const db = createBunSqliteDb(path, 2, undefined, "NORMAL");
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, doc TEXT)");
    const payload = "x".repeat(32768);
    let peak = 0;
    const jobs = Array.from({ length: 15000 }, (_, i) =>
      db.transaction("write", async (tx) => {
        await tx.execute("INSERT INTO t (doc) VALUES (?)", [payload]);
        if (i % 100 === 0) peak = Math.max(peak, statSync(`${path}-wal`).size);
      }),
    );
    await Promise.all(jobs);
    const rows = await db.transaction("read", (tx) => tx.query("SELECT count(*) AS n FROM t"));
    expect(rows[0]!.n).toBe(15000);
    expect(peak).toBeLessThan(400 * MiB);
  } finally {
    await db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test.each(["startup", "restart", "error"] as const)("a queued burst stops when checkpoint worker %s is stalled or fails", async (mode) => {
  const dir = mkdtempSync(join(tmpdir(), "afx-wal-delayed-"));
  const path = join(dir, "app.db");
  const RealWorker = globalThis.Worker;
  const callbacks: { error?: (event: ErrorEvent) => void; message?: (event: MessageEvent) => void } = {};
  // Real timeout integration: the worker runs, but its ready or restart response is held.
  function DelayedWorker(...args: ConstructorParameters<typeof Worker>) {
    const worker = new RealWorker(...args);
    Object.defineProperty(worker, "onmessage", {
      set(fn: (event: MessageEvent) => void) {
        callbacks.message = fn;
      },
    });
    Object.defineProperty(worker, "onerror", {
      set(fn: (event: ErrorEvent) => void) {
        callbacks.error = fn;
      },
    });
    worker.addEventListener("message", (event) => {
      if (mode === "restart" && event.data.type === "ready") callbacks.message?.(event);
    });
    return worker;
  }
  globalThis.Worker = DelayedWorker as unknown as typeof Worker;
  let db: ReturnType<typeof createBunSqliteDb>;
  try {
    db = createBunSqliteDb(path, 2, undefined, "NORMAL");
  } finally {
    globalThis.Worker = RealWorker;
  }
  const releaseReader = Promise.withResolvers<void>();
  const readerStarted = Promise.withResolvers<void>();
  let reader: Promise<void> | undefined;
  let jobs: Promise<unknown[]> | undefined;
  let closed = false;
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, doc TEXT)");
    // Pin a snapshot so passive checkpoints cannot recycle the WAL while the worker is delayed.
    reader = db.transaction("read", async (tx) => {
      await tx.query("SELECT count(*) FROM t");
      readerStarted.resolve();
      await releaseReader.promise;
    });
    await readerStarted.promise;
    const payload = "x".repeat(32768);
    jobs = Promise.all(
      Array.from({ length: 6000 }, () =>
        db.transaction("write", async (tx) => {
          await tx.execute("INSERT INTO t (doc) VALUES (?)", [payload]);
        }),
      ),
    );
    void jobs.catch(() => {});
    // Failure or timeout is an observable signal: queued writes must wait for that worker and fail, not run ahead.
    if (mode === "error") callbacks.error?.(new ErrorEvent("error", { message: "delayed worker failed" }));
    const error = mode === "error" ? "delayed worker failed" : `worker ${mode} timed out`;
    await expect(jobs).rejects.toThrow(error);
    const rows = await db.query("SELECT count(*) AS n FROM t");
    expect(rows[0]!.n).toBeGreaterThan(0);
    expect(rows[0]!.n).toBeLessThan(6000);
    expect(statSync(`${path}-wal`).size).toBeLessThan(96 * MiB);
    releaseReader.resolve();
    await reader;
    await expect(db.close()).rejects.toThrow(error);
    closed = true;
  } finally {
    releaseReader.resolve();
    await reader;
    await jobs?.catch(() => {});
    if (!closed) await db.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);

test("a pinned reader reports a busy restart and writes continue until it releases its snapshot", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-wal-reader-"));
  const path = join(dir, "app.db");
  const RealWorker = globalThis.Worker;
  const busy = Promise.withResolvers<void>();
  const afterBusy = Promise.withResolvers<void>();
  let busyReported = false;
  const callbacks: { message?: (event: MessageEvent) => void } = {};
  function ObservedWorker(...args: ConstructorParameters<typeof Worker>) {
    const worker = new RealWorker(...args);
    Object.defineProperty(worker, "onmessage", {
      set(fn: (event: MessageEvent) => void) {
        callbacks.message = fn;
      },
    });
    worker.addEventListener("message", (event) => {
      callbacks.message?.(event);
      if (event.data.type === "restarted" && event.data.busy) {
        busyReported = true;
        busy.resolve();
      }
    });
    return worker;
  }
  globalThis.Worker = ObservedWorker as unknown as typeof Worker;
  let db: ReturnType<typeof createBunSqliteDb>;
  try {
    db = createBunSqliteDb(path, 2, undefined, "FULL");
  } finally {
    globalThis.Worker = RealWorker;
  }
  const releaseReader = Promise.withResolvers<void>();
  const readerStarted = Promise.withResolvers<void>();
  let reader: Promise<void> | undefined;
  let jobs: Promise<unknown[]> | undefined;
  let closed = false;
  try {
    await db.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, doc TEXT)");
    reader = db.transaction("read", async (tx) => {
      await tx.query("SELECT count(*) FROM t");
      readerStarted.resolve();
      await releaseReader.promise;
    });
    await readerStarted.promise;
    const payload = "x".repeat(32768);
    jobs = Promise.all(
      Array.from({ length: 4000 }, () =>
        db.transaction("write", async (tx) => {
          await tx.execute("INSERT INTO t (doc) VALUES (?)", [payload]);
          if (busyReported) afterBusy.resolve();
        }),
      ),
    );
    void jobs.catch(() => {});
    // SQLite's busy timeout is intentionally real: the live reader must prevent RESTART, not just its message.
    await busy.promise;
    await afterBusy.promise; // a busy checkpoint leaves the reader alone and lets the writer continue
    releaseReader.resolve();
    await reader;
    await jobs;
    await db.close();
    closed = true;
    const reopened = new Database(path, { readonly: true });
    try {
      const row = reopened.query("SELECT count(*) AS n FROM t").get() as { n: number };
      expect(row.n).toBe(4000);
    } finally {
      reopened.close();
    }
  } finally {
    releaseReader.resolve();
    await reader;
    await jobs?.catch(() => {});
    if (!closed) await db.close().catch(() => {});
    rmSync(dir, { recursive: true, force: true });
  }
}, 30000);
