export type Row = Record<string, any>;

export interface DbTx {
  /** `?` placeholders in both dialects; adapters rewrite them as needed. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
  /** On MongoDB, which has no SQL: what DocStore does with documents, as operations. The SQL adapters leave it out. */
  mongo?: MongoOps;
}

/** A MongoDB filter, as the driver takes it. */
export type MongoFilter = Record<string, unknown>;

/** A document as MongoDB keeps it: `doc` holds the fields, and each search index adds an array of the words of its field. */
export interface MongoDoc {
  _id: string;
  _creationTime: number;
  doc: Record<string, unknown>;
  [searchField: string]: unknown;
}

/** What DocStore asks of MongoDB. Rows come back as `{ _id, _creationTime, doc }`, as the SQL adapters return them. */
export interface MongoOps {
  find(table: string, q: { filter: MongoFilter; sort?: Record<string, 1 | -1>; limit?: number; skip?: number }): Promise<Row[]>;
  /**
   * Documents whose `field` (the words of a search index, one entry for each occurrence) has every one of `terms`, the last as a prefix, and that
   * match `filter`; best match first (BM25 on the words, the average length taken over the matches), then oldest.
   */
  search(table: string, q: { field: string; terms: string[]; filter: MongoFilter; limit: number }): Promise<Row[]>;
  count(table: string, filter: MongoFilter): Promise<number>;
  stats(table: string, filter: MongoFilter, field: string): Promise<NumberStats | undefined>;
  /** At most `take` children of each parent, in `sort` order, in one aggregation; rows come back parent by parent. */
  childrenOf(table: string, field: string, parents: string[], sort: Record<string, 1 | -1>, take: number): Promise<Row[]>;
  /** How many children each parent has (parents with none are missing). */
  countChildren(table: string, field: string, parents: string[]): Promise<Map<string, number>>;
  insert(table: string, docs: MongoDoc[]): Promise<void>;
  /** Replaces `doc` (and the search words) of existing documents; `_creationTime` stays. */
  replace(table: string, docs: { _id: string; doc: Record<string, unknown>; search?: Record<string, string[]> }[]): Promise<void>;
  delete(table: string, id: string): Promise<void>;
  clear(table: string): Promise<void>;
}

/** Dialect-specific SQL fragments, so callers keep their own SQL portable. */
export interface Dialect {
  name: "sqlite" | "postgres" | "mongodb";
  realType: string;
  jsonType: string;
  /** Placeholder for a JSON document parameter (the value passed is a JSON string). */
  jsonParam: string;
  /** Expression reading a top-level document field, also used in index definitions. */
  field(name: string): string;
  /** A document field that starts with `prefix` (a string), for where()'s prefix(). */
  startsWith(name: string, prefix: string): { sql: string; params: unknown[] };
  /** `field = ?` with the value encoded for that comparison; undefined matches a missing field. */
  fieldEquals(name: string, value: unknown): { sql: string; params: unknown[] };
  listIndexesSql: string;
  /** Placeholder for a value compared with `field()`, and how to encode that value. */
  valueParam: string;
  encode(value: unknown): unknown;
  /**
   * Inserts many documents in one statement whose text doesn't change with their number (so the server prepares it once), when the database
   * has a cheaper way than a long list of `?`. `json` is each document's JSON text. Absent: DocStore writes a multi-row VALUES.
   */
  bulkInsert?(table: string, rows: { id: string; time: number; json: string }[]): { sql: string; params: unknown[] };
  /** Replaces the document of many rows (each id once) in one statement, where that beats a statement per row. Absent: one UPDATE each. */
  bulkUpdate?(table: string, rows: { id: string; json: string }[]): { sql: string; params: unknown[] };
  /**
   * Rows (`_id`, `_creationTime`, `doc`) of the children of several parents, at most `take` of each in the order `orderBy` says, in one
   * statement, for a database where a statement per parent costs a round trip. Absent: DocStore runs one statement per parent.
   */
  childrenOf?(table: string, field: string, parents: string[], orderBy: string, take: number): { sql: string; params: unknown[] };
  /** Rows `{ k, n }`: how many children each parent has, `k` being its position in `parents`. Absent: DocStore unions one subselect per parent. */
  countChildren?(table: string, field: string, parents: string[]): { sql: string; params: unknown[] };
  /**
   * What `sum`, `avg`, `min` and `max` of a number field need to know about the documents in a range, worked out by the database. `where` is a
   * WHERE clause or empty. `run` runs a statement. Undefined when this database can't tell (DocStore then reads the documents).
   */
  numberStats?(run: (sql: string, params: unknown[]) => Promise<Row[]>, table: string, field: string, where: string, params: unknown[]): Promise<NumberStats | undefined>;
  /** The statements indexing many new documents at once (they have no earlier entry to remove), where one write each is slow. Absent: `searchWrite` for each. */
  searchInsertMany?(table: string, index: string, rows: { id: string; text: string }[]): { sql: string; params: unknown[] }[];
  /** Statements keeping a search index in sync when a document is written; `text` undefined removes it. */
  searchWrite(table: string, index: string, id: string, text: string | undefined): { sql: string; params: unknown[] }[];
  /** Matching ids by relevance; `terms` are lowercase words, the last matched as a prefix. */
  searchSql(table: string, index: string, field: string, terms: string[], filters: { sql: string; params: unknown[] }[], limit: number): {
    sql: string;
    params: unknown[];
  };
}

export interface TableSpec {
  name: string;
  indexes: Record<string, readonly string[]>;
  searchIndexes?: Record<string, { searchField: string; filterFields: readonly string[] }>;
}

/**
 * Counts and extremes of a number field over a range of documents. `bad` counts values that aren't numbers (a string, a boolean, an
 * array: the pass over the documents throws on those), `nonint` the numbers that aren't integers, and `sum` is only meaningful when
 * every number is an integer.
 */
export interface NumberStats {
  rows: number;
  n: number;
  nonint: number;
  bad: number;
  sum: number;
  min: number | null;
  max: number | null;
}

export interface TransactionOptions {
  /**
   * The function may be run more than once: it is deterministic and does nothing outside the database (a query is). A read may then start
   * without a transaction and be run again inside one if it needs a snapshot; MongoDB does the same for a write that fits one document (see
   * mongodb.ts). The default is exactly one run.
   */
  rerunnable?: boolean;
}

export interface Db extends DbTx {
  readonly dialect: Dialect;
  /** Read transactions see one consistent snapshot; write transactions are serializable and may be retried. */
  transaction<T>(mode: "read" | "write", fn: (tx: DbTx) => Promise<T>, options?: TransactionOptions): Promise<T>;
  /** Creates document tables and syncs their indexes. Documents are JSON, so fields need no migration. */
  migrate(tables: TableSpec[]): Promise<void>;
  /** Creates the engine's own tables where `system.ts` has no SQL for them (MongoDB: collections and their indexes). */
  migrateSystem?(): Promise<void>;
  close(): Promise<void>;
}

export function isRetryableConflict(e: unknown): boolean {
  const err = e as { errno?: unknown; code?: unknown; errorLabels?: unknown };
  if (["40001", "40P01"].includes(String(err?.errno)) || ["40001", "40P01"].includes(String(err?.code))) return true;
  // MongoDB: a write conflict between transactions (112) or anything the server labels as safe to run again.
  return err?.code === 112 || (Array.isArray(err?.errorLabels) && err.errorLabels.includes("TransientTransactionError"));
}

/** A transaction handle that refuses calls after its transaction ends, e.g. from a handler still running after a timeout. */
export function scopedTx(tx: DbTx): DbTx & { end(): void } {
  let open = true;
  const check = () => {
    if (!open) throw new Error("Transaction already finished: the function kept using the database after it returned or timed out");
  };
  const mongo = tx.mongo && (Object.fromEntries(Object.entries(tx.mongo).map(([name, op]) => [name, (...args: unknown[]) => (check(), (op as (...a: unknown[]) => unknown)(...args))])) as unknown as MongoOps);
  return {
    query: (sql, params) => (check(), tx.query(sql, params)),
    execute: (sql, params) => (check(), tx.execute(sql, params)),
    ...(mongo && { mongo }),
    end: () => (open = false),
  };
}
