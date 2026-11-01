import { Database } from "bun:sqlite";
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
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    return { sql: `${field(name)} = ?`, params: [encode(value)] };
  },
  listIndexesSql: `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
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
const checkpointer = (path: string) => `import { Database } from "bun:sqlite";
const db = new Database(${JSON.stringify(path)});
db.exec("PRAGMA busy_timeout = 0");
const checkpoint = db.query("PRAGMA wal_checkpoint(PASSIVE)");
setInterval(() => {
  try {
    if (Bun.file(${JSON.stringify(path + "-wal")}).size > 32 * 1024 * 1024) checkpoint.get();
  } catch {}
}, 250);`;

/** WAL mode, one write connection (group commit, below), a small pool of readers. `:memory:` runs everything on one connection. */
export function createSqliteDb(path: string, readers = 4): Db {
  const memory = path === ":memory:";
  const open = () => {
    const c = new Database(path, { create: true });
    c.exec("PRAGMA busy_timeout = 5000");
    if (!memory) c.exec("PRAGMA wal_autocheckpoint = 0");
    return c;
  };
  const writer = open();
  writer.exec("PRAGMA journal_mode = WAL");
  writer.exec("PRAGMA synchronous = NORMAL");
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
  // The path is part of the script, not a message: a message sent before the thread has loaded can be lost, and then nothing ever checkpoints.
  if (!memory) {
    checkpointThread = new Worker(URL.createObjectURL(new Blob([checkpointer(path)], { type: "application/javascript" })));
    (checkpointThread as unknown as { unref(): void }).unref();
  }

  // Group commit. Write transactions run one at a time on the writer, but those that queue up meanwhile run back to back in one SQLite
  // transaction, each in its own savepoint, and commit together: one COMMIT (and its locking and WAL work) for the lot. Each still sees the
  // writes before it, fails alone (its savepoint rolls back), and resolves only after the shared COMMIT, so a reply always means committed.
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
        if (queue[0]!.exclusive) {
          const job = queue.shift()!;
          const tx = scopedTx(txOf(writer));
          let run: Promise<unknown>;
          try {
            run = job.fn(tx);
          } catch (e) {
            run = Promise.reject(e); // a callback that throws before returning its promise fails its job, not the queue
          }
          await run.then(job.resolve, job.reject).finally(() => tx.end());
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
        for (const [job, value] of done) job.resolve(value);
      }
    } finally {
      draining = false;
    }
  }

  const acquire = () => new Promise<Database>((resolve) => (pool.length ? resolve(pool.pop()!) : waiting.push(resolve)));
  const release = (c: Database) => (waiting.length ? waiting.shift()!(c) : pool.push(c));

  const txOf = (c: Database): DbTx => ({
    async query(sql, params = []) {
      return c.query(sql).all(...(params as any[])) as any[];
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
        return c.query(sql).all(...(params as any[])) as any[];
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
