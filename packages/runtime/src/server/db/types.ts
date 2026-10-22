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
}

export interface TableSpec {
  name: string;
  indexes: Record<string, readonly string[]>;
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
