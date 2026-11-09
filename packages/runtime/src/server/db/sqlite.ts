import { Database } from "bun:sqlite";
import { closeSync, fsync, openSync } from "node:fs";
import { nativeDb } from "./native";
import { createNativeSqliteDb } from "./sqlite-native";
import { totalmem } from "node:os";
import { dirname } from "node:path";
import { ftsTable, migrateSqlite } from "./migrate";
import { scopedTx, type Db, type DbTx, type Dialect } from "./types";

const field = (name: string) => `json_extract("doc", '$.${name}')`;

// json_extract returns 1/0 for booleans and minified JSON text for arrays/objects.
const encode = (value: unknown) => (typeof value === "boolean" ? Number(value) : typeof value === "object" && value !== null ? JSON.stringify(value) : value);

export const sqliteDialect: Dialect = {
  name: "sqlite",
  realType: "REAL",
  jsonType: "TEXT",
  jsonParam: "?",
  valueParam: "?",
  encode,
  field,
  // A range, so an index on the field serves it: in SQLite's binary order every string with the prefix sorts between these two.
  startsWith: (name, prefix) => ({ sql: `(${field(name)} >= ? AND ${field(name)} < ?)`, params: [prefix, prefix + "\u{10FFFF}"] }),
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    return { sql: `${field(name)} = ?`, params: [encode(value)] };
  },
  listIndexesSql: `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
  // The first statement reads the value alone, so an index on the field answers it without reading a document. It can't tell JSON `true`
  // from 1 (both read as 1), so when a value is 0 or 1 a second statement asks those documents, and only those, for their types.
  async numberStats(run, table, name, where, params) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return undefined;
    const path = `'$.${name}'`;
    const v = `json_extract("doc", ${path})`;
    const [row] = await run(
      `SELECT COUNT(*) AS "rows", COUNT(${v}) AS "n", SUM(typeof(${v}) NOT IN ('integer', 'null')) AS "nonint", SUM(typeof(${v}) NOT IN ('integer', 'real', 'null')) AS "bad", SUM(${v} IN (0, 1)) AS "amb", TOTAL(${v}) AS "sum", MIN(${v}) AS "min", MAX(${v}) AS "max" FROM "${table}" ${where}`,
      params,
    );
    if (!row) return undefined;
    let bad = Number(row.bad ?? 0);
    if (!bad && Number(row.amb ?? 0) > 0) {
      const [odd] = await run(`SELECT SUM(json_type("doc", ${path}) NOT IN ('integer', 'real', 'null')) AS "bad" FROM "${table}" ${where ? `${where} AND` : "WHERE"} ${v} IN (0, 1)`, params);
      bad = Number(odd?.bad ?? 0);
    }
    const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
    return { rows: Number(row.rows), n: Number(row.n ?? 0), bad, nonint: Number(row.nonint ?? 0), sum: Number(row.sum ?? 0), min: num(row.min), max: num(row.max) };
  },
  // 25,000 documents with a search index were two statements each (a DELETE of an entry that is not there, and an INSERT): seeding ran at 2,700
  // documents a second. New documents need only the INSERT, and many rows to a statement.
  searchInsertMany(table, index, rows) {
    const fts = ftsTable(table, index);
    const out: { sql: string; params: unknown[] }[] = [];
    for (let i = 0; i < rows.length; i += 500) {
      const part = rows.slice(i, i + 500);
      out.push({ sql: `INSERT INTO "${fts}" (doc_id, body) VALUES ${part.map(() => "(?, ?)").join(", ")}`, params: part.flatMap((r) => [r.id, r.text]) });
    }
    return out;
  },
  searchWrite(table, index, id, text) {
    const fts = ftsTable(table, index);
    const del = { sql: `DELETE FROM "${fts}" WHERE doc_id = ?`, params: [id] };
    return text === undefined ? [del] : [del, { sql: `INSERT INTO "${fts}" (doc_id, body) VALUES (?, ?)`, params: [id, text] }];
  },
  searchSql(table, index, _field, terms, filters, limit) {
    const fts = ftsTable(table, index);
    const match = terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
    return {
      sql: `SELECT "${table}"."_id", "${table}"."_creationTime", "${table}"."doc" FROM "${fts}" JOIN "${table}" ON "${table}"."_id" = "${fts}".doc_id WHERE "${fts}" MATCH ?${filters.map((f) => ` AND ${f.sql}`).join("")} ORDER BY "${fts}".rank LIMIT ${limit}`,
      params: [match, ...filters.flatMap((f) => f.params)],
    };
  },
};

// Checkpoints copy the WAL back into the database file and fsync it. Run by whichever connection commits, they would stall the event
// loop of the process that serves requests, so the connections here never checkpoint: a thread with its own connection does, passively
// (it never waits for or blocks readers or the writer), once the WAL passes 32 MiB, so each hot page is copied once per 32 MiB of writes
// rather than on every few commits.
//
// A passive checkpoint cannot make the WAL start over: that happens only when a write transaction begins with nothing left to copy, and a
// writer that commits again and again always has a commit between the end of the checkpoint and its next transaction, so under writes that
// never pause the file grew without a limit (357 MB in 3 seconds of inserts, about 6 KB each). Past 64 MiB the thread therefore tells the
// writer to hold its next batch ("pause"), takes the write lock with a RESTART checkpoint (which copies the little that is left, as only the
// newest version of each page is copied, and waits for the readers) and lets it go on ("resume"): the next write starts the WAL over, and
// the file is cut back to its size limit. Reads are not held, writes wait for the length of one checkpoint (milliseconds).
const checkpointer = (path: string) => `import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
const db = new Database(${JSON.stringify(path)});
db.exec("PRAGMA busy_timeout = 0");
const passive = db.query("PRAGMA wal_checkpoint(PASSIVE)");
const restart = db.query("PRAGMA wal_checkpoint(RESTART)");
// statSync every time: a BunFile keeps the size it first read
const walSize = () => {
  try {
    return statSync(${JSON.stringify(path + "-wal")}).size;
  } catch {
    return 0;
  }
};
let lastLog = -1;
setInterval(() => {
  try {
    const size = walSize();
    if (size <= 32 * 1024 * 1024) return;
    const { log } = passive.get();
    // Over the hard limit and written to since the last look (an idle database waits for its next write to start the WAL over).
    if (size > 64 * 1024 * 1024 && log !== lastLog) {
      postMessage("pause");
      db.exec("PRAGMA busy_timeout = 5000");
      try {
        restart.get();
      } finally {
        db.exec("PRAGMA busy_timeout = 0");
        postMessage("resume");
      }
    }
    lastLog = log;
  } catch {
    postMessage("resume");
  }
}, 250);`;

/**
 * Makes commits durable without stopping the thread that runs the functions. `synchronous = FULL` would fsync inside COMMIT, on that
 * thread: every commit then costs the disk's sync time (about 3.5 ms on the test disk) in which nothing else runs, and with 64 clients
 * inserts went from 12,700 to 6,500 a second. Here the writer's connection runs with `synchronous = NORMAL` (the commit is only written
 * to the WAL) and the WAL file is fsynced through the asynchronous `fs.fsync`, which Bun runs on its thread pool: a write is answered when
 * an fsync that began after its commit has finished, which is the promise FULL makes, while the writer carries on with the next batch.
 * Syncs are one at a time, and the commits that arrive while one runs share the next (a second level of group commit); each fsync covers
 * everything written before it started. (Two at a time were slower: the kernel serializes them.)
 */
/** @internal exported for tests */
export class WalSyncer {
  private inflight = false;
  private waiting: { resolve(): void; reject(e: Error): void }[] = [];
  private dirSynced = false;
  constructor(
    private walPath: string,
    private dbPath: string,
  ) {}
  private async fsync(path: string) {
    const fd = openSync(path, "r"); // fsync flushes the file, not the descriptor's writes: any descriptor on it will do
    try {
      await new Promise<void>((resolve, reject) => fsync(fd, (e) => (e ? reject(e) : resolve())));
    } finally {
      closeSync(fd);
    }
  }
  private async start() {
    this.inflight = true;
    const batch = this.waiting;
    this.waiting = [];
    try {
      try {
        await this.fsync(this.walPath);
      } catch (e) {
        if ((e as { code?: string }).code !== "ENOENT") throw e;
        await this.fsync(this.dbPath); // no WAL file (yet): whatever was committed went to the database file
      }
      // The first sync of a new WAL file also needs its directory entry on disk (SQLite does the same).
      if (!this.dirSynced) (await this.fsync(dirname(this.walPath)), (this.dirSynced = true));
      for (const w of batch) w.resolve();
    } catch (e) {
      for (const w of batch) w.reject(new Error(`could not sync the write-ahead log: ${(e as Error).message}`));
    }
    this.inflight = false;
    if (this.waiting.length) void this.start();
  }
  /** Resolves once an fsync that began after this call has finished. */
  sync() {
    return new Promise<void>((resolve, reject) => {
      this.waiting.push({ resolve, reject });
      if (!this.inflight) void this.start();
    });
  }
}

const MiB = 2 ** 20;
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** The RAM this process may use: the container's limit when it has one (`totalmem()` is the host's), else the machine's. */
export const serverMemory = () => Math.min(totalmem(), process.constrainedMemory?.() || Infinity);

/**
 * How much of `ram` SQLite takes, over `connections` connections. Reads are memory-mapped (a quarter of the RAM, 64 MiB to the 2 GiB
 * SQLite allows): pages come straight from the OS's file cache, with no read() call or copy, and the mapping uses no memory of its own
 * beyond that cache, which the OS reclaims under pressure. Each connection's page cache gets an equal share of a sixteenth of the RAM
 * (8 MiB to 1 GiB in all), instead of SQLite's 2 MiB each.
 */
export function sqliteMemory(ram: number, connections: number) {
  return { mmapBytes: Math.floor(clamp(ram / 4, 64 * MiB, 0x7fff0000)), cacheKiB: Math.floor(clamp(ram / 16, 8 * MiB, 1024 * MiB) / connections / 1024) };
}

/**
 * WAL mode, one write connection (group commit, below), a small pool of readers. `:memory:` runs everything on one connection. With
 * `ram` (bytes), the connections are sized to it (`sqliteMemory`) and sorts and temporary indexes stay in memory; without it they keep
 * SQLite's defaults.
 *
 * `synchronous` is how hard a commit is pushed to the disk. `FULL` (the default) syncs the WAL at every commit, so a write that was
 * answered survives a power cut or a crash of the operating system; group commit shares that sync among the writes that queue up. `NORMAL`
 * syncs only when the WAL is checkpointed: it survives a crash of this process but can lose the last commits to a power cut (the database
 * itself stays consistent). It is for data that can be lost, like telemetry.
 */
export function createSqliteDb(path: string, readers = 4, ram?: number, synchronous: "FULL" | "NORMAL" = "FULL"): Db {
  // DB_ENGINE=native in the environment moves every file database onto the native engine, the tests' included (the server asks for it through open.ts).
  if (path !== ":memory:" && process.env.DB_ENGINE === "native") {
    const native = nativeDb();
    if (native) return createNativeSqliteDb(path, native, readers, ram, synchronous);
  }
  return createBunSqliteDb(path, readers, ram, synchronous);
}

/** SQLite on bun:sqlite: the JavaScript DocStore over it, with the JavaScript read cache. */
export function createBunSqliteDb(path: string, readers = 4, ram?: number, synchronous: "FULL" | "NORMAL" = "FULL"): Db {
  const memory = path === ":memory:";
  const syncer = !memory && synchronous === "FULL" ? new WalSyncer(path + "-wal", path) : undefined;
  const sized = ram && !memory ? sqliteMemory(ram, readers + 1) : undefined;
  const open = () => {
    const c = new Database(path, { create: true });
    c.exec("PRAGMA busy_timeout = 5000");
    if (!memory) c.exec("PRAGMA wal_autocheckpoint = 0");
    if (sized) {
      c.exec(`PRAGMA mmap_size = ${sized.mmapBytes}`);
      c.exec(`PRAGMA cache_size = -${sized.cacheKiB}`);
      c.exec("PRAGMA temp_store = MEMORY");
    }
    return c;
  };
  const writer = open();
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA synchronous = NORMAL"); // with FULL, the WalSyncer does what FULL's COMMIT would (see WalSyncer)
  writer.exec("PRAGMA journal_size_limit = 67108864"); // after a checkpoint lets the WAL restart, it is cut back to 64 MiB
  const pool = memory
    ? []
    : Array.from({ length: readers }, () => {
        const c = open();
        c.exec("PRAGMA query_only = ON");
        return c;
      });
  const waiting: ((c: Database) => void)[] = [];
  let checkpointThread: Worker | undefined;
  /** The checkpoint thread is restarting the WAL (see `checkpointer`): the writer starts no batch until it is done. */
  let paused = false;
  let wake: (() => void) | undefined;
  // The path is part of the script, not a message: a message sent before the thread has loaded can be lost, and then nothing ever checkpoints.
  if (!memory) {
    checkpointThread = new Worker(URL.createObjectURL(new Blob([checkpointer(path)], { type: "application/javascript" })));
    (checkpointThread as unknown as { unref(): void }).unref();
    checkpointThread.onmessage = (e: MessageEvent) => {
      if (e.data === "pause") paused = true;
      else if (e.data === "resume") (paused = false), wake?.();
    };
  }

  // Group commit. Write transactions run one at a time on the writer, but those that queue up meanwhile run back to back in one SQLite
  // transaction, each in its own savepoint, and commit together: one COMMIT (and its locking and WAL work) for the lot. Each still sees the
  // writes before it, fails alone (its savepoint rolls back), and resolves only after the shared COMMIT, so a reply always means committed (on disk, with `synchronous` FULL).
  // Statements that can't run inside a transaction (PRAGMA, VACUUM), and everything on `:memory:`, go through the same queue, alone.
  type Job = { exclusive: boolean; fn: (tx: DbTx) => Promise<unknown>; resolve(v: unknown): void; reject(e: unknown): void };
  const queue: Job[] = [];
  let draining = false;
  const MAX_BATCH = 256;
  const BATCH_MS = 10;
  // Prepared once: exec() would parse these again for every transaction.
  const control = {
    begin: writer.prepare("BEGIN IMMEDIATE"),
    commit: writer.prepare("COMMIT"),
    rollback: writer.prepare("ROLLBACK"),
    savepoint: writer.prepare("SAVEPOINT g"),
    release: writer.prepare("RELEASE g"),
    rollbackTo: writer.prepare("ROLLBACK TO g"),
  };

  /** Answers jobs whose work is committed: at once, or (`synchronous = FULL`) once the WAL holding it is on disk. */
  const settle = (jobs: [Job, unknown][]) => {
    if (!syncer) return void jobs.forEach(([job, value]) => job.resolve(value));
    syncer.sync().then(
      () => jobs.forEach(([job, value]) => job.resolve(value)),
      (e) => jobs.forEach(([job]) => job.reject(e)),
    );
  };

  const enqueue = <T>(exclusive: boolean, fn: (tx: DbTx) => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push({ exclusive, fn, resolve: resolve as (v: unknown) => void, reject });
      if (draining) return;
      draining = true;
      // After the rest of this turn of the event loop, so the writes of every request read in the same turn join one batch.
      setImmediate(drain);
    });

  async function drain() {
    try {
      while (queue.length) {
        if (paused) {
          // Waits for "resume"; a thread that died or a restart that hangs cannot hold the writes for more than 6 s.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => ((paused = false), resolve()), 6000);
            wake = () => (clearTimeout(timer), resolve());
          });
          wake = undefined;
          continue;
        }
        if (queue[0]!.exclusive) {
          const job = queue.shift()!;
          const tx = scopedTx(txOf(writer));
          let run: Promise<unknown>;
          try {
            run = job.fn(tx);
          } catch (e) {
            run = Promise.reject(e); // a callback that throws before returning its promise fails its job, not the queue
          }
          await run.then((value) => settle([[job, value]]), job.reject).finally(() => tx.end());
          continue;
        }
        try {
          control.begin.run(); // can fail after busy_timeout when another process holds the write lock
        } catch (e) {
          queue.shift()!.reject(e);
          continue;
        }
        const done: [Job, unknown][] = [];
        let aborted: unknown;
        const started = performance.now();
        while (queue.length && !queue[0]!.exclusive && done.length < MAX_BATCH && performance.now() - started < BATCH_MS) {
          const job = queue.shift()!;
          control.savepoint.run();
          const tx = scopedTx(txOf(writer));
          try {
            const value = await job.fn(tx);
            tx.end();
            control.release.run();
            done.push([job, value]);
          } catch (e) {
            tx.end();
            job.reject(e);
            try {
              control.rollbackTo.run();
              control.release.run();
            } catch {
              aborted = e; // SQLite already rolled the whole transaction back (e.g. disk full): the rest of the batch goes with it
              break;
            }
          }
        }
        try {
          if (aborted) throw aborted;
          control.commit.run();
        } catch (e) {
          if (writer.inTransaction) control.rollback.run();
          for (const [job] of done) job.reject(e);
          continue;
        }
        if (done.length) settle(done);
      }
    } finally {
      draining = false;
    }
  }

  /**
   * Runs a statement and returns its rows. An EXPLAIN goes through a statement of its own that is finalized: bun:sqlite's cached statement
   * (`query()`) for an EXPLAIN is not reset by `.all()`, and while it stays active the connection keeps its read snapshot after COMMIT, so
   * every later read on that connection sees the database as it was (the dev-only query-plan check did this to `where()` queries).
   */
  const all = (c: Database, sql: string, params: unknown[] = []) => {
    if (!/^\s*EXPLAIN\b/i.test(sql)) return c.query(sql).all(...(params as any[])) as any[];
    const statement = c.prepare(sql);
    try {
      return statement.all(...(params as any[])) as any[];
    } finally {
      statement.finalize();
    }
  };

  const acquire = () => new Promise<Database>((resolve) => (pool.length ? resolve(pool.pop()!) : waiting.push(resolve)));
  const release = (c: Database) => (waiting.length ? waiting.shift()!(c) : pool.push(c));

  const txOf = (c: Database): DbTx => ({
    async query(sql, params = []) {
      return all(c, sql, params);
    },
    async execute(sql, params = []) {
      c.query(sql).run(...(params as any[]));
    },
  });

  /**
   * A read transaction on a reader connection, begun at its first statement (SQLite takes the snapshot there anyway), so a read answered
   * entirely from the executor's read cache costs no BEGIN or COMMIT. BEGIN and COMMIT are prepared once per connection.
   */
  const readerStatements = new Map<Database, { begin: ReturnType<Database["prepare"]>; commit: ReturnType<Database["prepare"]> }>();
  async function read<T>(c: Database, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    let st = readerStatements.get(c);
    if (!st) readerStatements.set(c, (st = { begin: c.prepare("BEGIN"), commit: c.prepare("COMMIT") }));
    const statements = st;
    let begun = false;
    const start = () => {
      if (!begun) (statements.begin.run(), (begun = true));
    };
    const tx = scopedTx({
      async query(sql, params = []) {
        start();
        return all(c, sql, params);
      },
      async execute(sql, params = []) {
        start();
        c.query(sql).run(...(params as any[]));
      },
    });
    try {
      const result = await fn(tx);
      tx.end();
      if (begun) statements.commit.run();
      return result;
    } catch (e) {
      tx.end();
      if (c.inTransaction) c.exec("ROLLBACK");
      throw e;
    }
  }

  const db: Db = {
    dialect: sqliteDialect,
    async query(sql, params) {
      if (memory) return enqueue(true, (tx) => tx.query(sql, params));
      const c = await acquire();
      try {
        return await txOf(c).query(sql, params);
      } finally {
        release(c);
      }
    },
    execute: (sql, params) => enqueue(true, (tx) => tx.execute(sql, params)),
    async transaction(mode, fn) {
      if (mode === "write") return enqueue(false, fn);
      if (memory) return enqueue(true, (tx) => fn(tx)); // one connection: a read waits its turn like everything else
      const c = await acquire();
      try {
        return await read(c, fn);
      } finally {
        release(c);
      }
    },
    migrate: (tables) => migrateSqlite(db, tables),
    async close() {
      await enqueue(true, async () => {}); // after everything already queued
      checkpointThread?.terminate();
      for (const c of [writer, ...pool]) c.close();
    },
  };
  return db;
}
