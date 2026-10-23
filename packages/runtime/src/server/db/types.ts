export type Row = Record<string, any>;

export interface DbTx {
  /** `?` placeholders in both dialects; adapters rewrite them as needed. */
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  execute(sql: string, params?: unknown[]): Promise<void>;
}

/** Dialect-specific SQL fragments, so callers keep their own SQL portable. */
export interface Dialect {
  name: "sqlite" | "postgres";
  realType: string;
  jsonType: string;
  /** Placeholder for a JSON document parameter (the value passed is a JSON string). */
  jsonParam: string;
  /** Expression reading a top-level document field, also used in index definitions. */
  field(name: string): string;
  /** `field = ?` with the value encoded for that comparison; undefined matches a missing field. */
  fieldEquals(name: string, value: unknown): { sql: string; params: unknown[] };
  listIndexesSql: string;
  /** Placeholder for a value compared with `field()`, and how to encode that value. */
  valueParam: string;
  encode(value: unknown): unknown;
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

export interface Db extends DbTx {
  readonly dialect: Dialect;
  /** Read transactions see one consistent snapshot; write transactions are serializable and may be retried. */
  transaction<T>(mode: "read" | "write", fn: (tx: DbTx) => Promise<T>): Promise<T>;
  /** Creates document tables and syncs their indexes. Documents are JSON, so fields need no migration. */
  migrate(tables: TableSpec[]): Promise<void>;
  close(): Promise<void>;
}

export function isRetryableConflict(e: unknown): boolean {
  const err = e as { errno?: unknown; code?: unknown };
  return ["40001", "40P01"].includes(String(err?.errno)) || ["40001", "40P01"].includes(String(err?.code));
}

/** A transaction handle that refuses calls after its transaction ends, e.g. from a handler still running after a timeout. */
export function scopedTx(tx: DbTx): DbTx & { end(): void } {
  let open = true;
  const check = () => {
    if (!open) throw new Error("Transaction already finished: the function kept using the database after it returned or timed out");
  };
  return {
    query: (sql, params) => (check(), tx.query(sql, params)),
    execute: (sql, params) => (check(), tx.execute(sql, params)),
    end: () => (open = false),
  };
}
