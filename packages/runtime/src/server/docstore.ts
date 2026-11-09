import { referenceOf } from "../relations";
import type { Row } from "./db/types";
import { SnapshotMoved, type ReadCache } from "./read-cache";
import { tableOf, validateFields, ValidationError, type Validator } from "../values";
import type { DbTx, Dialect, MongoFilter, MongoOps } from "./db/types";
import { ftsTable } from "./db/migrate";
import { call, type NativeHandle, type Param } from "./db/native";
import { activeCall, nativeOp } from "./telemetry/context";
import { escapeRegex, searchField as mongoSearchField, searchWords } from "./db/mongodb-search";

export type TablesSpec = Record<
  string,
  {
    fields: Record<string, Validator>;
    indexes: Record<string, readonly string[]>;
    searchIndexes?: Record<string, { searchField: string; filterFields: readonly string[] }>;
    strict: boolean;
  }
>;

export type Doc = Record<string, any> & { _id: string; _creationTime: number };

/**
 * Related documents to add to each result. A string names a field holding an id (or an array of ids) and gives the document(s) it points at.
 * An object finds the documents of another table that point back, through an index that starts with that reference.
 */
export type IncludeRule = string | { table: string; index: string; take?: number; order?: "asc" | "desc"; include?: IncludeSpec; count?: boolean };
export type IncludeSpec = Record<string, IncludeRule>;

/** Reactivity topics: `todos`, `todos:by_list:["lists:…"]`, `todos:by_id:["todos:…"]`. */
export const topic = (table: string, index: string, values: unknown[]) => `${table}:${index}:${JSON.stringify(values)}`;
/** Published once when a restore has rewritten the tables: every server drops its query cache and re-runs its subscriptions. */
export const RESET_TOPIC = "_forge:reset";

const SELECT = `SELECT "_id", "_creationTime", "doc" FROM`;
const MAX_PAGE = 8192;
const MAX_SEARCH = 1024;
/** Documents fetched per round trip when a filter has to look through a range, and the most one query will look through. */
const SCAN_BATCH = 256;
/** A batch of a filter's scan: a database a round trip away takes more at a time (a scan of 2,000 documents was 8 round trips). */
const scanBatchOf = (dialect: Dialect) => (dialect.name === "sqlite" ? SCAN_BATCH : SCAN_BATCH * 4);
export const MAX_SCAN = 100_000;
/** Ids per `IN (…)` and parents per `OR` chain, to keep statements a sane size. */
const IN_CHUNK = 500;
const OR_CHUNK = 100;

type Bound = { op: ">" | ">=" | "<" | "<="; value: unknown };
/** A where() predicate, compiled: SQL with `?` placeholders and their values. Only the builder makes these (the brand), so no SQL text comes from elsewhere. */
export const PREDICATE = Symbol("predicate");
export type Predicate = { [PREDICATE]: true; sql: string; params: unknown[]; mongo: MongoFilter; ast: unknown };
/** JavaScript's `undefined`, which JSON cannot carry, in a description of a query for the native engine. */
export const UNDEF = { $undefined: true };
export const orUndef = (v: unknown) => (v === undefined ? UNDEF : v);
/** Parameters as the native engine takes them: `undefined` is null. */
const nativeParams = (params: unknown[]) => params.map((p) => (p === undefined ? null : p)) as Param[];
/** Where MongoDB keeps a field: `_id` and `_creationTime` beside `doc`, the document's own fields inside it. */
const mpath = (f: string) => (f === "_id" || f === "_creationTime" ? f : `doc.${f}`);
/**
 * An equality in a MongoDB filter. The value is wrapped in `$eq`: bare, an object such as `{ "$ne": null }` (from a pagination cursor, or
 * arguments typed `v.any()`) would be an operator. `$eq` matches what the bare value does, null (also a missing field) and arrays included.
 */
const meq = (value: unknown) => (value === undefined || value === null ? null : { $eq: value });
/** A filter nothing matches. */
const NOTHING: MongoFilter = { _id: { $in: [] } };
export const isPredicate = (p: unknown): p is Predicate => typeof p === "object" && p !== null && PREDICATE in p;
/** Field names go into SQL text (a JSON path), so only plain identifiers are accepted. */
export const IDENT = /^[A-Za-z_][A-Za-z0-9_]{0,99}$/;
/** SQL statements already explained in this process, so a query that scans is reported once, not on every run. */
const explained = new Set<string>();
/** Whether two field values are the same as far as the stored document is concerned (arrays and objects compare by their JSON). */
const sameValue = (a: unknown, b: unknown) => Object.is(a, b) || (typeof a === "object" && a !== null && JSON.stringify(a) === JSON.stringify(b));
/** Creation times strictly increase within a process, so documents inserted together keep their order. */
let lastCreation = 0;
const creationTime = () => (lastCreation = Math.max(performance.timeOrigin + performance.now(), lastCreation + 0.001));
type BatchMode = "all" | "partial";
const batchMode = (name: string, opts: unknown): BatchMode => {
  const mode = (opts as { mode?: unknown } | undefined)?.mode ?? "all";
  if (mode !== "all" && mode !== "partial") throw new ValidationError(`${name}() mode must be "all" or "partial", got ${JSON.stringify(mode)}`);
  return mode;
};
type Step = { filter: (doc: Doc) => boolean } | { include: IncludeSpec };

const encodeCursor = (values: unknown[]) => Buffer.from(JSON.stringify(values)).toString("base64url");
function decodeCursor(cursor: string, length: number): unknown[] {
  try {
    const values = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (Array.isArray(values) && values.length === length) return values;
  } catch {}
  throw new ValidationError("Invalid pagination cursor (was the query or index changed?)");
}

/** Search terms: lowercase words, at most 16. */
export const searchTerms = (text: string) => (text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).slice(0, 16);

export class DocStore {
  constructor(
    private tx: DbTx,
    private dialect: Dialect,
    protected tables: TablesSpec,
    /** Topics this transaction read. */
    readonly reads = new Set<string>(),
    /** Topics this transaction wrote; absent in read-only transactions. */
    readonly writes?: Set<string>,
    protected maxDocumentBytes = 1024 * 1024,
    private cache?: ReadCache,
    /** In dev: told when a where() or orderBy() query has no index to use (SQLite's query plan says it scans or sorts). */
    protected warn?: (message: string) => void,
  ) {
    this.stamp = cache?.now() ?? 0;
    this.mongo = tx.mongo;
    this.nat = tx.native;
    // What the engine tracked comes to the sets when the transaction ends (a read's, when the function returns; a write's, once it is committed).
    this.nat?.onEnd((r) => {
      for (const t of r.reads) this.reads.add(t);
      if (this.writes) for (const t of r.writes) this.writes.add(t);
    });
  }

  /** On the native engine, which answers this store's operations itself: this transaction, as the engine knows it. */
  protected readonly nat?: NativeHandle;

  /** One call to the native engine: a `db` span when the request is traced, and the engine's errors as JavaScript's own. */
  protected n<T>(op: string, table: string | undefined, f: () => T): T {
    if (!activeCall()?.trace) return call(f); // not a traced call (nearly all): no span, no closure
    return nativeOp("sqlite", op, table, () => call(f));
  }

  /** Whether the native engine runs this store's operations. */
  get native() {
    return this.nat !== undefined;
  }

  /** Set on MongoDB: documents are read and written as operations (db/types.ts MongoOps) where the others run SQL. */
  private readonly mongo?: MongoOps;

  /** This transaction's snapshot on the read cache's counter; whether it used cached rows or the database yet; whether it has written. */
  private stamp: number;
  private usedCache = false;
  private usedDb = false;
  private dirty = false;
  /** Tables this transaction marked pending in the read cache; the executor settles them once it commits or rolls back. */
  readonly writing = new Set<string>();

  /** A read of `table` that reads `topics`: from the read cache when it has the rows as of this transaction's snapshot, else from the database. */
  private async select(table: string, sql: string, params: unknown[], topics: string[]): Promise<Row[]> {
    if (this.nat) {
      const nat = this.nat;
      return JSON.parse(this.n("SELECT", table, () => nat.engine.select(nat.id, table, sql, nativeParams(params), JSON.stringify(topics))));
    }
    const key = sql + "\u0000" + JSON.stringify(params);
    const hit = this.peek(table, key);
    if (hit) return hit;
    this.toDb();
    const rows = await this.tx.query(sql, params);
    this.keep(table, key, rows, topics);
    return rows;
  }

  /** Cached rows for `key`, if the read cache has them as of this transaction's snapshot. */
  private peek(table: string, key: string): Row[] | undefined {
    if (!this.cache || this.dirty) return undefined;
    const hit = this.cache.get(key, table, this.stamp);
    if (hit) this.usedCache = true;
    return hit;
  }

  /** Before a statement goes to the database. */
  private toDb() {
    if (this.cache && !this.dirty && !this.usedDb && !this.writes) {
      // The database snapshot starts with this statement. Cached rows already used are the state as of `stamp`: if anything committed
      // since, the two would disagree, so start the read over. Otherwise the snapshot is now.
      if (this.usedCache && this.cache.now() !== this.stamp) throw new SnapshotMoved();
      this.stamp = this.cache.now();
    }
    this.usedDb = true;
  }

  /** Rows a read-only transaction read, kept under the topics they depend on. */
  private keep(table: string, key: string, rows: Row[], topics: string[]) {
    if (this.cache && !this.dirty && !this.writes) this.cache.set(key, table, rows, this.stamp, topics);
  }

  /** @internal the read side's operations, made once for this store (the ctx of a function takes it, and so may the next call). */
  makeReader() {
    return {
      get: this.get.bind(this),
      getJson: this.getJson.bind(this),
      getMany: this.getMany.bind(this),
      query: this.query.bind(this),
      include: async (table: string, docs: Doc | Doc[] | null, spec: IncludeSpec) => {
        if (docs == null) return null;
        if (Array.isArray(docs)) return this.join(table, docs, spec);
        return (await this.join(table, [docs], spec))[0];
      },
    };
  }

  private readerObject?: ReturnType<DocStore["makeReader"]>;
  reader() {
    return (this.readerObject ??= this.makeReader());
  }

  private writerObject?: ReturnType<DocStore["makeWriter"]>;
  /** @internal */
  makeWriter() {
    return {
      ...this.reader(),
      insert: this.insert.bind(this),
      insertMany: this.insertMany.bind(this),
      updateMany: this.updateMany.bind(this),
      patch: this.patch.bind(this),
      replace: this.replace.bind(this),
      delete: this.delete.bind(this),
    };
  }
  writer() {
    return (this.writerObject ??= this.makeWriter());
  }

  protected table(name: string) {
    const t = this.tables[name];
    if (!t) throw new ValidationError(`Unknown table "${name}"`);
    return t;
  }

  private toDoc(row: any): Doc {
    const fields = typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc;
    return { _id: row._id, _creationTime: row._creationTime, ...fields };
  }

  protected parseId(id: unknown) {
    if (typeof id !== "string" || !id.includes(":")) throw new ValidationError(`Invalid id ${JSON.stringify(id)}`);
    const table = tableOf(id);
    this.table(table);
    return table;
  }

  /** SQL expression and parameter placeholder for an order-key field. */
  private col(f: string) {
    return f === "_creationTime" || f === "_id"
      ? { expr: `"${f}"`, param: "?", encode: (x: unknown) => x }
      : { expr: this.dialect.field(f), param: this.dialect.valueParam, encode: this.dialect.encode };
  }

  /** A field where(), orderBy() or select() names: an identifier, and a field of the table when the table is validated. */
  protected fieldName(table: string, f: unknown, method: string): string {
    const t = this.table(table);
    if (typeof f !== "string" || !IDENT.test(f)) throw new ValidationError(`${method}(): ${JSON.stringify(f)} is not a field name`);
    if (t.strict && f !== "_id" && f !== "_creationTime" && !(f in t.fields)) throw new ValidationError(`${method}(): "${f}" is not a field of "${table}"`);
    return f;
  }

  /** The predicates where() builds: comparisons on the document's fields, compiled to SQL that an index on those fields can serve, and and/or/not. */
  protected predicates(table: string) {
    const pred = (sql: string, params: unknown[], mongo: MongoFilter = {}, ast: unknown = null): Predicate => ({ [PREDICATE]: true, sql, params, mongo, ast });
    const col = (f: unknown, method: string) => this.col(this.fieldName(table, f, method));
    const cmp = (op: string, mop: string, method: string) => (f: string, value: unknown) => {
      const c = col(f, method);
      return pred(`${c.expr} ${op} ${c.param}`, [c.encode(value)], { [mpath(f)]: { [mop]: value } }, { t: "cmp", op, f, v: orUndef(value) });
    };
    const all = (ps: unknown[], method: string) => {
      for (const p of ps) if (!isPredicate(p)) throw new ValidationError(`${method}() takes predicates from the where() builder`);
      return ps as Predicate[];
    };
    const join = (method: string, glue: "AND" | "OR", empty: string) => (...ps: unknown[]) => {
      const list = all(ps, method);
      const mongo: MongoFilter = list.length ? { [glue === "AND" ? "$and" : "$or"]: list.map((p) => p.mongo) } : glue === "AND" ? {} : NOTHING;
      const ast = { t: glue === "AND" ? "and" : "or", ps: list.map((p) => p.ast) };
      return list.length ? pred(`(${list.map((p) => p.sql).join(` ${glue} `)})`, list.flatMap((p) => p.params), mongo, ast) : pred(empty, [], mongo, ast);
    };
    return {
      eq: (f: string, value: unknown) => {
        const name = this.fieldName(table, f, "eq");
        const ast = { t: "eq", f: name, v: orUndef(value) };
        if (value === undefined || value === null) return pred(`${this.col(name).expr} IS NULL`, [], { [mpath(name)]: null }, ast);
        if (name === "_id" || name === "_creationTime") return pred(`"${name}" = ?`, [value], { [name]: meq(value) }, ast);
        const c = this.dialect.fieldEquals(name, value);
        return pred(c.sql, c.params, { [mpath(name)]: meq(value) }, ast);
      },
      /** Not equal, which a document without the field is. */
      neq: (f: string, value: unknown) => {
        const c = col(f, "neq");
        const ast = { t: "neq", f, v: orUndef(value) };
        if (value === undefined || value === null) return pred(`${c.expr} IS NOT NULL`, [], { [mpath(f)]: { $ne: null } }, ast);
        return pred(`(${c.expr} IS NULL OR ${c.expr} <> ${c.param})`, [c.encode(value)], { [mpath(f)]: { $ne: value } }, ast);
      },
      gt: cmp(">", "$gt", "gt"),
      gte: cmp(">=", "$gte", "gte"),
      lt: cmp("<", "$lt", "lt"),
      lte: cmp("<=", "$lte", "lte"),
      between: (f: string, low: unknown, high: unknown) => {
        const c = col(f, "between");
        return pred(`(${c.expr} >= ${c.param} AND ${c.expr} <= ${c.param})`, [c.encode(low), c.encode(high)], { [mpath(f)]: { $gte: low, $lte: high } }, { t: "between", f, lo: orUndef(low), hi: orUndef(high) });
      },
      in: (f: string, values: unknown) => {
        const c = col(f, "in");
        if (!Array.isArray(values)) throw new ValidationError("in() expects an array of values");
        if (!values.length) return pred("1 = 0", [], NOTHING, { t: "in", f, vs: [] });
        return pred(`${c.expr} IN (${values.map(() => c.param).join(", ")})`, values.map((v) => c.encode(v)), { [mpath(f)]: { $in: values } }, { t: "in", f, vs: values.map(orUndef) });
      },
      prefix: (f: string, prefix: unknown) => {
        const name = this.fieldName(table, f, "prefix");
        if (typeof prefix !== "string") throw new ValidationError("prefix() expects a string");
        if (name === "_creationTime") throw new ValidationError("prefix() is for string fields");
        const mongo = { [mpath(name)]: { $regex: "^" + escapeRegex(prefix) } };
        if (name === "_id") return pred(`("_id" >= ? AND "_id" < ?)`, [prefix, prefix + "\u{10FFFF}"], mongo, { t: "prefix", f: name, p: prefix });
        const s = this.dialect.startsWith(name, prefix);
        return pred(s.sql, s.params, mongo, { t: "prefix", f: name, p: prefix });
      },
      and: join("and", "AND", "1 = 1"),
      or: join("or", "OR", "1 = 0"),
      /** True where the predicate isn't, a missing field included (CASE rather than NOT, so a NULL comparison counts as false). */
      not: (p: unknown) => {
        const [inner] = all([p], "not");
        return pred(`(CASE WHEN ${inner!.sql} THEN 1 ELSE 0 END) = 0`, inner!.params, { $nor: [inner!.mongo] }, { t: "not", p: inner!.ast });
      },
    };
  }

  /** Rows after `after` in the order of `key`: one row-value comparison when every key goes the same way (an index serves it), else (a > ?) OR (a = ? AND b < ?) …. */
  private keyset(key: { expr: string; param: string; encode: (x: unknown) => unknown; desc: boolean; f: string }[], after: unknown[]) {
    // MongoDB has no row-value comparison: (a, b) > (x, y) is a > x, or a = x and b > y, which is also how mixed directions are written.
    const mongo: MongoFilter = { $or: key.map((k, i) => ({ ...Object.fromEntries(key.slice(0, i).map((p, j) => [mpath(p.f), meq(after[j])])), [mpath(k.f)]: { [k.desc ? "$lt" : "$gt"]: after[i] } })) };
    if (key.every((k) => k.desc === key[0]!.desc))
      return { mongo, sql: `(${key.map((k) => k.expr).join(", ")}) ${key[0]!.desc ? "<" : ">"} (${key.map((k) => k.param).join(", ")})`, params: key.map((k, i) => k.encode(after[i])) };
    const parts: string[] = [];
    const params: unknown[] = [];
    key.forEach((k, i) => {
      parts.push(`(${[...key.slice(0, i).map((p) => `${p.expr} = ${p.param}`), `${k.expr} ${k.desc ? "<" : ">"} ${k.param}`].join(" AND ")})`);
      params.push(...key.slice(0, i).map((p, j) => p.encode(after[j])), k.encode(after[i]));
    });
    return { mongo, sql: `(${parts.join(" OR ")})`, params };
  }

  /**
   * In dev, on SQLite: says once per statement when its plan reads the whole table, or walks a whole index while where() filters, or sorts
   * without an index. A walk in index order that only serves the order (and stops at a LIMIT) is what an index is for.
   */
  protected async explain(table: string, sql: string, params: unknown[], filtered: boolean, sorted: boolean) {
    if (!this.warn || this.dialect.name !== "sqlite" || explained.has(sql)) return;
    explained.add(sql);
    this.toDb();
    const plan = (await this.tx.query<{ detail: string }>(`EXPLAIN QUERY PLAN ${sql}`, params)).map((r) => r.detail);
    const scan = plan.find((d) => /^SCAN /.test(d) && (!/USING (COVERING )?INDEX/.test(d) || filtered));
    // Sorting what where() narrowed down is cheap; an orderBy() that no index serves sorts whatever the range holds.
    const sort = sorted ? plan.find((d) => /USE TEMP B-TREE FOR .*ORDER BY/.test(d)) : undefined;
    if (!scan && !sort)
      return;
    this.warn(
      `A query on "${table}" ${scan ? "reads every document of the table" : "sorts its results without an index"}: no index serves its where() or orderBy() (SQLite: ${[scan, sort].filter(Boolean).join("; ")}). Add an index whose fields start with the ones it filters or sorts by, and query withIndex(). (Shown in dev only, once per query.)`,
    );
  }

  async get(id: string): Promise<Doc | null> {
    if (this.nat) {
      const nat = this.nat;
      const text = this.n("SELECT", tableOf(id), () => nat.engine.get(nat.id, id));
      return text === null ? null : JSON.parse(text);
    }
    const table = this.parseId(id);
    const read = topic(table, "by_id", [id]);
    this.reads.add(read);
    const [row] = this.mongo ? await this.mongo.find(table, { filter: { _id: id }, limit: 1 }) : await this.select(table, `${SELECT} "${table}" WHERE "_id" = ?`, [id], [read]);
    return row ? this.toDoc(row) : null;
  }

  /** `get()` as JSON text, for a caller that sends the document on as it is (`"null"` where there is none). */
  async getJson(id: string): Promise<string> {
    if (this.nat) {
      const nat = this.nat;
      return this.n("SELECT", tableOf(id), () => nat.engine.get(nat.id, id)) ?? "null";
    }
    return JSON.stringify(await this.get(id));
  }

  query(table: string) {
    const t = this.table(table);
    let index: string | undefined;
    let order: "asc" | "desc" = "asc";
    const eqs: [string, unknown][] = [];
    const bounds: Bound[] = [];
    let boundField: string | undefined;
    /** Matching documents to pass over before the first one returned: `skip()`. */
    let offset = 0;
    /** where() predicates, compiled to SQL. */
    const wheres: Predicate[] = [];
    /** orderBy()'s keys, in place of the index's order. */
    let orderKeys: { f: string; desc: boolean }[] | undefined;
    /** select()'s fields: what each result keeps, besides _id and _creationTime. */
    let projection: string[] | undefined;
    /** filter() and include() in the order they were called: a filter sees what was included before it. */
    const steps: ({ filter: (doc: Doc) => boolean } | { include: IncludeSpec })[] = [];

    const indexFields = () => {
      if (index === undefined || index === "by_creation_time") return ["_creationTime"];
      const fields = t.indexes[index];
      if (!fields) throw new ValidationError(`Unknown index "${table}.${index}"`);
      return [...fields];
    };

    /** Whether the index, its equalities and its range fit together; the index's fields. */
    const validate = () => {
      const fields = indexFields();
      eqs.forEach(([f], i) => {
        if (fields[i] !== f) throw new ValidationError(`Index "${table}.${index}" field ${i} is "${fields[i]}", not "${f}"`);
      });
      if (boundField !== undefined && fields[eqs.length] !== boundField)
        throw new ValidationError(`Index "${table}.${index}": a range must be on "${fields[eqs.length]}", the field after the equalities`);
      return fields;
    };

    /** The same range as a description for the native engine, which plans it, runs it and keeps what it read. */
    const desc = (limit?: number, after?: unknown[], skip = 0) => {
      validate();
      return JSON.stringify({
        table,
        index,
        eqs: eqs.map(([f, value]) => [f, orUndef(value)]),
        bounds: bounds.map((b) => ({ op: b.op, value: orUndef(b.value) })),
        boundField,
        wheres: wheres.map((w) => w.ast),
        orderKeys,
        desc: order === "desc",
        limit,
        skip,
        after,
      });
    };

    /** The SQL for the index range, after `after` (the order key of the last document already seen). Also records what the query reads. */
    const plan = (after?: unknown[]) => {
      const fields = validate();
      const conds: { sql: string; params: unknown[]; mongo: MongoFilter }[] = eqs.map(([f, value]) => ({
        ...(f === "_creationTime" ? { sql: `"_creationTime" = ?`, params: [value] } : this.dialect.fieldEquals(f, value)),
        mongo: { [mpath(f)]: meq(value) },
      }));
      if (bounds.length) {
        const c = this.col(boundField!);
        const operators = { ">": "$gt", ">=": "$gte", "<": "$lt", "<=": "$lte" } as const;
        for (const b of bounds) conds.push({ sql: `${c.expr} ${b.op} ${c.param}`, params: [c.encode(b.value)], mongo: {} });
        conds.at(-bounds.length)!.mongo = { [mpath(boundField!)]: Object.fromEntries(bounds.map((b) => [operators[b.op], b.value])) };
      }
      conds.push(...wheres);
      const keys = orderKey();
      const keyFields = keys.map((k) => k.f);
      const key = keys.map((k) => ({ ...this.col(k.f), desc: k.desc, f: k.f }));
      if (after) conds.push(this.keyset(key, after));
      // Reads of a range or page are tracked at the equality prefix: coarser, never missed.
      const read =
        eqs.length && index !== undefined
          ? topic(
              table,
              index,
              eqs.map(([, value]) => value),
            )
          : table;
      this.reads.add(read);
      const filters = conds.map((c) => c.mongo).filter((m) => Object.keys(m).length);
      return {
        read,
        where: conds.length ? `WHERE ${conds.map((c) => c.sql).join(" AND ")}` : "",
        params: conds.flatMap((c) => c.params),
        orderBy: key.map((k) => `${k.expr}${k.desc ? " DESC" : ""}`).join(", "),
        keyFields,
        /** The same range as a MongoDB filter and sort. */
        filter: (filters.length > 1 ? { $and: filters } : (filters[0] ?? {})) as MongoFilter,
        sort: Object.fromEntries(keys.map((k) => [mpath(k.f), k.desc ? -1 : 1])) as Record<string, 1 | -1>,
      };
    };

    /**
     * The order key: orderBy()'s fields, or the index's after its equalities; then _creationTime and _id, which make it unique, in the direction
     * of the last key (so an index on those fields serves the whole order). order("desc") reverses all of it.
     */
    const orderKey = () => {
      const base = orderKeys ?? indexFields().slice(eqs.length).map((f) => ({ f, desc: false }));
      const keys: { f: string; desc: boolean }[] = [];
      const tie = base.at(-1)?.desc ?? false;
      for (const k of [...base, { f: "_creationTime", desc: tie }, { f: "_id", desc: tie }]) if (!keys.some((x) => x.f === k.f)) keys.push(k);
      return order === "desc" ? keys.map((k) => ({ ...k, desc: !k.desc })) : keys;
    };

    /** The fields the order key is made of (what a cursor holds). */
    const keyFieldsOf = () => orderKey().map((k) => k.f);

    const run = async (limit?: number, after?: unknown[], skip = 0) => {
      if (this.nat) {
        const nat = this.nat;
        const d = desc(limit, after, skip);
        if (this.warn && (wheres.length || orderKeys)) {
          const q = JSON.parse(nat.engine.planSql(d)) as { sql: string; params: unknown[] };
          await this.explain(table, q.sql, q.params, wheres.length > 0, Boolean(orderKeys));
        }
        return { docs: JSON.parse(this.n("SELECT", table, () => nat.engine.query(nat.id, table, d))) as Doc[], keyFields: keyFieldsOf() };
      }
      const p = plan(after);
      // SQLite needs a LIMIT before an OFFSET; Postgres takes any bigint.
      const page = skip ? ` LIMIT ${limit ?? Number.MAX_SAFE_INTEGER} OFFSET ${skip}` : limit === undefined ? "" : ` LIMIT ${limit}`;
      const sql = `${SELECT} "${table}" ${p.where} ORDER BY ${p.orderBy}${page}`;
      if (this.mongo) {
        if (limit === 0) return { docs: [], keyFields: p.keyFields }; // for MongoDB a limit of 0 is no limit
        const rows = await this.mongo.find(table, { filter: p.filter, sort: p.sort, limit, skip: skip || undefined });
        return { docs: rows.map((r) => this.toDoc(r)), keyFields: p.keyFields };
      }
      if (wheres.length || orderKeys) await this.explain(table, sql, p.params, wheres.length > 0, Boolean(orderKeys));
      const rows = await this.select(table, sql, p.params, [p.read]);
      return { docs: rows.map((r) => this.toDoc(r)), keyFields: p.keyFields };
    };

    /** The documents of the range as JSON text when nothing has to look at them (the native engine, no filter(), include() or select()); otherwise the objects, written out. */
    const jsonOf = async (limit: number | undefined, collect: () => Promise<unknown>): Promise<string> => {
      if (!this.nat || steps.length || projection) return JSON.stringify(await collect());
      const nat = this.nat;
      const d = desc(limit, undefined, offset);
      return this.n("SELECT", table, () => nat.engine.query(nat.id, table, d));
    };

    const keyOf = (keyFields: string[], doc: Doc) => keyFields.map((f) => doc[f] ?? null);
    // Steps up to the last filter have to run on everything scanned; includes after it only on what's returned.
    const lastFilter = () => steps.findLastIndex((x) => "filter" in x);
    const hasFilter = () => lastFilter() >= 0;
    const apply = async (docs: Doc[], upTo: Step[]) => {
      let out = docs;
      for (const step of upTo) out = "include" in step ? await this.join(table, out, step.include) : out.filter(step.filter);
      return out;
    };
    const scanned = (docs: Doc[]) => apply(docs, steps.slice(0, lastFilter() + 1));
    /** select(): each result keeps _id, _creationTime and the fields asked for (a field it doesn't have stays out). */
    const project = (docs: Doc[]) =>
      projection ? docs.map((d) => Object.fromEntries([["_id", d._id], ["_creationTime", d._creationTime], ...projection!.filter((f) => f in d).map((f) => [f, d[f]])]) as Doc) : docs;
    const finish = async (docs: Doc[]) => project(await apply(docs, steps.slice(lastFilter() + 1)));

    /** Up to `want` documents after `after` that pass the filters, past the first `skip` of them, scanning the range in batches. */
    const batchSize = scanBatchOf(this.dialect);
    const matches = async (want: number, after?: unknown[], skip = offset) => {
      const out: Doc[] = [];
      let keyFields: string[] = [];
      if (!hasFilter()) {
        const r = await run(Number.isFinite(want) ? want : undefined, after, skip); // the database skips them: never loaded
        return { docs: r.docs, keyFields: r.keyFields };
      }
      let seen = 0;
      for (let cursor = after; ;) {
        const batch = await run(batchSize, cursor);
        keyFields = batch.keyFields;
        for (const d of await scanned(batch.docs)) {
          if (skip > 0) {
            skip--;
            continue;
          }
          out.push(d);
          if (out.length >= want) return { docs: out, keyFields };
        }
        seen += batch.docs.length;
        if (batch.docs.length < batchSize) return { docs: out, keyFields };
        if (seen >= MAX_SCAN) throw new ValidationError(`filter() scanned ${MAX_SCAN} documents of "${table}" without finishing; narrow the range with withIndex()`);
        cursor = keyOf(keyFields, batch.docs.at(-1)!);
      }
    };

    /** Every matching document, a batch at a time, for aggregates. */
    const each = async (visit: (doc: Doc) => void, skip = offset) => {
      let cursor: unknown[] | undefined;
      let seen = 0;
      for (;;) {
        const batch = await run(batchSize * 4, cursor);
        for (const d of await scanned(batch.docs)) {
          if (skip > 0) skip--;
          else visit(d);
        }
        seen += batch.docs.length;
        if (batch.docs.length < batchSize * 4) return;
        if (seen >= MAX_SCAN) throw new ValidationError(`Aggregates scan at most ${MAX_SCAN} documents of "${table}"; narrow the range with withIndex()`);
        cursor = keyOf(batch.keyFields, batch.docs.at(-1)!);
      }
    };

    /** How many documents the range holds after the filters, before any skip. */
    const total = async () => {
      if (hasFilter()) {
        let n = 0;
        await each(() => n++, 0);
        return n;
      }
      if (this.nat) {
        const nat = this.nat;
        const d = desc();
        return this.n("SELECT", table, () => nat.engine.count(nat.id, table, d));
      }
      const p = plan();
      if (this.mongo) return this.mongo.count(table, p.filter);
      const [row] = await this.select(table, `SELECT COUNT(*) AS "n" FROM "${table}" ${p.where}`, p.params, [p.read]);
      return Number(row?.n ?? 0);
    };

    const checkNumeric = (name: string, field: string) => {
      const v = t.fields[field];
      if (field !== "_creationTime" && t.strict && v?.kind !== "number") throw new ValidationError(`${name}() needs a number field; "${table}.${field}" isn't one`);
    };

    /**
     * How many values a number field has in the range, their sum, and their smallest and largest, worked out by the database instead of a pass
     * over the documents. Only when the answer is exactly the one the pass would give; otherwise undefined and the caller reads the documents
     * (which also words the error for a field that holds something else):
     * - a database that can do it (`numberStats`), no filter() or skip() (those need the documents), a field of the document;
     * - every value a number: a stored string, array or boolean sends the caller to the pass, which throws;
     * - for the sum, integers small enough that adding them in any order is exact (a database adds reals differently from a loop);
     * - fewer documents than the scan limit (past it the pass throws).
     */
    const databaseStats = async (field: string) => {
      if (!(this.dialect.numberStats || this.mongo) || hasFilter() || offset > 0 || !IDENT.test(field) || field === "_creationTime" || field === "_id") return undefined;
      const p = plan();
      const stats = this.mongo
        ? await this.mongo.stats(table, p.filter, field)
        : await this.dialect.numberStats!(async (sql, params) => this.select(table, sql, params, [p.read]), table, field, p.where, p.params);
      if (!stats || stats.rows >= MAX_SCAN || stats.bad > 0) return undefined;
      const exact = stats.nonint === 0 && (stats.n === 0 || stats.n * Math.max(Math.abs(stats.min!), Math.abs(stats.max!)) <= Number.MAX_SAFE_INTEGER);
      return { n: stats.n, sum: exact ? stats.sum : undefined, min: stats.min, max: stats.max };
    };

    const numbers = async (name: string, field: string) => {
      checkNumeric(name, field);
      const values: number[] = [];
      await each((d) => {
        const x = d[field];
        if (x === undefined || x === null) return;
        if (typeof x !== "number") throw new ValidationError(`${name}(): "${table}.${field}" holds a ${typeof x}, not a number`);
        values.push(x);
      });
      return values;
    };

    const q = {
      order(o: "asc" | "desc") {
        if (o !== "asc" && o !== "desc") throw new ValidationError(`order() expects "asc" or "desc"`);
        order = o;
        return q;
      },
      /** Keeps documents the function returns true for, seeing whatever `include()` added before it. Reads still cover the whole index range, so a change to a skipped document re-runs the query. */
      filter(predicate: (doc: Doc) => boolean) {
        if (typeof predicate !== "function") throw new ValidationError("filter() expects a function");
        steps.push({ filter: predicate });
        return q;
      },
      /** Passes over the first `n` matching documents (those that pass every filter), in the query's order. Without a filter the database skips them. */
      skip(n: number) {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`skip() expects a non-negative integer, got ${n}`);
        if (offset + n > MAX_SCAN) throw new ValidationError(`skip() passes over at most ${MAX_SCAN} documents, got ${offset + n}; go further with paginate()`);
        offset += n;
        return q;
      },
      /** Keeps the documents the predicate holds for, in the database: where((q) => q.or(q.eq("status", "open"), q.in("priority", [1, 2]))). */
      where: (build: (b: ReturnType<DocStore["predicates"]>) => unknown) => {
        if (typeof build !== "function") throw new ValidationError('where() expects a function: where((q) => q.eq("done", false))');
        const p = build(this.predicates(table));
        if (!isPredicate(p)) throw new ValidationError("where()'s function must return a predicate from its builder (q.eq, q.and, …)");
        wheres.push(p);
        return q;
      },
      /** Sorts by these fields, each ascending or descending, then _creationTime and _id; in place of the index's order. */
      orderBy: (keys: unknown) => {
        if (!Array.isArray(keys) || !keys.length) throw new ValidationError('orderBy() expects [field, "asc" | "desc"] pairs: orderBy([["dueDate", "asc"], ["priority", "desc"]])');
        orderKeys = keys.map((k) => {
          if (!Array.isArray(k) || (k[1] !== "asc" && k[1] !== "desc")) throw new ValidationError(`orderBy() expects [field, "asc" | "desc"] pairs, got ${JSON.stringify(k)}`);
          return { f: this.fieldName(table, k[0], "orderBy"), desc: k[1] === "desc" };
        });
        return q;
      },
      /** Keeps only these fields of each result, besides _id and _creationTime. */
      select: (fields: unknown) => {
        if (!Array.isArray(fields) || !fields.length) throw new ValidationError('select() expects field names: select(["title", "done"])');
        projection = fields.map((f) => (typeof f === "string" && IDENT.test(f) ? f : this.fieldName(table, f, "select")));
        return q;
      },
      /** Adds related documents to each result; see `IncludeSpec`. */
      include: (spec: IncludeSpec) => {
        this.checkInclude(table, spec);
        steps.push({ include: spec });
        return q;
      },
      collect: async () => finish((await matches(Infinity)).docs),
      first: async () => (await finish((await matches(1)).docs))[0] ?? null,
      /** collect(), first() and take() as JSON text, for a caller that sends the documents on as they are (`"null"` for no first). The native engine answers with the text it keeps. */
      collectJson: () => jsonOf(undefined, () => q.collect()),
      firstJson: async () => {
        const text = await jsonOf(1, () => q.first().then((d) => [d].filter(Boolean)));
        return text === "[]" ? "null" : text.slice(1, -1);
      },
      takeJson: (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return jsonOf(n, () => q.take(n));
      },
      unique: async () => {
        const { docs } = await matches(2);
        if (docs.length > 1) throw new ValidationError(`unique() found more than one document in "${table}"`);
        return (await finish(docs))[0] ?? null;
      },
      take: async (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return finish((await matches(n)).docs);
      },
      count: async () => Math.max(0, (await total()) - offset),
      sum: async (field: string) => {
        checkNumeric("sum", field);
        const s = await databaseStats(field);
        if (s?.sum !== undefined) return s.sum;
        return (await numbers("sum", field)).reduce((a, b) => a + b, 0);
      },
      avg: async (field: string) => {
        checkNumeric("avg", field);
        const s = await databaseStats(field);
        if (s?.sum !== undefined) return s.n ? s.sum / s.n : null;
        const xs = await numbers("avg", field);
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      },
      min: async (field: string) => {
        checkNumeric("min", field);
        const s = await databaseStats(field);
        if (s) return s.min;
        const xs = await numbers("min", field);
        return xs.length ? xs.reduce((a, b) => Math.min(a, b)) : null;
      },
      max: async (field: string) => {
        checkNumeric("max", field);
        const s = await databaseStats(field);
        if (s) return s.max;
        const xs = await numbers("max", field);
        return xs.length ? xs.reduce((a, b) => Math.max(a, b)) : null;
      },
      paginate: async ({ numItems, cursor, offset: extra = 0, withTotal }: { numItems: number; cursor: string | null; offset?: number; withTotal?: boolean }) => {
        if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_PAGE) throw new ValidationError(`paginate() numItems must be an integer from 1 to ${MAX_PAGE}`);
        if (!Number.isInteger(extra) || extra < 0) throw new ValidationError(`paginate() offset must be a non-negative integer, got ${extra}`);
        const keyLength = orderKey().length;
        const after = cursor === null ? undefined : decodeCursor(cursor, keyLength);
        // skip() places the first page; a cursor already says where the next one starts. An offset counts from wherever the page starts.
        const skip = (after ? 0 : offset) + extra;
        if (skip > MAX_SCAN) throw new ValidationError(`paginate() passes over at most ${MAX_SCAN} documents, got ${skip}; go further with a cursor`);
        const { docs, keyFields } = await matches(numItems + 1, after, skip);
        const page = docs.slice(0, numItems);
        const last = page.at(-1);
        return {
          page: await finish(page),
          isDone: docs.length <= numItems,
          continueCursor: last ? encodeCursor(keyOf(keyFields, last)) : (cursor ?? encodeCursor([])),
          ...(withTotal === true && { total: await total() }),
        };
      },
    };
    const bound = (op: Bound["op"]) => (f: string, value: unknown) => {
      if (boundField !== undefined && boundField !== f) throw new ValidationError("Lower and upper bounds must be on the same field");
      if (bounds.some((b) => b.op[0] === op[0])) throw new ValidationError(`Only one ${op[0] === ">" ? "lower" : "upper"} bound is allowed`);
      boundField = f;
      bounds.push({ op, value });
      return builder;
    };
    const builder = {
      eq(f: string, value: unknown) {
        if (bounds.length) throw new ValidationError("eq() must come before range bounds");
        eqs.push([f, value]);
        return builder;
      },
      gt: bound(">"),
      gte: bound(">="),
      lt: bound("<"),
      lte: bound("<="),
    };

    return {
      ...q,
      withIndex(name: string, range?: (b: any) => unknown) {
        index = name;
        indexFields(); // fail fast on unknown indexes
        range?.(builder);
        return q;
      },
      withSearchIndex: (name: string, filter: (b: any) => unknown) => this.search(table, name, filter),
    };
  }

  private search(table: string, name: string, filter: (b: any) => unknown) {
    const config = this.table(table).searchIndexes?.[name];
    if (!config) throw new ValidationError(`Unknown search index "${table}.${name}"`);
    let text: string | undefined;
    let joins: IncludeSpec | undefined;
    const eqs: [string, unknown][] = [];
    const finalizer = {
      eq(f: string, value: unknown) {
        if (!config.filterFields.includes(f)) throw new ValidationError(`"${f}" is not a filter field of search index "${table}.${name}"`);
        eqs.push([f, value]);
        return finalizer;
      },
    };
    filter({
      search(f: string, query: string) {
        if (f !== config.searchField) throw new ValidationError(`Search index "${table}.${name}" searches "${config.searchField}", not "${f}"`);
        if (typeof query !== "string") throw new ValidationError("search() expects a string");
        text = query;
        return finalizer;
      },
    });
    if (text === undefined) throw new ValidationError("withSearchIndex() needs q.search(field, text)");
    const run = async (limit: number) => {
      this.reads.add(table); // any write to the table may change ranking
      const terms = searchTerms(text!);
      if (!terms.length) return [];
      if (this.mongo) {
        // Every word, the last one as a prefix (the index holds each document's words), best match first.
        const rows = await this.mongo.search(table, {
          field: mongoSearchField(name),
          terms,
          filter: eqs.length ? { $and: eqs.map(([f, value]) => ({ [mpath(f)]: meq(value) })) } : {},
          limit: Math.min(limit, MAX_SEARCH),
        });
        const docs = rows.map((r) => this.toDoc(r));
        return joins ? this.join(table, docs, joins) : docs;
      }
      const filters = eqs.map(([f, value]) => this.dialect.fieldEquals(f, value));
      const { sql, params } = this.dialect.searchSql(table, name, config.searchField, terms, filters, Math.min(limit, MAX_SEARCH));
      const docs = (await this.tx.query(sql, params)).map((r) => this.toDoc(r));
      return joins ? this.join(table, docs, joins) : docs;
    };
    const results = {
      include: (spec: IncludeSpec) => {
        this.checkInclude(table, spec);
        joins = { ...joins, ...spec };
        return results;
      },
      take: (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return run(n);
      },
      first: async () => (await run(1))[0] ?? null,
      collect: () => run(MAX_SEARCH),
    };
    return results;
  }

  // ---- relationships ----

  /** Documents by id, in the order asked for (`null` where one doesn't exist). Ids may belong to different tables. */
  async getMany(ids: readonly string[]): Promise<(Doc | null)[]> {
    if (this.nat) {
      const nat = this.nat;
      return JSON.parse(this.n("SELECT", ids.length ? tableOf(ids[0]!) : undefined, () => nat.engine.getMany(nat.id, ids as string[])));
    }
    const byTable = new Map<string, Set<string>>();
    for (const id of ids) {
      const table = this.parseId(id);
      if (!byTable.has(table)) byTable.set(table, new Set());
      byTable.get(table)!.add(id);
    }
    const found = new Map<string, Doc>();
    for (const [table, set] of byTable) {
      const unique = [...set];
      for (let i = 0; i < unique.length; i += IN_CHUNK) {
        const chunk = unique.slice(i, i + IN_CHUNK);
        const topics = chunk.map((id) => topic(table, "by_id", [id]));
        for (const t of topics) this.reads.add(t);
        const rows = this.mongo ? await this.mongo.find(table, { filter: { _id: { $in: chunk } } }) : await this.select(table, `${SELECT} "${table}" WHERE "_id" IN (${chunk.map(() => "?").join(", ")})`, chunk, topics);
        for (const row of rows) found.set(row._id, this.toDoc(row));
      }
    }
    return ids.map((id) => found.get(id) ?? null);
  }

  /** What an include rule means for `table`, or why it can't be used. */
  private relation(table: string, key: string, rule: IncludeRule) {
    const t = this.table(table);
    if (key in t.fields || key === "_id" || key === "_creationTime") throw new ValidationError(`include() key "${key}" is already a field of "${table}"`);
    if (typeof rule === "string") {
      const ref = t.fields[rule] && referenceOf(t.fields[rule]);
      if (!ref) throw new ValidationError(`include() "${key}": "${table}.${rule}" isn't a reference; use a field declared with v.id(...) or v.array(v.id(...))`);
      return { kind: "forward" as const, field: rule, ...ref };
    }
    const child = this.table(rule.table);
    const fields = rule.index === "by_creation_time" ? undefined : child.indexes[rule.index];
    if (!fields) throw new ValidationError(`include() "${key}": unknown index "${rule.table}.${rule.index}"`);
    const ref = child.fields[fields[0]!] && referenceOf(child.fields[fields[0]!]!);
    if (!ref || ref.many || ref.target !== table)
      throw new ValidationError(`include() "${key}": index "${rule.table}.${rule.index}" must start with a v.id("${table}") field to find the ${rule.table} of a ${table}`);
    if (rule.take !== undefined && (!Number.isInteger(rule.take) || rule.take < 0)) throw new ValidationError(`include() "${key}": take must be a non-negative integer`);
    return { kind: "reverse" as const, field: fields[0]!, rule, child };
  }

  /** What an include() means for `table`, as the native engine takes it: each rule resolved to the field or index it follows (and checked, like `checkInclude`). */
  includePlan(table: string, spec: IncludeSpec): unknown[] {
    if (!spec || typeof spec !== "object") throw new ValidationError('include() expects an object like { list: "listId" }');
    return Object.entries(spec).map(([key, rule]) => {
      const r = this.relation(table, key, rule);
      if (r.kind === "forward") return { key, kind: "forward", field: r.field, many: Boolean(r.many) };
      return {
        key,
        kind: "reverse",
        field: r.field,
        table: r.rule.table,
        index: r.rule.index,
        take: r.rule.take,
        orderDesc: r.rule.order === "desc",
        count: Boolean(r.rule.count),
        include: r.rule.include ? this.includePlan(r.rule.table, r.rule.include) : [],
      };
    });
  }

  checkInclude(table: string, spec: IncludeSpec) {
    if (!spec || typeof spec !== "object") throw new ValidationError('include() expects an object like { list: "listId" }');
    for (const [key, rule] of Object.entries(spec)) {
      const r = this.relation(table, key, rule);
      if (r.kind === "reverse" && r.rule.include) this.checkInclude(r.rule.table, r.rule.include);
    }
  }

  /** Adds the related documents described by `spec` to each of `docs` (which belong to `table`), in as few queries as it can. */
  async join(table: string, docs: Doc[], spec: IncludeSpec): Promise<Doc[]> {
    this.checkInclude(table, spec);
    if (!docs.length) return docs;
    const out = docs.map((d) => ({ ...d }));
    for (const [key, rule] of Object.entries(spec)) {
      const r = this.relation(table, key, rule);
      if (r.kind === "forward") {
        const ids = [...new Set(out.flatMap((d) => (r.many ? ((d[r.field] as string[] | undefined) ?? []) : d[r.field] ? [d[r.field] as string] : [])))];
        const found = new Map(ids.map((id, i) => [id, null as Doc | null]));
        (await this.getMany(ids)).forEach((doc, i) => found.set(ids[i]!, doc));
        for (const d of out) d[key] = r.many ? ((d[r.field] as string[] | undefined) ?? []).flatMap((id) => found.get(id) ?? []) : (found.get(d[r.field]) ?? null);
      } else await this.joinReverse(table, out, key, r.rule, r.field);
    }
    return out;
  }

  private async joinReverse(table: string, docs: Doc[], key: string, rule: Extract<IncludeRule, object>, field: string) {
    const child = this.table(rule.table);
    const order = rule.order ?? "asc";
    if (rule.count) {
      // Counts are cached per parent (a write to one parent's children drops only that parent's count); the ones the cache doesn't have
      // come from one grouped query per chunk. A parent with no children isn't in that result and counts 0.
      const counts = new Map<string, number>();
      const countKey = (id: string) => `count\u0000${rule.table}\u0000${field}\u0000${id}`;
      const missing: string[] = [];
      for (const id of new Set(docs.map((d) => d._id))) {
        this.reads.add(topic(rule.table, rule.index, [id])); // what counting that parent's children by query would have read
        const hit = this.peek(rule.table, countKey(id));
        if (hit) counts.set(id, hit[0]!.n);
        else missing.push(id);
      }
      // One count per parent, as scalar subqueries in one statement: each is answered from the index alone, where a GROUP BY on the
      // field would have to read every child row to evaluate it (2x slower at a few hundred children each).
      for (let i = 0; i < missing.length; i += OR_CHUNK) {
        const chunk = missing.slice(i, i + OR_CHUNK);
        this.toDb();
        let rows: Row[];
        if (this.mongo) {
          const counted = await this.mongo.countChildren(rule.table, field, chunk);
          rows = chunk.map((id, k) => ({ k, n: counted.get(id) ?? 0 }));
        } else if (this.dialect.countChildren) {
          const q = this.dialect.countChildren(rule.table, field, chunk);
          rows = await this.tx.query(q.sql, q.params);
        } else {
          const conds = chunk.map((id) => this.dialect.fieldEquals(field, id));
          rows = await this.tx.query(
            chunk.map((_, k) => `SELECT ${k} AS "k", (SELECT COUNT(*) FROM "${rule.table}" WHERE ${conds[k]!.sql}) AS "n"`).join(" UNION ALL "),
            conds.flatMap((c) => c.params),
          );
        }
        for (const r of rows) {
          const id = chunk[Number(r.k)]!;
          const n = Number(r.n);
          counts.set(id, n);
          this.keep(rule.table, countKey(id), [{ n }], [topic(rule.table, rule.index, [id])]);
        }
      }
      for (const d of docs) d[key] = counts.get(d._id) ?? 0;
      return;
    }
    // The index's order after the equality, then _creationTime and _id; descending flips all of it.
    const restFields = [...(child.indexes[rule.index] ?? []).slice(1).filter((f) => f !== "_creationTime"), "_creationTime", "_id"];
    const rest = restFields.map((f) => this.col(f));
    const orderBy = rest.map((k) => `${k.expr}${order === "desc" ? " DESC" : ""}`).join(", ");
    if (rule.take !== undefined && !((this.dialect.childrenOf || this.mongo) && rule.take > 0)) {
      // A limit per parent needs a query per parent.
      for (const d of docs) {
        const read = topic(rule.table, rule.index, [d._id]);
        this.reads.add(read);
        const cond = this.dialect.fieldEquals(field, d._id);
        const rows = rule.take === 0 ? [] : await this.select(rule.table, `${SELECT} "${rule.table}" WHERE ${cond.sql} ORDER BY ${orderBy} LIMIT ${rule.take}`, cond.params, [read]);
        const kids = rows.map((r) => this.toDoc(r));
        d[key] = rule.include ? await this.join(rule.table, kids, rule.include) : kids;
      }
      return;
    }
    // Everything at once: one query for a chunk of parents, grouped afterwards. With a limit per parent, a database that can answers that
    // in one statement as well (the others were a statement each).
    const groups = new Map<string, Doc[]>(docs.map((d) => [d._id, []]));
    const ids = [...groups.keys()];
    for (let i = 0; i < ids.length; i += OR_CHUNK) {
      const chunk = ids.slice(i, i + OR_CHUNK);
      const topics = chunk.map((id) => topic(rule.table, rule.index, [id]));
      for (const t of topics) this.reads.add(t);
      let rows: Row[];
      if (this.mongo) {
        const sort = Object.fromEntries(restFields.map((f) => [mpath(f), order === "desc" ? -1 : 1])) as Record<string, 1 | -1>;
        rows = rule.take !== undefined ? await this.mongo.childrenOf(rule.table, field, chunk, sort, rule.take) : await this.mongo.find(rule.table, { filter: { [mpath(field)]: { $in: chunk } }, sort });
      } else if (rule.take !== undefined) {
        const q = this.dialect.childrenOf!(rule.table, field, chunk, orderBy, rule.take);
        rows = await this.select(rule.table, q.sql, q.params, topics);
      } else {
        const conds = chunk.map((id) => this.dialect.fieldEquals(field, id));
        rows = await this.select(rule.table, `${SELECT} "${rule.table}" WHERE (${conds.map((c) => c.sql).join(" OR ")}) ORDER BY ${orderBy}`, conds.flatMap((c) => c.params), topics);
      }
      for (const row of rows) {
        const doc = this.toDoc(row);
        groups.get(doc[field])?.push(doc);
      }
    }
    const all = rule.include ? await this.join(rule.table, [...groups.values()].flat(), rule.include) : [...groups.values()].flat();
    const joined = new Map(all.map((c) => [c._id, c]));
    for (const d of docs) d[key] = groups.get(d._id)!.map((c) => joined.get(c._id)!);
  }

  /**
   * A write to `doc` (a document of `table` with its `_id`) has happened: the table and its topics are written. When `before` is the
   * document it replaced, its topics are added too, but only for the index prefixes whose values the change touched: a prefix both
   * versions share is one topic, built once.
   */
  private written(table: string, doc: Record<string, unknown>, before?: Record<string, unknown>) {
    if (this.nat) {
      // a write made with statements of its own (a restore): the engine keeps the topics and the cache's bookkeeping
      const nat = this.nat;
      this.n("UPDATE", table, () => nat.engine.noteWritten(nat.id, table, JSON.stringify(doc), before === undefined ? undefined : JSON.stringify(before)));
      return;
    }
    const w = this.writes!;
    // From here this transaction reads its own uncommitted writes, so only from the database; and nobody may use the table until it settles.
    this.dirty = true;
    if (this.cache && !this.writing.has(table)) {
      this.writing.add(table);
      this.cache.writing(table);
    }
    w.add(table);
    w.add(topic(table, "by_id", [doc._id]));
    for (const [name, fields] of Object.entries(this.table(table).indexes)) {
      let shared = before !== undefined;
      for (let k = 1; k <= fields.length; k++) {
        const f = fields[k - 1]!;
        if (shared && !sameValue(doc[f], before![f])) shared = false;
        w.add(topic(table, name, fields.slice(0, k).map((x) => doc[x])));
        if (before && !shared) w.add(topic(table, name, fields.slice(0, k).map((x) => before[x])));
      }
    }
  }

  /** On MongoDB, the words of each search index of a document, to be stored with it (SQLite and Postgres keep theirs in a table and an index). */
  private searchWordsOf(table: string, fields: Record<string, unknown>) {
    const out: Record<string, string[]> = {};
    for (const [name, { searchField }] of Object.entries(this.table(table).searchIndexes ?? {})) out[mongoSearchField(name)] = typeof fields[searchField] === "string" ? searchWords(fields[searchField] as string) : [];
    return out;
  }

  private async syncSearch(table: string, id: string, doc: Record<string, unknown> | undefined) {
    if (this.mongo) return; // stored with the document
    for (const [name, { searchField }] of Object.entries(this.table(table).searchIndexes ?? {})) {
      const text = typeof doc?.[searchField] === "string" ? (doc[searchField] as string) : undefined;
      for (const s of this.dialect.searchWrite(table, name, id, text)) await this.tx.execute(s.sql, s.params);
    }
  }

  protected checked(table: string, value: Record<string, unknown>) {
    if (!this.writes) throw new Error("Database is read-only in queries");
    const t = this.table(table);
    const { _id, _creationTime, ...rest } = value ?? {};
    const fields = Object.fromEntries(Object.entries(t.strict ? (value ?? {}) : rest).filter(([, x]) => x !== undefined));
    if (t.strict) validateFields(t.fields, fields, table);
    const json = JSON.stringify(fields);
    if (json.length > this.maxDocumentBytes) throw new ValidationError(`Document in "${table}" is ${json.length} bytes; the limit is ${this.maxDocumentBytes} (MAX_DOCUMENT_BYTES)`);
    return { fields, json };
  }

  async insert(table: string, value: Record<string, unknown>): Promise<string> {
    const { fields, json } = this.checked(table, value);
    const [_id] = await this.insertChecked(table, [{ fields, json }]);
    return _id!;
  }

  /** Writes documents already validated: one INSERT per 200 rows, each with a fresh id and a creation time after the last. */
  private async insertChecked(table: string, rows: { fields: Record<string, unknown>; json: string }[]) {
    if (this.nat) {
      const nat = this.nat;
      this.table(table);
      return this.n("INSERT", table, () => nat.engine.insert(nat.id, table, rows.map((r) => r.json), this.maxDocumentBytes, true)); // validated by `checked()` already
    }
    const docs = rows.map((r) => ({ ...r, _id: `${table}:${crypto.randomUUID().replaceAll("-", "")}`, _creationTime: creationTime() }));
    const bulk = this.dialect.bulkInsert;
    const size = bulk || this.mongo ? 2000 : 200;
    for (let i = 0; i < docs.length; i += size) {
      const part = docs.slice(i, i + size);
      if (this.mongo) await this.mongo.insert(table, part.map((d) => ({ _id: d._id, _creationTime: d._creationTime, doc: d.fields, ...this.searchWordsOf(table, d.fields) })));
      else if (bulk) {
        const q = bulk(table, part.map((d) => ({ id: d._id, time: d._creationTime, json: d.json })));
        await this.tx.execute(q.sql, q.params);
      } else
        await this.tx.execute(
          `INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES ${part.map(() => `(?, ?, ${this.dialect.jsonParam})`).join(", ")}`,
          part.flatMap((d) => [d._id, d._creationTime, d.json]),
        );
    }
    const many = this.dialect.searchInsertMany;
    if (many && !this.mongo) {
      for (const [name, { searchField }] of Object.entries(this.table(table).searchIndexes ?? {})) {
        const indexed = docs.flatMap((d) => (typeof d.fields[searchField] === "string" ? [{ id: d._id, text: d.fields[searchField] as string }] : []));
        for (const s of many(table, name, indexed)) await this.tx.execute(s.sql, s.params);
      }
      for (const d of docs) this.written(table, { ...d.fields, _id: d._id });
    } else
      for (const d of docs) {
        await this.syncSearch(table, d._id, d.fields);
        this.written(table, { ...d.fields, _id: d._id });
      }
    return docs.map((d) => d._id);
  }

  /** Validates every value against the schema first. `all` (the default) writes none if any is invalid; `partial` writes the valid ones and lists the rest. */
  async insertMany(table: string, values: Record<string, unknown>[], opts?: { mode?: BatchMode }) {
    const mode = batchMode("insertMany", opts);
    if (!Array.isArray(values)) throw new ValidationError("insertMany() expects an array of documents");
    if (!this.writes) throw new Error("Database is read-only in queries");
    const checked = values.map((value, index) => {
      try {
        return { index, ...this.checked(table, value) };
      } catch (e) {
        if (e instanceof ValidationError) return { index, error: e.message };
        throw e;
      }
    });
    const errors = checked.filter((c): c is { index: number; error: string } => "error" in c).map((c) => ({ index: c.index, message: c.error }));
    if (mode === "all" && errors.length) throw new ValidationError(`insertMany() on "${table}": ${errors.length} of ${values.length} documents are invalid, so none was inserted. Document ${errors[0]!.index}: ${errors[0]!.message}`);
    const valid = checked.filter((c): c is { index: number; fields: Record<string, unknown>; json: string } => !("error" in c));
    const ids = await this.insertChecked(table, valid);
    if (mode === "all") return ids;
    const byIndex: (string | null)[] = values.map(() => null);
    valid.forEach((c, i) => (byIndex[c.index] = ids[i]!));
    return { ids: byIndex, errors };
  }

  /** Patches many documents of `table` (shallow merges, like patch()), every result validated before any is written; `mode` as for insertMany(). */
  async updateMany(table: string, updates: { id: string; patch: Record<string, unknown> }[], opts?: { mode?: BatchMode }) {
    const mode = batchMode("updateMany", opts);
    if (!Array.isArray(updates)) throw new ValidationError("updateMany() expects an array of { id, patch }");
    if (!this.writes) throw new Error("Database is read-only in queries");
    this.table(table);
    const ids = [...new Set(updates.map((u) => u?.id).filter((id): id is string => typeof id === "string" && id.startsWith(`${table}:`)))];
    const current = new Map<string, Doc>();
    /** The text each document is stored as (SQLite), to leave out an update that changes nothing. */
    const stored = new Map<string, string>();
    for (let i = 0; i < ids.length; i += IN_CHUNK) {
      const chunk = ids.slice(i, i + IN_CHUNK);
      const found = this.mongo ? await this.mongo.find(table, { filter: { _id: { $in: chunk } } }) : await this.tx.query(`${SELECT} "${table}" WHERE "_id" IN (${chunk.map(() => "?").join(", ")})`, chunk);
      for (const row of found) {
        current.set(row._id, this.toDoc(row));
        if (typeof row.doc === "string") stored.set(row._id, row.doc);
        else if (this.mongo) stored.set(row._id, JSON.stringify(row.doc)); // to leave out an update that changes nothing
      }
    }
    const writes: { id: string; old: Doc; fields: Record<string, unknown>; json: string }[] = [];
    const errors: { index: number; message: string }[] = [];
    updates.forEach((u, index) => {
      try {
        if (typeof u?.id !== "string" || !u.id.startsWith(`${table}:`)) throw new ValidationError(`${JSON.stringify(u?.id)} is not an id of "${table}"`);
        if (typeof u.patch !== "object" || u.patch === null) throw new ValidationError("patch must be an object");
        const old = current.get(u.id);
        if (!old) throw new ValidationError(`Document ${u.id} not found`);
        const { _id, _creationTime, ...rest } = old;
        const { fields, json } = this.checked(table, { ...rest, ...u.patch });
        current.set(u.id, { _id, _creationTime, ...fields }); // a later update of the same document applies on top of this one
        if (stored.get(u.id) === json) return; // nothing changed: no statement, no topics
        stored.set(u.id, json);
        writes.push({ id: u.id, old, fields, json });
      } catch (e) {
        if (!(e instanceof ValidationError)) throw e;
        errors.push({ index, message: e.message });
      }
    });
    if (mode === "all" && errors.length) throw new ValidationError(`updateMany() on "${table}": ${errors.length} of ${updates.length} updates are invalid, so none was applied. Update ${errors[0]!.index}: ${errors[0]!.message}`);
    if (this.mongo) {
      const last = new Map(writes.map((w) => [w.id, w]));
      const rows = [...last.values()].map((w) => ({ _id: w.id, doc: w.fields, search: this.searchWordsOf(table, w.fields) }));
      for (let i = 0; i < rows.length; i += 2000) await this.mongo.replace(table, rows.slice(i, i + 2000));
    } else if (this.dialect.bulkUpdate && writes.length > 1) {
      // One statement for all of them. A document updated twice in this call is written once, as the last update left it.
      const last = new Map(writes.map((w) => [w.id, w.json]));
      const rows = [...last].map(([id, json]) => ({ id, json }));
      for (let i = 0; i < rows.length; i += 2000) {
        const q = this.dialect.bulkUpdate(table, rows.slice(i, i + 2000));
        await this.tx.execute(q.sql, q.params);
      }
    }
    if (this.nat) {
      const nat = this.nat;
      for (const w of writes) this.n("UPDATE", table, () => nat.engine.replace(nat.id, w.id, w.json));
      return mode === "all" ? null : { errors };
    }
    for (const w of writes) {
      if (!this.mongo && !(this.dialect.bulkUpdate && writes.length > 1)) await this.tx.execute(`UPDATE "${table}" SET "doc" = ${this.dialect.jsonParam} WHERE "_id" = ?`, [w.json, w.id]);
      await this.syncSearch(table, w.id, w.fields);
      this.written(table, { ...w.fields, _id: w.id }, w.old);
    }
    return mode === "all" ? null : { errors };
  }

  private async update(id: string, next: (old: Doc) => Record<string, unknown>) {
    const table = this.parseId(id);
    if (this.nat) {
      // The engine reads the stored fields, this validates the merge, the engine writes it (and keeps the topics, the search tables and the cache).
      const nat = this.nat;
      const stored = this.n("SELECT", table, () => nat.engine.getRaw(nat.id, id));
      if (stored === null) throw new ValidationError(`Document ${id} not found`);
      const { fields, json } = this.checked(table, next({ _id: id, _creationTime: 0, ...JSON.parse(stored) } as Doc));
      if (stored === json) return; // stored as it is already: nothing to write, nothing for subscribers to re-run
      this.n("UPDATE", table, () => nat.engine.replace(nat.id, id, json, stored));
      return;
    }
    const [row] = this.mongo ? await this.mongo.find(table, { filter: { _id: id }, limit: 1 }) : await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    if (!row) throw new ValidationError(`Document ${id} not found`);
    const old = this.toDoc(row);
    const { fields, json } = this.checked(table, next(old));
    if (row.doc === json || (this.mongo && JSON.stringify(row.doc) === json)) return; // stored as it is already: nothing to write, nothing for subscribers to re-run
    if (this.mongo) await this.mongo.replace(table, [{ _id: id, doc: fields, search: this.searchWordsOf(table, fields) }]);
    else await this.tx.execute(`UPDATE "${table}" SET "doc" = ${this.dialect.jsonParam} WHERE "_id" = ?`, [json, id]);
    await this.syncSearch(table, id, fields);
    this.written(table, { ...fields, _id: id }, old);
  }

  patch(id: string, value: Record<string, unknown>) {
    return this.update(id, ({ _id, _creationTime, ...old }) => ({ ...old, ...value }));
  }

  replace(id: string, value: Record<string, unknown>) {
    return this.update(id, () => value);
  }

  async delete(id: string) {
    const table = this.parseId(id);
    if (!this.writes) throw new Error("Database is read-only in queries");
    if (this.nat) {
      const nat = this.nat;
      this.n("DELETE", table, () => nat.engine.delete(nat.id, id));
      return;
    }
    const [row] = this.mongo ? await this.mongo.find(table, { filter: { _id: id }, limit: 1 }) : await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    if (!row) return;
    if (this.mongo) await this.mongo.delete(table, id);
    else await this.tx.execute(`DELETE FROM "${table}" WHERE "_id" = ?`, [id]);
    await this.syncSearch(table, id, undefined);
    this.written(table, this.toDoc(row));
  }

  /** Empties a table and its search indexes, for a restore that is about to write the table again. */
  async truncate(table: string) {
    if (!this.writes) throw new Error("Database is read-only in queries");
    const t = this.table(table);
    if (this.mongo) {
      await this.mongo.clear(table);
      this.written(table, { _id: "" });
      return;
    }
    await this.tx.execute(`DELETE FROM "${table}"`);
    // Postgres searches a GIN index over the table itself; SQLite keeps an FTS table next to it.
    if (this.dialect.name === "sqlite") for (const index of Object.keys(t.searchIndexes ?? {})) await this.tx.execute(`DELETE FROM "${ftsTable(table, index)}"`);
    this.written(table, { _id: "" });
  }

  /** Inserts a document with a known id and creation time (imports). Validated like any write. */
  async restore(table: string, _id: string, _creationTime: number, value: Record<string, unknown>) {
    if (tableOf(_id) !== table) throw new ValidationError(`Id ${_id} doesn't belong to table "${table}"`);
    const { fields, json } = this.checked(table, value);
    if (this.mongo) await this.mongo.insert(table, [{ _id, _creationTime, doc: fields, ...this.searchWordsOf(table, fields) }]);
    else await this.tx.execute(`INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES (?, ?, ${this.dialect.jsonParam})`, [_id, _creationTime, json]);
    await this.syncSearch(table, _id, fields);
    this.written(table, { ...fields, _id });
  }
}
