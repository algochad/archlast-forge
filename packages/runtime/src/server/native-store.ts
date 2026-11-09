// The document store on the native engine. A query here is only a description, kept as the chain is written (`query("t").withIndex("by", (q) => q.eq("f", v)).take(5)`);
// the terminal sends it to the engine in one call, and the engine plans it, finds it in its cache or runs it, and answers with the documents as JSON text. Nothing is
// planned, cached or looked up in JavaScript. What the engine does not run yet (a JavaScript filter(), include(), aggregates, pagination, search) is handed to the
// DocStore underneath, which does it with the engine's primitives, by replaying the chain onto it.
import { DocStore, isPredicate, MAX_SCAN, orUndef, searchTerms, type Doc, type IncludeSpec, type Predicate } from "./docstore";
import { ValidationError, tableOf } from "../values";
import { NeedsJs } from "./db/native";

type Bound = { op: ">" | ">=" | "<" | "<="; value: unknown };

/** The `q` of `withIndex("name", (q) => q.eq("a", 1).gt("b", 2))`. */
class Range {
  constructor(private readonly query: NativeQuery) {}
  eq(f: string, value: unknown) {
    if (this.query.bounds.length) throw new ValidationError("eq() must come before range bounds");
    this.query.eqs.push([f, value]);
    return this;
  }
  gt(f: string, value: unknown) {
    return this.bound(">", f, value);
  }
  gte(f: string, value: unknown) {
    return this.bound(">=", f, value);
  }
  lt(f: string, value: unknown) {
    return this.bound("<", f, value);
  }
  lte(f: string, value: unknown) {
    return this.bound("<=", f, value);
  }
  private bound(op: Bound["op"], f: string, value: unknown) {
    const q = this.query;
    if (q.boundField !== undefined && q.boundField !== f) throw new ValidationError("Lower and upper bounds must be on the same field");
    if (q.bounds.some((b) => b.op[0] === op[0])) throw new ValidationError(`Only one ${op[0] === ">" ? "lower" : "upper"} bound is allowed`);
    q.boundField = f;
    q.bounds.push({ op, value });
    return this;
  }
}

export class NativeQuery {
  index?: string;
  rangeFn?: (b: any) => unknown;
  eqs: [string, unknown][] = [];
  bounds: Bound[] = [];
  boundField?: string;
  private wheres: unknown[] = [];
  private whereFns: ((b: any) => unknown)[] = [];
  private orderKeys?: { f: string; desc: boolean }[];
  private orderKeysGiven?: unknown;
  private projection?: string[];
  private projectionGiven?: unknown;
  private includes: unknown[] = [];
  private includeGiven: IncludeSpec[] = [];
  private descending = false;
  private offset = 0;

  constructor(
    private readonly store: NativeStore,
    readonly table: string,
  ) {}

  // ---- the chain ----

  /** `withIndex`, which only the query `ctx.db` hands out has (see `root`): the chain after it is a query without it, as on the bun layer. */
  #withIndex(name: string, range?: (b: any) => unknown) {
    this.index = name;
    this.#fields(); // fail fast on unknown indexes
    if (range) {
      this.rangeFn = range;
      range(new Range(this));
    }
    return this;
  }

  /** What `ctx.db.query(table)` returns: `withIndex` and `withSearchIndex` beside the chain, and the chain's own methods, which answer the query without them (the bun layer's shape). */
  static root(store: NativeStore, table: string) {
    const q = new NativeQuery(store, table);
    const root: Record<string, unknown> = {};
    for (const name of Object.getOwnPropertyNames(NativeQuery.prototype)) if (name !== "constructor") root[name] = (...args: unknown[]) => (q as any)[name](...args);
    root.withIndex = (name: string, range?: (b: any) => unknown) => q.#withIndex(name, range);
    root.withSearchIndex = (name: string, filter: (b: any) => unknown) => new NativeSearch(store, table, name, filter);
    return root;
  }

  order(o: "asc" | "desc") {
    if (o !== "asc" && o !== "desc") throw new ValidationError(`order() expects "asc" or "desc"`);
    this.descending = o === "desc";
    return this;
  }

  skip(n: number) {
    if (!Number.isInteger(n) || n < 0) throw new ValidationError(`skip() expects a non-negative integer, got ${n}`);
    if (this.offset + n > MAX_SCAN) throw new ValidationError(`skip() passes over at most ${MAX_SCAN} documents, got ${this.offset + n}; go further with paginate()`);
    this.offset += n;
    return this;
  }

  where(build: (b: any) => unknown) {
    if (typeof build !== "function") throw new ValidationError('where() expects a function: where((q) => q.eq("done", false))');
    const p = build(this.store.predicatesOf(this.table));
    if (!isPredicate(p)) throw new ValidationError("where()'s function must return a predicate from its builder (q.eq, q.and, …)");
    this.wheres.push((p as Predicate).ast);
    this.whereFns.push(build);
    return this;
  }

  orderBy(keys: unknown) {
    if (!Array.isArray(keys) || !keys.length) throw new ValidationError('orderBy() expects [field, "asc" | "desc"] pairs: orderBy([["dueDate", "asc"], ["priority", "desc"]])');
    this.orderKeys = keys.map((k) => {
      if (!Array.isArray(k) || (k[1] !== "asc" && k[1] !== "desc")) throw new ValidationError(`orderBy() expects [field, "asc" | "desc"] pairs, got ${JSON.stringify(k)}`);
      return { f: this.store.fieldOf(this.table, k[0], "orderBy"), desc: k[1] === "desc" };
    });
    this.orderKeysGiven = keys;
    return this;
  }

  select(fields: unknown) {
    if (!Array.isArray(fields) || !fields.length) throw new ValidationError('select() expects field names: select(["title", "done"])');
    this.projection = fields.map((f) => this.store.fieldOf(this.table, f, "select"));
    this.projectionGiven = fields;
    return this;
  }

  /** Adds related documents to each result; see `IncludeSpec`. */
  include(spec: IncludeSpec) {
    this.includes.push(...this.store.includePlan(this.table, spec));
    this.includeGiven.push(spec);
    return this;
  }

  // ---- what the engine does not run: a filter() is JavaScript, so the DocStore underneath scans the range with it, from the chain so far ----

  #legacy() {
    let q: any = this.store.legacyQuery(this.table);
    if (this.index !== undefined) q = q.withIndex(this.index, this.rangeFn);
    if (this.descending) q.order("desc");
    if (this.offset) q.skip(this.offset);
    for (const fn of this.whereFns) q.where(fn);
    if (this.orderKeysGiven) q.orderBy(this.orderKeysGiven);
    if (this.projectionGiven) q.select(this.projectionGiven);
    for (const spec of this.includeGiven) q.include(spec);
    return q;
  }
  filter(predicate: (doc: Doc) => boolean) {
    return this.#legacy().filter(predicate);
  }

  // ---- pages and aggregates: the engine ----

  async paginate({ numItems, cursor, offset: extra = 0, withTotal }: { numItems: number; cursor: string | null; offset?: number; withTotal?: boolean }) {
    if (!Number.isInteger(numItems) || numItems < 1 || numItems > 8192) throw new ValidationError(`paginate() numItems must be an integer from 1 to 8192`);
    if (!Number.isInteger(extra) || extra < 0) throw new ValidationError(`paginate() offset must be a non-negative integer, got ${extra}`);
    const d = this.#describe(undefined, this.offset);
    return JSON.parse(this.store.paginateOf(this.table, d, numItems, cursor, extra, withTotal === true));
  }
  async #aggregate(kind: "sum" | "avg" | "min" | "max", field: string) {
    const t = this.store.specOf(this.table);
    const v = t.fields[field];
    if (field !== "_creationTime" && t.strict && v?.kind !== "number") throw new ValidationError(`${kind}() needs a number field; "${this.table}.${field}" isn't one`);
    return JSON.parse(this.store.aggregateOf(this.table, this.#describe(undefined, this.offset), kind, field));
  }
  sum(field: string) {
    return this.#aggregate("sum", field);
  }
  avg(field: string) {
    return this.#aggregate("avg", field);
  }
  min(field: string) {
    return this.#aggregate("min", field);
  }
  max(field: string) {
    return this.#aggregate("max", field);
  }

  // ---- the terminals: one call to the engine ----

  #fields() {
    return this.store.indexFieldsOf(this.table, this.index);
  }

  /** The description the engine takes. */
  #describe(limit?: number, skip = this.offset) {
    const fields = this.#fields();
    const t = this.table;
    this.eqs.forEach(([f], i) => {
      if (fields[i] !== f) throw new ValidationError(`Index "${t}.${this.index}" field ${i} is "${fields[i]}", not "${f}"`);
    });
    if (this.boundField !== undefined && fields[this.eqs.length] !== this.boundField)
      throw new ValidationError(`Index "${t}.${this.index}": a range must be on "${fields[this.eqs.length]}", the field after the equalities`);
    return JSON.stringify({
      table: t,
      index: this.index,
      eqs: this.eqs.map(([f, value]) => [f, orUndef(value)]),
      bounds: this.bounds.map((b) => ({ op: b.op, value: orUndef(b.value) })),
      boundField: this.boundField,
      wheres: this.wheres,
      orderKeys: this.orderKeys,
      desc: this.descending,
      limit,
      skip,
      projection: this.projection,
      includes: this.includes.length ? this.includes : undefined,
    });
  }

  async #text(limit?: number): Promise<string> {
    const d = this.#describe(limit);
    return this.store.queryText(this.table, d, this.wheres.length > 0 || this.orderKeys !== undefined, this.includes.length > 0 || this.projection !== undefined);
  }

  async collect() {
    return JSON.parse(await this.#text());
  }
  async first() {
    return JSON.parse(await this.#text(1))[0] ?? null;
  }
  async take(n: number) {
    if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
    return JSON.parse(await this.#text(n));
  }
  async unique() {
    const docs = JSON.parse(await this.#text(2)) as Doc[];
    if (docs.length > 1) throw new ValidationError(`unique() found more than one document in "${this.table}"`);
    return docs[0] ?? null;
  }
  async count() {
    return Math.max(0, this.store.countOf(this.table, this.#describe(undefined, 0)) - this.offset);
  }

  /** collect(), first() and take() as JSON text, for a caller that sends the documents on as they are. */
  async collectJson() {
    return this.#text();
  }
  async firstJson() {
    const text = await this.#text(1);
    return text === "[]" ? "null" : text.slice(1, -1);
  }
  async takeJson(n: number) {
    if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
    return this.#text(n);
  }
}

/** `withSearchIndex("name", (q) => q.search("field", "words").eq("filterField", v))`: the engine matches, ranks and adds related documents. */
class NativeSearch {
  private text?: string;
  private eqs: [string, unknown][] = [];
  private includes: unknown[] = [];

  constructor(
    private readonly store: NativeStore,
    private readonly table: string,
    private readonly name: string,
    filter: (b: any) => unknown,
  ) {
    const config = store.specOf(table).searchIndexes?.[name];
    if (!config) throw new ValidationError(`Unknown search index "${table}.${name}"`);
    const finalizer = {
      eq: (f: string, value: unknown) => {
        if (!config.filterFields.includes(f)) throw new ValidationError(`"${f}" is not a filter field of search index "${table}.${name}"`);
        this.eqs.push([f, value]);
        return finalizer;
      },
    };
    filter({
      search: (f: string, query: string) => {
        if (f !== config.searchField) throw new ValidationError(`Search index "${table}.${name}" searches "${config.searchField}", not "${f}"`);
        if (typeof query !== "string") throw new ValidationError("search() expects a string");
        this.text = query;
        return finalizer;
      },
    });
    if (this.text === undefined) throw new ValidationError("withSearchIndex() needs q.search(field, text)");
  }

  include(spec: IncludeSpec) {
    this.includes.push(...this.store.includePlan(this.table, spec));
    return this;
  }

  #run(limit: number): Promise<Doc[]> {
    const spec = JSON.stringify({ table: this.table, index: this.name, terms: searchTerms(this.text!), filters: this.eqs.map(([f, v]) => [f, orUndef(v)]), limit, includes: this.includes.length ? this.includes : undefined });
    return Promise.resolve(JSON.parse(this.store.searchOf(this.table, spec)));
  }
  take(n: number) {
    if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
    return this.#run(n);
  }
  async first() {
    return (await this.#run(1))[0] ?? null;
  }
  collect() {
    return this.#run(1024);
  }
}

/** A patch's value as JSON: a top-level field set to `undefined` is removed, which JSON cannot say, so it is marked. */
function patchJson(value: Record<string, unknown>): string {
  return JSON.stringify(value, function (this: unknown, _k, x) {
    return x === undefined && this === value ? UNDEF : x;
  });
}
const UNDEF = { $undefined: true };

export class NativeStore extends DocStore {
  // ---- mutations: one call. The engine validates against the schema's validators (given to it as data), writes, indexes and keeps the topics; a write it cannot vouch for
  // goes to the DocStore underneath, whose Zod schemas decide and word the error, and which then writes it as validated.

  override async insert(table: string, value: Record<string, unknown>): Promise<string> {
    const nat = this.nat!;
    try {
      return this.n("INSERT", table, () => nat.engine.insertOne(nat.id, table, JSON.stringify(value ?? {}), this.maxDocumentBytes, false));
    } catch (e) {
      if (!(e instanceof NeedsJs)) throw e;
      return await super.insert(table, value);
    }
  }

  override async insertMany(table: string, values: Record<string, unknown>[], opts?: { mode?: "all" | "partial" }): Promise<any> {
    const mode = opts?.mode ?? "all";
    if (!Array.isArray(values) || (mode !== "all" && mode !== "partial")) return await super.insertMany(table, values, opts);
    const nat = this.nat!;
    try {
      const ids = this.n("INSERT", table, () => nat.engine.insert(nat.id, table, values.map((x) => JSON.stringify(x ?? {})), this.maxDocumentBytes, false));
      return mode === "all" ? ids : { ids, errors: [] };
    } catch (e) {
      if (!(e instanceof NeedsJs)) throw e;
      return await super.insertMany(table, values, opts);
    }
  }

  override async patch(id: string, value: Record<string, unknown>): Promise<void> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return await super.patch(id, value);
    const nat = this.nat!;
    try {
      this.n("UPDATE", tableOf(id), () => nat.engine.change(nat.id, id, patchJson(value), true, this.maxDocumentBytes, false));
    } catch (e) {
      if (!(e instanceof NeedsJs)) throw e;
      return await super.patch(id, value);
    }
  }

  override async replace(id: string, value: Record<string, unknown>): Promise<void> {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return await super.replace(id, value);
    const nat = this.nat!;
    try {
      this.n("UPDATE", tableOf(id), () => nat.engine.change(nat.id, id, JSON.stringify(value), false, this.maxDocumentBytes, false));
    } catch (e) {
      if (!(e instanceof NeedsJs)) throw e;
      return await super.replace(id, value);
    }
  }

  override query(table: string): any {
    this.table(table);
    return NativeQuery.root(this, table);
  }

  /** The DocStore's own builder, for what the engine does not run yet. */
  legacyQuery(table: string): any {
    return DocStore.prototype.query.call(this, table);
  }

  predicatesOf(table: string) {
    return this.predicates(table);
  }

  fieldOf(table: string, f: unknown, method: string) {
    return this.fieldName(table, f, method);
  }

  indexFieldsOf(table: string, index?: string): string[] {
    if (index === undefined || index === "by_creation_time") return ["_creationTime"];
    const fields = this.table(table).indexes[index];
    if (!fields) throw new ValidationError(`Unknown index "${table}.${index}"`);
    return [...fields];
  }

  /** The table as the schema describes it. */
  specOf(table: string) {
    return this.table(table);
  }

  /** The documents of a range as JSON text, from the engine (with related documents and chosen fields, when the chain asked). */
  queryText(table: string, desc: string, needsPlan: boolean, full: boolean): Promise<string> {
    const nat = this.nat!;
    const go = () => this.n("SELECT", table, () => (full ? nat.engine.queryFull(nat.id, table, desc) : nat.engine.query(nat.id, table, desc)));
    if (this.warn && needsPlan) return this.explainNative(table, desc).then(go);
    return Promise.resolve(go());
  }

  paginateOf(table: string, desc: string, numItems: number, cursor: string | null, extra: number, withTotal: boolean): string {
    const nat = this.nat!;
    return this.n("SELECT", table, () => nat.engine.paginate(nat.id, table, desc, numItems, cursor ?? undefined, extra, withTotal));
  }

  aggregateOf(table: string, desc: string, kind: string, field: string): string {
    const nat = this.nat!;
    return this.n("SELECT", table, () => nat.engine.aggregate(nat.id, table, desc, kind, field));
  }

  searchOf(table: string, spec: string): string {
    const nat = this.nat!;
    return this.n("SELECT", table, () => nat.engine.search(nat.id, spec));
  }

  /** Related documents added to documents the caller has (`db.include`). */
  override async join(table: string, docs: Doc[], spec: IncludeSpec): Promise<Doc[]> {
    if (!docs.length) return docs;
    const nat = this.nat!;
    const plan = JSON.stringify(this.includePlan(table, spec));
    return JSON.parse(this.n("SELECT", table, () => nat.engine.join(nat.id, table, JSON.stringify(docs), plan)));
  }

  countOf(table: string, desc: string): number {
    const nat = this.nat!;
    return this.n("SELECT", table, () => nat.engine.count(nat.id, table, desc));
  }

  /** In development: the query-plan warning for a statement the engine makes (the engine says what it is). */
  private async explainNative(table: string, desc: string) {
    const nat = this.nat!;
    const q = JSON.parse(nat.engine.planSql(desc)) as { sql: string; params: unknown[] };
    const d = JSON.parse(desc) as { wheres?: unknown[]; orderKeys?: unknown };
    await this.explain(table, q.sql, q.params, (d.wheres?.length ?? 0) > 0, d.orderKeys !== undefined);
  }
}
