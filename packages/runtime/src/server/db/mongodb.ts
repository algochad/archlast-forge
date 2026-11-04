// MongoDB. A collection per table, a document per row: `{ _id, _creationTime, doc: { …the fields }, _s_<index>: [terms] }`. `doc` is nested, as the
// SQL adapters keep it in a column, so an index on `doc.listId` is the index on `json_extract(doc, '$.listId')`, with `_creationTime` and `_id` after
// the fields so a range, an order and a keyset page are served by one index. There is no SQL: DocStore builds filters and sorts (see MongoOps) where it
// builds statements for the others. Transactions need a replica set (a single node is one: `--replSet rs0` and `rs.initiate()`).
import { MongoClient, type AnyBulkWriteOperation, type ClientSession, type Document } from "mongodb";
import { pointReads } from "./coalesce";
import { hashName, PREFIX } from "./migrate";
import { escapeRegex, searchField, searchWords } from "./mongodb-search";
import { runSql, SYSTEM_TABLES } from "./mongodb-sql";
import { scopedTx, type Db, type DbTx, type Dialect, type MongoFilter, type MongoOps, type NumberStats, type Row, type TransactionOptions } from "./types";

/** Not SQL: only the parts DocStore asks of a dialect while it is building statements that this adapter never runs. */
export const mongoDialect: Dialect = {
  name: "mongodb",
  realType: "",
  jsonType: "",
  jsonParam: "?",
  valueParam: "?",
  encode: (value) => value,
  field: (name) => `doc.${name}`,
  startsWith: () => ({ sql: "", params: [] }),
  fieldEquals: () => ({ sql: "", params: [] }),
  listIndexesSql: "",
  searchWrite: () => [],
  searchSql: () => ({ sql: "", params: [] }),
};

/** Thrown inside a read that tried a second operation outside a transaction: it is run again inside one. */
class NeedsSnapshot extends Error {}

export function createMongoDb(url: string, options: { database?: string; maxPoolSize?: number } = {}): Db {
  const client = new MongoClient(url, { ignoreUndefined: true, enableUtf8Validation: false, maxPoolSize: options.maxPoolSize ?? Math.max(10, navigator.hardwareConcurrency * 4), retryWrites: true });
  // Everything waits for the connection, and for a database that can do what the adapter needs: transactions (a replica set or a sharded cluster) on 6.0 or newer.
  const connected = client.connect().then(async () => {
    const admin = client.db("admin");
    const [hello, build] = await Promise.all([admin.command({ hello: 1 }), admin.command({ buildInfo: 1 })]);
    const major = Number(build.versionArray?.[0] ?? String(build.version).split(".")[0]);
    if (major < 6) throw new Error(`MongoDB ${build.version} is too old: the engine needs 6.0 or newer`);
    if (!hello.setName && hello.msg !== "isdbgrid")
      throw new Error("This MongoDB is a standalone server, and the engine needs transactions, which need a replica set (a single node is one: start mongod with --replSet rs0 and run rs.initiate()) or a sharded cluster");
  });
  connected.catch(() => {}); // whoever uses the database sees the error; this only keeps it from being an unhandled rejection until then
  const dbName = options.database ?? (new URL(url.replace(/^mongodb(\+srv)?:/, "http:")).pathname.slice(1) || "forge");
  const database = client.db(dbName);
  /** Search indexes of each table: their words are left out of what a read returns. */
  const searchIndexes = new Map<string, string[]>();
  const hide = (table: string) => {
    const fields = searchIndexes.get(table);
    return fields?.length ? { projection: Object.fromEntries(fields.map((f) => [f, 0])) } : {};
  };

  // get(id) outside a transaction: those that arrive while every connection is busy go out together as one find with $in.
  const point = pointReads<Row>(
    options.maxPoolSize ?? Math.max(10, navigator.hardwareConcurrency * 4),
    async (table, id) => (await database.collection<any>(table).find({ _id: id }, { ...hide(table), limit: 1 }).toArray())[0] as Row | undefined,
    async (table, ids) => new Map((await database.collection<any>(table).find({ _id: { $in: ids } }, hide(table)).toArray()).map((r) => [r._id as string, r as Row])),
  );

  /**
   * What one transaction holds. A write transaction starts without a session, and a transaction costs MongoDB several commands (a start, a
   * commit, a journal wait) where one document's write costs one, so it goes on without one for as long as it can stay correct:
   *  - a blind insert of one document is only held;
   *  - the first document read by id is read on its own (nothing else has been asked of the database, so one document is a consistent
   *    snapshot), and kept: a second read of it costs nothing;
   *  - a write of that document is held as a conditional one (the document must still be as it was read);
   * and the transaction ends with at most one held write, which goes out as a single-document write (no transaction: one document is atomic by
   * itself). Anything else (a second document read, a query, a second write, a read after a held write) needs the transaction: with nothing read
   * yet it starts, writes what was held and goes on; with a document already read the function is run again inside one (`Optimistic` is
   * thrown, and Executor.mutate runs the function again, as it does after a write conflict). A held write whose document changed meanwhile is a
   * write conflict, which is retried like one inside a transaction. `tail` is the last operation queued.
   */
  type Held =
    | { kind: "insert"; table: string; doc: Document }
    | { kind: "replace"; table: string; id: string; old: unknown; doc: Record<string, unknown>; search?: Record<string, string[]> }
    | { kind: "delete"; table: string; id: string; old: unknown };
  interface Live {
    session?: ClientSession;
    /** Starts the transaction (a write transaction only). */
    open?: () => Promise<void>;
    /** Still going on without a transaction. */
    optimistic: boolean;
    held: Held[];
    /** The documents read on their own, by table and id. */
    observed: Map<string, Row | undefined>;
    /** The documents read inside the transaction, so the second read of one is not a command. */
    rows: Map<string, Row | undefined>;
    /** The function was told it needs the transaction. */
    tripped: boolean;
    tail: Promise<unknown>;
  }
  const rowKey = (table: string, id: string) => `${table}\0${id}`;
  /** The function has to be run again inside a transaction. */
  class NeedsTransaction extends Error {}
  const conflict = () => Object.assign(new Error("Write conflict: the document changed since it was read"), { code: 112, errorLabels: ["TransientTransactionError"] });
  /** A document MongoDB can match by its stored value: no operator-looking key at its top. */
  const matchable = (doc: unknown) => typeof doc === "object" && doc !== null && !Object.keys(doc).some((k) => k.startsWith("$"));

  /** Something is asked of the database that a transaction is needed for. */
  const need = async (live: Live) => {
    if (live.session || !live.open) return;
    if (live.optimistic && live.observed.size) {
      live.tripped = true;
      throw new NeedsTransaction();
    }
    await live.open();
  };

  /**
   * MongoDB runs one operation at a time in a transaction and refuses a second that overlaps it. Functions do overlap them (a Promise.all of
   * gets is ordinary), so a transaction's operations are queued here, in the order they were asked for. `lazy` ones run without starting the
   * transaction.
   */
  const serial = (live: Live, before?: () => void) => {
    return <A extends unknown[], R>(f: (...a: A) => Promise<R>, lazy = false) =>
      (...a: A): Promise<R> => {
        before?.();
        if (!live.session && !live.open) return f(...a);
        const run = live.tail.then(async () => {
          if (!lazy) await need(live);
          return f(...a);
        });
        live.tail = run.catch(() => {});
        return run;
      };
  };

  /** The operations of one transaction (its session), or, without a session, of a read made outside one. */
  const opsOf = (live: Live, guard: ReturnType<typeof serial>): MongoOps => {
    const col = (table: string) => database.collection<any>(table);
    // read when an operation runs: the session of a write transaction exists only from its first operation
    const s = {
      get session() {
        return live.session;
      },
    };
    return {
      find: guard(async (table, q) => {
        const keys = Object.keys(q.filter);
        const id = q.limit === 1 && !q.sort && !q.skip && keys.length === 1 && keys[0] === "_id" && typeof q.filter._id === "string" ? (q.filter._id as string) : undefined;
        if (id !== undefined && !live.open) {
          const row = await point(table, id);
          return row ? [row] : [];
        }
        if (id !== undefined && live.optimistic && !live.session && !live.held.length) {
          const key = rowKey(table, id);
          if (live.observed.has(key)) return live.observed.get(key) ? [live.observed.get(key)!] : [];
          if (!live.observed.size) {
            const row = await point(table, id);
            live.observed.set(key, row);
            return row ? [row] : [];
          }
        }
        await need(live);
        const key = id !== undefined ? rowKey(table, id) : undefined;
        if (key !== undefined && live.rows.has(key)) return live.rows.get(key) ? [live.rows.get(key)!] : [];
        const found = (await col(table).find(q.filter, { ...s, ...hide(table), sort: q.sort as never, limit: q.limit, skip: q.skip, allowDiskUse: true }).toArray()) as Row[];
        if (key !== undefined) live.rows.set(key, found[0]);
        return found;
      }, true),
      search: guard(async (table, q) => {
        const words = `$${q.field}`;
        const last = q.terms.length - 1;
        // Every term must be there (an equality on the multikey index; the last term a range on it), and the filter fields.
        const match = { $and: [...q.terms.map((t, i) => ({ [q.field]: i === last ? { $regex: "^" + escapeRegex(t) } : t })), q.filter] };
        const tf = q.terms.map((t, i) => ({
          $size: { $filter: { input: words, as: "w", cond: i === last ? { $regexMatch: { input: "$$w", regex: "^" + escapeRegex(t) } } : { $eq: ["$$w", t] } } },
        }));
        const K1 = 1.2;
        const B = 0.75;
        return (await col(table)
          .aggregate(
            [
              { $match: match },
              { $addFields: { _len: { $size: words }, _tf: tf } },
              { $setWindowFields: { output: { _avg: { $avg: "$_len", window: { documents: ["unbounded", "unbounded"] } } } } },
              {
                $addFields: {
                  _score: {
                    $sum: {
                      $map: {
                        input: "$_tf",
                        as: "f",
                        in: { $divide: [{ $multiply: ["$$f", K1 + 1] }, { $add: ["$$f", { $multiply: [K1, { $add: [1 - B, { $multiply: [B, { $divide: ["$_len", "$_avg"] }] }] }] }] }] },
                      },
                    },
                  },
                },
              },
              { $sort: { _score: -1, _creationTime: 1, _id: 1 } },
              { $limit: q.limit },
              { $project: { _score: 0, _len: 0, _tf: 0, _avg: 0, ...hide(table).projection } },
            ],
            { ...s, allowDiskUse: true },
          )
          .toArray()) as Row[];
      }),
      count: guard((table, filter) => col(table).countDocuments(filter, s)),
      stats: guard(async (table, filter, field): Promise<NumberStats | undefined> => {
        const v = `$doc.${field}`;
        const isNumber = { $isNumber: v };
        const [row] = await col(table)
          .aggregate(
            [
              { $match: filter },
              {
                $group: {
                  _id: null,
                  rows: { $sum: 1 },
                  n: { $sum: { $cond: [isNumber, 1, 0] } },
                  bad: { $sum: { $cond: [{ $or: [isNumber, { $in: [{ $type: v }, ["null", "missing"]] }] }, 0, 1] } },
                  nonint: { $sum: { $cond: [{ $and: [isNumber, { $ne: [v, { $trunc: v }] }] }, 1, 0] } },
                  sum: { $sum: v },
                  min: { $min: v },
                  max: { $max: v },
                },
              },
            ],
            s,
          )
          .toArray();
        if (!row) return { rows: 0, n: 0, bad: 0, nonint: 0, sum: 0, min: null, max: null };
        const num = (x: unknown) => (x === null || x === undefined ? null : Number(x));
        return { rows: row.rows, n: row.n, bad: row.bad, nonint: row.nonint, sum: Number(row.sum ?? 0), min: num(row.min), max: num(row.max) };
      }),
      // One aggregation for all the parents ($documents makes a row of each; a $lookup with a pipeline finds its children through the index, in
      // order, and stops at the limit): MongoDB allows one operation at a time in a transaction, so a find for each parent could not go out together.
      childrenOf: guard(async (table, field, parents, sort, take) => {
        const rows = await database
          .aggregate(
            [
              { $documents: parents.map((id) => ({ p: id })) },
              { $lookup: { from: table, let: { p: "$p" }, pipeline: [{ $match: { $expr: { $eq: [`$doc.${field}`, "$$p"] } } }, { $sort: sort }, { $limit: take }, ...(hide(table).projection ? [{ $project: hide(table).projection }] : [])], as: "kids" } },
              { $unwind: "$kids" },
              { $replaceRoot: { newRoot: "$kids" } },
            ],
            s,
          )
          .toArray();
        return rows as Row[];
      }),
      countChildren: guard(async (table, field, parents) => {
        const rows = await col(table)
          .aggregate([{ $match: { [`doc.${field}`]: { $in: parents } } }, { $group: { _id: `$doc.${field}`, n: { $sum: 1 } } }], s)
          .toArray();
        return new Map(rows.map((r) => [r._id as string, r.n as number]));
      }),
      insert: guard(async (table, docs) => {
        if (live.open && !live.session && docs.length === 1 && !live.held.length) return void live.held.push({ kind: "insert", table, doc: docs[0] as Document });
        await need(live);
        for (const d of docs) live.rows.delete(rowKey(table, d._id));
        await col(table).insertMany(docs as Document[], { ...s, ordered: true });
      }, true),
      replace: guard(async (table, docs) => {
        const d = docs[0];
        if (live.optimistic && !live.session && docs.length === 1 && !live.held.length && d) {
          const seen = live.observed.get(rowKey(table, d._id));
          if (seen && matchable(seen.doc)) return void live.held.push({ kind: "replace", table, id: d._id, old: seen.doc, doc: d.doc, search: d.search });
        }
        await need(live);
        for (const x of docs) live.rows.delete(rowKey(table, x._id));
        await col(table).bulkWrite(
          docs.map((x) => ({ updateOne: { filter: { _id: x._id }, update: { $set: { doc: x.doc, ...x.search } } } })),
          { ...s, ordered: true },
        );
      }, true),
      delete: guard(async (table, id) => {
        if (live.optimistic && !live.session && !live.held.length) {
          const seen = live.observed.get(rowKey(table, id));
          if (seen && matchable(seen.doc)) return void live.held.push({ kind: "delete", table, id, old: seen.doc });
        }
        await need(live);
        live.rows.delete(rowKey(table, id));
        await col(table).deleteOne({ _id: id } as Document, s);
      }, true),
      clear: guard(async (table) => {
        live.rows.clear();
        await col(table).deleteMany({}, s);
      }),
    };
  };

  // The engine's own tables are written as SQL; mongodb-sql.ts runs those statements (in the transaction, so a scheduled job commits with the
  // mutation that scheduled it).
  const txOf = (live: Live, before?: () => void): DbTx => {
    const guard = serial(live, before);
    const run = { database, get session() { return live.session; } };
    const sql = guard((text: string, params?: unknown[]) => runSql(run, text, params));
    return {
      query: sql as DbTx["query"],
      execute: async (text, params) => void (await sql(text, params)),
      mongo: opsOf(live, guard),
    };
  };
  const liveOf = (session?: ClientSession): Live => ({ session, optimistic: false, held: [], observed: new Map(), rows: new Map(), tripped: false, tail: Promise.resolve() });

  // A read of one operation needs no transaction (a transaction is 2.3 ms against 0.45 for a find through the driver): it starts without one, and
  // if it makes a second operation it is thrown away and run again inside a snapshot transaction. See the same in postgres.ts.
  let missRate = 0;
  let probe = 0;
  const tryWithoutTransaction = () => missRate < 0.5 || ++probe % 64 === 0;
  async function readWithoutTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<{ value: T } | undefined> {
    let operations = 0;
    let tripped = false;
    const scoped = scopedTx(
      txOf(liveOf(), () => {
        if (operations++ > 0) {
          tripped = true;
          throw new NeedsSnapshot();
        }
      }),
    );
    try {
      const value = await fn(scoped);
      return tripped ? undefined : { value };
    } catch (e) {
      if (tripped || e instanceof NeedsSnapshot) return undefined;
      throw e;
    } finally {
      scoped.end();
    }
  }

  // Insert-only writes. MongoDB's cost for a transaction is mostly its commands (a start with the first operation, a commit) and, for the commit,
  // waiting for the journal. A mutation whose only write is one insert needs neither: one document is atomic by itself. Those inserts, from
  // however many mutations are running, go out together as an unordered insertMany (one command and one journal wait for all of them) while
  // the one before is in flight; a lone one goes out at once. Each mutation hears about its own document (a duplicate `_id` fails only its own).
  const INSERT_PIPELINE = 4;
  const INSERT_BATCH = 1000;
  const inserting = new Map<string, { inFlight: number; waiting: { doc: Document; done: (e?: unknown) => void }[] }>();
  function batched(table: string, doc: Document): Promise<void> {
    let q = inserting.get(table);
    if (!q) inserting.set(table, (q = { inFlight: 0, waiting: [] }));
    const queue = q;
    const sent = new Promise<void>((resolve, reject) => queue.waiting.push({ doc, done: (e) => (e === undefined ? resolve() : reject(e)) }));
    const pump = () => {
      while (queue.inFlight < INSERT_PIPELINE && queue.waiting.length) {
        const batch = queue.waiting.splice(0, INSERT_BATCH);
        queue.inFlight++;
        void (async () => {
          const col = database.collection<any>(table);
          try {
            if (batch.length === 1) await col.insertOne(batch[0]!.doc);
            else await col.insertMany(batch.map((b) => b.doc), { ordered: false });
            for (const b of batch) b.done();
          } catch (e) {
            // Unordered: what failed is named by position, and the rest went in.
            const errors = (e as { writeErrors?: unknown }).writeErrors;
            const failed = new Map<number, unknown>();
            for (const w of (Array.isArray(errors) ? errors : errors ? [errors] : []) as { index: number; err?: unknown; errmsg?: string; code?: number }[]) failed.set(w.index, Object.assign(new Error(w.errmsg ?? "insert failed"), { code: w.code }));
            batch.forEach((b, i) => b.done(batch.length === 1 ? e : failed.size ? failed.get(i) : e));
          } finally {
            queue.inFlight--;
            pump();
          }
        })();
      }
    };
    pump();
    return sent;
  }

  /** One attempt at a write transaction. `optimistic`: go on without a session for as long as that stays correct (see Live). */
  async function attempt<T>(fn: (tx: DbTx) => Promise<T>, optimistic: boolean): Promise<T> {
    const live = liveOf();
    live.optimistic = optimistic;
    let session: ClientSession | undefined;
    live.open = async () => {
      if (live.session) return;
      // Writes are snapshot isolation (MongoDB has no serializable): a write conflict is a TransientTransactionError the executor retries.
      session = client.startSession();
      session.startTransaction({ readConcern: { level: "snapshot" } });
      live.session = session;
      for (const h of live.held.splice(0)) if (h.kind === "insert") await database.collection<any>(h.table).insertOne(h.doc, { session });
    };
    const scoped = scopedTx(txOf(live));
    try {
      let value: T;
      try {
        value = await fn(scoped);
      } catch (e) {
        // The function may have caught the error and gone on, or let it out: either way it is run again.
        if (live.tripped || e instanceof NeedsTransaction) throw new NeedsTransaction();
        throw e;
      }
      await live.tail; // operations the function didn't wait for
      if (live.tripped) throw new NeedsTransaction();
      if (!live.session && live.held.length === 1) {
        const h = live.held[0]!;
        if (h.kind === "insert") await batched(h.table, h.doc);
        else if (h.kind === "replace") {
          const r = await database.collection<any>(h.table).updateOne({ _id: h.id, doc: h.old }, { $set: { doc: h.doc, ...h.search } });
          if (!r.matchedCount) throw conflict();
        } else if (!(await database.collection<any>(h.table).deleteOne({ _id: h.id, doc: h.old })).deletedCount) throw conflict();
      } else {
        if (live.held.length) await live.open!();
        await session?.commitTransaction();
      }
      return value;
    } catch (e) {
      await session?.abortTransaction().catch(() => {});
      throw e;
    } finally {
      scoped.end();
      await session?.endSession();
    }
  }

  // Most mutations that read a document by id and write it fit the single-document way; those that don't (a second document, a query) find
  // out after one read, so when most don't, they start in a transaction.
  let optimisticMiss = 0;
  let optimisticProbe = 0;
  const tryOptimistic = () => optimisticMiss < 0.5 || ++optimisticProbe % 32 === 0;
  async function writeTransaction<T>(fn: (tx: DbTx) => Promise<T>, opts?: TransactionOptions): Promise<T> {
    if (!opts?.rerunnable || !tryOptimistic()) return attempt(fn, false);
    try {
      const value = await attempt(fn, true);
      optimisticMiss *= 0.97;
      return value;
    } catch (e) {
      if (!(e instanceof NeedsTransaction)) throw e;
      optimisticMiss = optimisticMiss * 0.97 + 0.03;
      return attempt(fn, false);
    }
  }

  let closed = false;
  const db: Db = {
    dialect: mongoDialect,
    ...txOf(liveOf()),
    async transaction(mode, fn, opts) {
      await connected;
      if (mode === "read" && opts?.rerunnable && tryWithoutTransaction()) {
        const done = await readWithoutTransaction(fn);
        missRate = missRate * 0.97 + (done ? 0 : 0.03);
        if (done) return done.value;
      }
      if (mode === "write") return writeTransaction(fn, opts);
      const session = client.startSession();
      try {
        session.startTransaction({ readConcern: { level: "snapshot" } });
        const scoped = scopedTx(txOf(liveOf(session)));
        try {
          const value = await fn(scoped);
          await session.commitTransaction();
          return value;
        } catch (e) {
          await session.abortTransaction().catch(() => {});
          throw e;
        } finally {
          scoped.end();
        }
      } finally {
        await session.endSession();
      }
    },
    async migrate(tables) {
      await connected;
      const have = new Set((await database.listCollections({}, { nameOnly: true }).toArray()).map((c) => c.name));
      for (const t of tables) {
        if (!have.has(t.name)) await database.createCollection(t.name).catch((e) => { if (e?.codeName !== "NamespaceExists") throw e; });
        const col = database.collection<any>(t.name);
        searchIndexes.set(t.name, Object.keys(t.searchIndexes ?? {}).map(searchField));
        const wanted = new Map<string, { key: Record<string, 1>; search?: { index: string; field: string } }>();
        for (const [index, fields] of [["by_creation_time", [] as readonly string[]] as const, ...Object.entries(t.indexes)])
          wanted.set(hashName(t.name, index, fields.join(",")), { key: { ...Object.fromEntries(fields.map((f) => [`doc.${f}`, 1 as const])), _creationTime: 1, _id: 1 } });
        for (const [index, c] of Object.entries(t.searchIndexes ?? {})) wanted.set(hashName(t.name, "search", index, c.searchField, "occurrences"), { key: { [searchField(index)]: 1 }, search: { index, field: c.searchField } });
        const existing = new Set<string>();
        if (have.has(t.name)) for (const i of await col.listIndexes().toArray()) if (i.name?.startsWith(PREFIX)) existing.add(i.name);
        // Servers starting together run this at once: an index another one dropped or built first is fine.
        for (const name of existing) if (!wanted.has(name)) await col.dropIndex(name).catch((e) => { if (e?.code !== 27) throw e; });
        for (const [name, w] of wanted) {
          if (existing.has(name)) continue;
          await col.createIndex(w.key, { name });
          if (w.search) {
            // A search index that is new covers documents already there: their words are worked out now.
            const { index, field } = w.search;
            const ops: AnyBulkWriteOperation[] = [];
            for await (const d of col.find({}, { projection: { [`doc.${field}`]: 1 } })) {
              const text = d.doc?.[field];
              ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: { [searchField(index)]: typeof text === "string" ? searchWords(text) : [] } } } });
              if (ops.length >= 1000) await col.bulkWrite(ops.splice(0));
            }
            if (ops.length) await col.bulkWrite(ops);
          }
        }
      }
    },
    async migrateSystem() {
      await connected;
      for (const [name, t] of Object.entries(SYSTEM_TABLES)) {
        await database.createCollection(name).catch((e) => {
          if (e?.codeName !== "NamespaceExists") throw e;
        });
        const col = database.collection<any>(name);
        for (const fields of t.indexes ?? []) await col.createIndex(Object.fromEntries(fields.map((f) => [f, 1])), { name: `afx_${name}_${fields.join("_")}` });
        for (const field of t.unique ?? []) await col.createIndex({ [field]: 1 }, { unique: true, name: `afx_${name}_${field}_unique` });
      }
    },
    async close() {
      if (closed) return;
      closed = true;
      await connected.catch(() => {});
      await client.close();
    },
  };
  (db as Db & { indexNames?: (table: string) => Promise<string[]> }).indexNames = async (table) => (await database.collection(table).listIndexes().toArray()).map((i) => i.name as string);
  // For tests and benchmarks that use a database of their own and want it gone.
  (db as Db & { drop?: () => Promise<void> }).drop = async () => {
    if (closed) return;
    await connected;
    await database.dropDatabase();
  };
  return db;
}

export type { MongoFilter };
