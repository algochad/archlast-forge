// SQLite on the native document engine (packages/db). The engine owns the database file's connections, its tables and indexes, its documents, queries and cache;
// this file is the part that runs JavaScript's functions between its calls: the writer's queue and group commit, the pool of readers' waiting list, and the fsync
// that makes an answered write durable. Whatever uses the database in the engine's own terms (the DocStore) finds the engine on `db.native` and on each transaction.
import { join } from "node:path";
import { unlock } from "./unlock";
import { hashName, ftsTable } from "./migrate";
import { call, NativeHandle, nativeDb, type NativeEngine, type NativeDb } from "./native";
import { sqliteDialect, sqliteMemory, WalSyncer } from "./sqlite";
import type { Db, DbTx, TableSpec } from "./types";

/** The schema as the engine takes it: each index with its fields and its name in the database (a hash of its definition, as it has always been). */
export function schemaSpec(tables: TableSpec[]): string {
  return JSON.stringify({
    tables: tables.map((t) => ({
      name: t.name,
      creation: { fields: [], sql: hashName(t.name, "by_creation_time", "") },
      indexes: Object.entries(t.indexes).map(([name, fields]) => [name, { fields, sql: hashName(t.name, name, fields.join(",")) }]),
      search: Object.entries(t.searchIndexes ?? {}).map(([name, c]) => [name, { field: c.searchField, fts: ftsTable(t.name, name) }]),
      fields: t.fields,
      strict: t.strict,
    })),
  });
}

/** A transaction as the database layer hands it out: raw statements on the transaction's connection, and the handle the DocStore uses for the engine's operations. */
class NativeTx implements DbTx {
  private open = true;
  constructor(
    private readonly engine: NativeEngine,
    readonly native: NativeHandle,
  ) {}
  private check() {
    if (!this.open) throw new Error("Transaction already finished: the function kept using the database after it returned or timed out");
  }
  async query<T = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
    this.check();
    return JSON.parse(call(() => this.engine.all(this.native.id, sql, params as never)));
  }
  async execute(sql: string, params: unknown[] = []): Promise<void> {
    this.check();
    call(() => this.engine.run(this.native.id, sql, params as never));
  }
  /** The function that was given this transaction is over: it may not use it any more (the engine's number may be someone else's by now). */
  end() {
    this.open = false;
    this.native.revoke();
  }
}

/** The servers of one cluster (several processes on one database file): this one's place in it. */
export interface ClusterSeat {
  size: number;
  index: number;
  /** Whether this handle keeps the write-ahead log (the checkpoint's thread): one of all that share the file. */
  keeper?: boolean;
  /** The folder the servers' shared files are in (the commit counters of their read caches). */
  dir?: string;
}

export function createNativeSqliteDb(path: string, native: NativeDb, readers = 4, ram?: number, synchronous: "FULL" | "NORMAL" = "FULL", cluster?: ClusterSeat): Db {
  const syncer = synchronous === "FULL" ? new WalSyncer(path + "-wal", path) : undefined;
  const sized = ram ? sqliteMemory(ram, readers + 1) : undefined;
  // In a cluster one process keeps the write-ahead log (the first), and all of them see its pause (a lock beside the file).
  const shared = cluster !== undefined && cluster.size > 1;
  const engine: NativeEngine = new native.Engine(path, JSON.stringify({ readers, mmapBytes: sized?.mmapBytes, cacheKiB: sized?.cacheKiB, checkpoint: !shared || (cluster.keeper ?? cluster.index === 0), shared, epochs: shared && cluster.dir ? join(cluster.dir, "epochs.shm") : undefined }));

  // ---- the writer: group commit ----
  // Write transactions run one at a time on the writer, but those that queue up meanwhile run back to back in one SQLite transaction, each in its own savepoint,
  // and commit together: one COMMIT for the lot. Each still sees the writes before it, fails alone (its savepoint rolls back), and resolves only after the shared
  // COMMIT, so a reply always means committed (on disk, with `synchronous` FULL). Statements that can't run inside a transaction go through the same queue, alone.
  type Job = { exclusive: boolean; fn: (tx: DbTx) => Promise<unknown>; resolve(v: unknown): void; reject(e: unknown): void };
  /** A job that ran in a batch: what it answered and its transaction in the engine, which ends (settling the cache, telling the DocStore what it wrote) once the batch is committed. */
  type Done = [Job, unknown, NativeHandle];
  const queue: Job[] = [];
  let draining = false;
  const MAX_BATCH = 256;
  const BATCH_MS = 10;

  /** Batches committed and waiting for the disk: closing waits for them, since they end their transactions in the engine. */
  let settling = 0;
  const settle = (jobs: Done[]) => {
    const answer = () => jobs.forEach(([job, value, handle]) => (handle.end(true), job.resolve(value)));
    const refuse = (e: unknown) => jobs.forEach(([job, , handle]) => (handle.end(false), job.reject(e)));
    if (!syncer) return answer();
    settling++;
    syncer.sync().then(answer, refuse).finally(() => settling--);
  };

  const enqueue = <T>(exclusive: boolean, fn: (tx: DbTx) => Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      queue.push({ exclusive, fn, resolve: resolve as (v: unknown) => void, reject });
      if (draining) return;
      draining = true;
      // After the rest of this turn of the event loop, so the writes of every request read in the same turn join one batch.
      setImmediate(drain);
    });

  /** The transaction handed to a job of the writer: raw statements on the writer, and the engine's operations for the DocStore. */
  const writerTx = () => new NativeTx(engine, new NativeHandle(engine, "write", true));

  /**
   * Tries for the write lock until it is had, yielding between tries: at once a few times, then until another server says it let go (or 2 ms pass); gives up after 30 s.
   * False when the log's keeper asked for the lock meanwhile: the caller holds its batch (a writer that kept taking the lock would starve the checkpoint).
   */
  async function lockedByAnother(): Promise<boolean> {
    const until = performance.now() + 30_000;
    for (let n = 0; ; n++) {
      if (performance.now() > until) throw new Error("the database is locked by another process (waited 30 s for the write lock)");
      if (n < 4) await new Promise<void>((resolve) => setImmediate(resolve));
      else
        await new Promise<void>((resolve) => {
          const wake = () => (clearTimeout(timer), unlock.waiters.delete(wake), resolve());
          const timer = setTimeout(wake, 2);
          unlock.waiters.add(wake);
        });
      if (engine.paused()) return false;
      if (engine.writerBegin()) return true;
    }
  }

  async function drain() {
    try {
      while (queue.length) {
        if (engine.paused()) {
          // The native thread holds the write lock for a checkpoint (milliseconds): the batch waits, the loop does not block. The thread lowers the flag
          // when it is done, and gives up after its own 5 s busy timeout.
          const until = performance.now() + 6000;
          while (engine.paused() && performance.now() < until) await Bun.sleep(1);
          continue;
        }
        if (queue[0]!.exclusive) {
          const job = queue.shift()!;
          const tx = writerTx();
          let run: Promise<unknown>;
          try {
            run = job.fn(tx);
          } catch (e) {
            run = Promise.reject(e); // a callback that throws before returning its promise fails its job, not the queue
          }
          await run
            .then(
              (value) => settle([[job, value, tx.native]]),
              (e) => (tx.native.end(false), job.reject(e)),
            )
            .finally(() => tx.end());
          continue;
        }
        try {
          // The write lock may be another process's (a cluster of servers): wait for it without blocking this event loop, which SQLite's own busy handler would.
          if (!engine.writerBegin() && !(await lockedByAnother())) continue; // (held: the top of the loop waits out the pause)
        } catch (e) {
          queue.shift()!.reject(e);
          continue;
        }
        const done: Done[] = [];
        let aborted: unknown;
        const started = performance.now();
        while (queue.length && !queue[0]!.exclusive && done.length < MAX_BATCH && performance.now() - started < BATCH_MS) {
          const job = queue.shift()!;
          engine.writerSql("SAVEPOINT g");
          const tx = writerTx();
          try {
            const value = await job.fn(tx);
            tx.end();
            engine.writerSql("RELEASE g");
            done.push([job, value, tx.native]);
          } catch (e) {
            tx.end();
            tx.native.end(false);
            job.reject(e);
            try {
              engine.writerSql("ROLLBACK TO g");
              engine.writerSql("RELEASE g");
            } catch {
              aborted = e; // SQLite already rolled the whole transaction back (e.g. disk full): the rest of the batch goes with it
              break;
            }
          }
        }
        try {
          if (aborted) throw aborted;
          engine.writerSql("COMMIT");
          if (shared) unlock.send(); // a server that waits for the write lock may have it
        } catch (e) {
          if (engine.writerInTransaction()) engine.writerSql("ROLLBACK");
          if (shared) unlock.send();
          for (const [job, , handle] of done) (handle.end(false), job.reject(e));
          continue;
        }
        if (done.length) settle(done);
      }
    } finally {
      draining = false;
    }
  }

  // ---- the readers ----
  // A reader is the engine's: `beginRead` hands one out and says -1 when they are all in use, and a read then waits here for a release.
  const waiting: (() => void)[] = [];
  /** Reads that have a reader (or wait for one): closing waits for them. */
  let reading = 0;
  async function read<T>(cached: boolean, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    reading++;
    try {
      let id = engine.beginRead(cached);
      while (id < 0) {
        await new Promise<void>((resolve) => waiting.push(resolve));
        id = engine.beginRead(cached);
      }
      const handle = new NativeHandle(engine, "read", cached, id);
      const tx = new NativeTx(engine, handle);
      try {
        const result = await fn(tx);
        tx.end();
        handle.end(true);
        return result;
      } catch (e) {
        tx.end();
        handle.end(false);
        throw e;
      } finally {
        waiting.shift()?.();
      }
    } finally {
      reading--;
    }
  }

  const db: Db = {
    dialect: sqliteDialect,
    engine,
    async query(sql, params) {
      return read(false, (tx) => tx.query(sql, params));
    },
    execute: (sql, params) => enqueue(true, (tx) => tx.execute(sql, params)),
    async transaction(mode, fn, options) {
      if (mode === "write") return enqueue(false, fn);
      return read(options?.cached ?? false, fn);
    },
    // Through the writer's queue, alone: the statements that make tables and indexes are not part of a batch.
    migrate: (tables) => enqueue(true, async () => void call(() => engine.migrate(schemaSpec(tables)))),
    async close() {
      await enqueue(true, async () => {}); // after everything already queued
      for (const until = performance.now() + 5000; (reading > 0 || settling > 0) && performance.now() < until; ) await Bun.sleep(1); // and after the reads in flight and the commits waiting for the disk (a graceful shutdown lets them finish)
      engine.close();
    },
  };
  return db;
}

