// The native document database (packages/db): where it is, what it offers, and the handle a transaction carries. The engine owns the connections, the tables and
// indexes, the documents, the queries, the reactivity topics and the cache of reads (see packages/db/crates/napi/src/engine.rs); JavaScript keeps the schema's
// validators, the functions and the runtime, and sends the engine validated documents and descriptions of queries.
import { existsSync } from "node:fs";
import { SnapshotMoved } from "../read-cache";
import { ValidationError } from "../../values";

/** One parameter of a statement: what the engine binds (booleans are 1 and 0). */
export type Param = string | number | boolean | null;

export interface NativeEngine {
  migrate(spec: string): void;
  /** A read transaction on a reader; -1 when every reader is in use. */
  beginRead(cached: boolean): number;
  /** The state of one function's writes inside the writer's transaction. */
  beginWrite(): number;
  writerSql(sql: string): void;
  writerInTransaction(): boolean;
  /** Ends a transaction; what it read and wrote as one string: the reads and the writes apart by \u0001, their topics apart by \u0000 (empty when neither). */
  endTx(tx: number, ok: boolean): string;
  all(tx: number, sql: string, params: Param[]): string;
  run(tx: number, sql: string, params: Param[]): number;
  select(tx: number, table: string, sql: string, params: Param[], topics: string): string;
  get(tx: number, id: string): string | null;
  getMany(tx: number, ids: string[]): string;
  query(tx: number, table: string, desc: string): string;
  queryFull(tx: number, table: string, desc: string): string;
  join(tx: number, table: string, docs: string, rules: string): string;
  paginate(tx: number, table: string, desc: string, numItems: number, cursor: string | undefined, extra: number, withTotal: boolean): string;
  aggregate(tx: number, table: string, desc: string, kind: string, field: string): string;
  search(tx: number, spec: string): string;
  count(tx: number, table: string, desc: string): number;
  planSql(desc: string): string;
  /** `docs` are the JSON text of the user's values; `trusted` when JavaScript has validated them. */
  insert(tx: number, table: string, docs: string[], maxBytes: number, trusted: boolean): string[];
  /** `insert` of one document: its id. */
  insertOne(tx: number, table: string, doc: string, maxBytes: number, trusted: boolean): string;
  /** Changes a document in one call: validated, written, indexed. False when it is stored as it is already. */
  change(tx: number, id: string, value: string, patch: boolean, maxBytes: number, trusted: boolean): boolean;
  /** The stored fields of a document as JSON text, from the database, or null. */
  getRaw(tx: number, id: string): string | null;
  /** `old` is the text `getRaw` gave, if the caller has it. */
  replace(tx: number, id: string, json: string, old?: string): boolean;
  delete(tx: number, id: string): void;
  noteWritten(tx: number, table: string, doc: string, before?: string): void;
  setCache(on: boolean): void;
  clearCache(): void;
  /** How many reads the cache answered and how many reached the database (JSON: { hits, misses }). */
  cacheStats(): string;
  paused(): boolean;
  close(): void;
}

export interface NativeDb {
  Engine: new (path: string, options: string) => NativeEngine;
}

let loaded: NativeDb | null | undefined;

/**
 * The native database layer, or null where it is missing (not Linux, not built, not shipped). It is a workspace package that is not published, so it sits next to
 * this one in a checkout and in the engine image, which builds the library; the published runtime has none and keeps bun:sqlite. The path is built at run
 * time so the runtime's own build does not look for it.
 */
export function nativeDb(): NativeDb | null {
  if (loaded !== undefined) return loaded;
  loaded = null;
  if (process.platform !== "linux") return loaded;
  const file = new URL("../../../../db/native/archlast_db.node", import.meta.url).pathname;
  if (!existsSync(file)) return loaded;
  try {
    loaded = require(file) as NativeDb;
  } catch {
    loaded = null;
  }
  return loaded;
}

/** The engine could not vouch for a write (a rule it does not check, or a value that fails one): the schema in JavaScript decides, and words the error. */
export class NeedsJs extends Error {}

/** An error from the engine, as the errors JavaScript code tells apart: its second character says which (V a ValidationError, S a read that must start over, X a write for JavaScript to check). */
export function translate(e: unknown): unknown {
  const m = (e as Error)?.message;
  if (typeof m === "string" && m.charCodeAt(0) === 1) return m[1] === "S" ? new SnapshotMoved() : m[1] === "X" ? new NeedsJs() : new ValidationError(m.slice(2));
  return e;
}

/** Runs an engine call and gives its errors their JavaScript types. */
export function call<T>(f: () => T): T {
  try {
    return f();
  } catch (e) {
    throw translate(e);
  }
}

/** What a transaction read and wrote, from the engine's one string (see `NativeEngine.endTx`). */
function topicsOf(s: string): { reads: string[]; writes: string[] } {
  if (!s) return { reads: [], writes: [] };
  const i = s.indexOf("\u0001");
  const part = (t: string) => (t ? t.split("\u0000") : []);
  return i < 0 ? { reads: part(s), writes: [] } : { reads: part(s.slice(0, i)), writes: part(s.slice(i + 1)) };
}

/**
 * A transaction as the engine knows it. The engine's side is made when it is first needed, so a transaction that only runs raw statements (the engine's own
 * tables) costs nothing more; `end` ends it once, and what it read and wrote is kept for whoever asks afterwards.
 */
export class NativeHandle {
  private tx = -1;
  private done?: { reads: string[]; writes: string[] };
  private revoked = false;
  private listeners: ((r: { reads: string[]; writes: string[] }) => void)[] = [];
  constructor(
    readonly engine: NativeEngine,
    readonly kind: "read" | "write",
    private readonly cached: boolean,
    /** Read transactions are made by the pool (it hands out the engine's reader and waits when there is none). */
    id?: number,
  ) {
    if (id !== undefined) this.tx = id;
  }
  /** The engine's number for this transaction. */
  get id(): number {
    if (this.done || this.revoked) throw new Error("Transaction already finished: the function kept using the database after it returned or timed out");
    if (this.tx < 0) this.tx = this.kind === "write" ? this.engine.beginWrite() : this.engine.beginRead(this.cached);
    return this.tx;
  }
  get ended() {
    return this.done !== undefined;
  }
  /** The function that was given the transaction is over: it may not use it any more (the engine's number may be someone else's by now). */
  revoke() {
    this.revoked = true;
  }
  /** Asks to be told what the transaction read and wrote when it ends (the DocStore adds them to its sets). */
  onEnd(listener: (r: { reads: string[]; writes: string[] }) => void) {
    if (this.done) listener(this.done);
    else this.listeners.push(listener);
  }
  /**
   * Ends the transaction: a reader's snapshot is committed and the reader freed; a writer's tables are settled in the cache, which is done after the commit (or the
   * rollback), so the database layer ends a write only then. What it read and wrote goes to whoever asked, once.
   */
  end(ok: boolean): { reads: string[]; writes: string[] } {
    if (this.done) return this.done;
    const r = this.tx < 0 ? { reads: [], writes: [] } : topicsOf(this.engine.endTx(this.tx, ok));
    this.done = r;
    for (const l of this.listeners.splice(0)) l(r);
    return r;
  }
}
