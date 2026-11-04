// MongoDB. A collection per table, a document per row: `{ _id, _creationTime, doc: { …the fields }, _s_<index>: [terms] }`. `doc` is nested, as the
// SQL adapters keep it in a column, so an index on `doc.listId` is the index on `json_extract(doc, '$.listId')`, with `_creationTime` and `_id` after
// the fields so a range, an order and a keyset page are served by one index. There is no SQL: DocStore builds filters and sorts (see MongoOps) where it
// builds statements for the others. Transactions need a replica set (a single node is one: `--replSet rs0` and `rs.initiate()`).
import { MongoClient, type AnyBulkWriteOperation, type ClientSession, type Document } from "mongodb";
import { pointReads } from "./coalesce";
import { hashName, PREFIX } from "./migrate";
import { escapeRegex, searchField, searchWords } from "./mongodb-search";
import { runSql, SYSTEM_TABLES } from "./mongodb-sql";
import { scopedTx, type Db, type DbTx, type Dialect, type MongoFilter, type MongoOps, type NumberStats, type Row } from "./types";

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
   * MongoDB runs one operation at a time in a transaction and refuses a second that overlaps it. Functions do overlap them (a Promise.all of
   * gets is ordinary), so a transaction's operations are queued here, in the order they were asked for.
   */
  const serial = (session: ClientSession | undefined, before?: () => void) => {
    let queue: Promise<unknown> = Promise.resolve();
    return <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      (...a: A): Promise<R> => {
        before?.();
        if (!session) return f(...a);
        const run = queue.then(() => f(...a));
        queue = run.catch(() => {});
        return run;
      };
  };

  /** The operations of one transaction (its session), or, without a session, of a read made outside one. */
  const opsOf = (session: ClientSession | undefined, guard: ReturnType<typeof serial>): MongoOps => {
    const col = (table: string) => database.collection<any>(table);
    const s = session ? { session } : {};
    return {
      find: guard(async (table, q) => {
        const keys = Object.keys(q.filter);
        if (!session && q.limit === 1 && !q.sort && !q.skip && keys.length === 1 && keys[0] === "_id" && typeof q.filter._id === "string") {
          const row = await point(table, q.filter._id);
          return row ? [row] : [];
        }
        return (await col(table).find(q.filter, { ...s, ...hide(table), sort: q.sort as never, limit: q.limit, skip: q.skip, allowDiskUse: true }).toArray()) as Row[];
      }),
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
        await col(table).insertMany(docs as Document[], { ...s, ordered: true });
      }),
      replace: guard(async (table, docs) => {
        await col(table).bulkWrite(
          docs.map((d) => ({ updateOne: { filter: { _id: d._id }, update: { $set: { doc: d.doc, ...d.search } } } })),
          { ...s, ordered: true },
        );
      }),
      delete: guard(async (table, id) => {
        await col(table).deleteOne({ _id: id } as Document, s);
      }),
      clear: guard(async (table) => {
        await col(table).deleteMany({}, s);
      }),
    };
  };

  // The engine's own tables are written as SQL; mongodb-sql.ts runs those statements (in the transaction, so a scheduled job commits with the
  // mutation that scheduled it).
  const txOf = (session: ClientSession | undefined, before?: () => void): DbTx => {
    const guard = serial(session, before);
    const sql = guard((text: string, params?: unknown[]) => runSql({ database, session }, text, params));
    return {
      query: sql as DbTx["query"],
      execute: async (text, params) => void (await sql(text, params)),
      mongo: opsOf(session, guard),
    };
  };

  // A read of one operation needs no transaction (a transaction is 2.3 ms against 0.45 for a find through the driver): it starts without one, and
  // if it makes a second operation it is thrown away and run again inside a snapshot transaction. See the same in postgres.ts.
  let missRate = 0;
  let probe = 0;
  const tryWithoutTransaction = () => missRate < 0.5 || ++probe % 64 === 0;
  async function readWithoutTransaction<T>(fn: (tx: DbTx) => Promise<T>): Promise<{ value: T } | undefined> {
    let operations = 0;
    let tripped = false;
    const scoped = scopedTx(
      txOf(undefined, () => {
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

  let closed = false;
  const db: Db = {
    dialect: mongoDialect,
    ...txOf(undefined),
    async transaction(mode, fn, opts) {
      await connected;
      if (mode === "read" && opts?.rerunnable && tryWithoutTransaction()) {
        const done = await readWithoutTransaction(fn);
        missRate = missRate * 0.97 + (done ? 0 : 0.03);
        if (done) return done.value;
      }
      const session = client.startSession();
      try {
        // Writes are snapshot isolation (MongoDB has no serializable): a write conflict is a TransientTransactionError the executor retries.
        session.startTransaction({ readConcern: { level: "snapshot" }, ...(mode === "write" && { writeConcern: { w: "majority" } }) });
        const scoped = scopedTx(txOf(session));
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
