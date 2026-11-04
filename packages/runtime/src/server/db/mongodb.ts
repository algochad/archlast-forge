// MongoDB. A collection per table, a document per row: `{ _id, _creationTime, doc: { …the fields }, _s_<index>: [terms] }`. `doc` is nested, as the
// SQL adapters keep it in a column, so an index on `doc.listId` is the index on `json_extract(doc, '$.listId')`, with `_creationTime` and `_id` after
// the fields so a range, an order and a keyset page are served by one index. There is no SQL: DocStore builds filters and sorts (see MongoOps) where it
// builds statements for the others. Transactions need a replica set (a single node is one: `--replSet rs0` and `rs.initiate()`).
import { MongoClient, type AnyBulkWriteOperation, type ClientSession, type Document } from "mongodb";
import { pointReads } from "./coalesce";
import { hashName, PREFIX } from "./migrate";
import { searchField, searchWords } from "./mongodb-search";
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
  const connected = client.connect();
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

  /** The operations of one transaction (its session), or, without a session, of a read made outside one. */
  const opsOf = (session: ClientSession | undefined, before?: () => void): MongoOps => {
    const col = (table: string) => database.collection<any>(table);
    const s = session ? { session } : {};
    // MongoDB runs one operation at a time in a transaction and refuses a second that overlaps it. Functions do overlap them (a Promise.all of
    // gets is ordinary), so a transaction's operations are queued here, in the order they were asked for.
    let queue: Promise<unknown> = Promise.resolve();
    const guard =
      <A extends unknown[], R>(f: (...a: A) => Promise<R>) =>
      (...a: A): Promise<R> => {
        before?.();
        if (!session) return f(...a);
        const run = queue.then(() => f(...a));
        queue = run.catch(() => {});
        return run;
      };
    return {
      find: guard(async (table, q) => {
        const keys = Object.keys(q.filter);
        if (!session && q.limit === 1 && !q.sort && !q.skip && keys.length === 1 && keys[0] === "_id" && typeof q.filter._id === "string") {
          const row = await point(table, q.filter._id);
          return row ? [row] : [];
        }
        return (await col(table).find(q.filter, { ...s, ...hide(table), sort: q.sort as never, limit: q.limit, skip: q.skip, allowDiskUse: true }).toArray()) as Row[];
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

  const txOf = (session: ClientSession | undefined, before?: () => void): DbTx => ({
    query: async () => {
      throw new Error("MongoDB has no SQL: the engine's SQL tables are not stored in it yet");
    },
    execute: async () => {
      throw new Error("MongoDB has no SQL: the engine's SQL tables are not stored in it yet");
    },
    mongo: opsOf(session, before),
  });

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
        for (const [index, c] of Object.entries(t.searchIndexes ?? {})) wanted.set(hashName(t.name, "search", index, c.searchField), { key: { [searchField(index)]: 1 }, search: { index, field: c.searchField } });
        const existing = new Set<string>();
        if (have.has(t.name)) for (const i of await col.listIndexes().toArray()) if (i.name?.startsWith(PREFIX)) existing.add(i.name);
        for (const name of existing) if (!wanted.has(name)) await col.dropIndex(name);
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
