import { referenceOf } from "../relations";
import type { Row } from "./db/types";
import { SnapshotMoved, type ReadCache } from "./read-cache";
import { tableOf, validateFields, ValidationError, type Validator } from "../values";
import type { DbTx, Dialect } from "./db/types";
import { ftsTable } from "./db/migrate";

export type TablesSpec = Record<
  string,
  {
    fields: Record<string, Validator>;
    indexes: Record<string, readonly string[]>;
    searchIndexes?: Record<string, { searchField: string; filterFields: readonly string[] }>;
    strict: boolean;
  }
>;

type Doc = Record<string, any> & { _id: string; _creationTime: number };

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
const MAX_SCAN = 100_000;
/** Ids per `IN (…)` and parents per `OR` chain, to keep statements a sane size. */
const IN_CHUNK = 500;
const OR_CHUNK = 100;

type Bound = { op: ">" | ">=" | "<" | "<="; value: unknown };
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
    private tables: TablesSpec,
    /** Topics this transaction read. */
    readonly reads = new Set<string>(),
    /** Topics this transaction wrote; absent in read-only transactions. */
    readonly writes?: Set<string>,
    private maxDocumentBytes = 1024 * 1024,
    private cache?: ReadCache,
  ) {
    this.stamp = cache?.now() ?? 0;
  }

  /** This transaction's snapshot on the read cache's counter; whether it used cached rows or the database yet; whether it has written. */
  private stamp: number;
  private usedCache = false;
  private usedDb = false;
  private dirty = false;
  /** Tables this transaction marked pending in the read cache; the executor settles them once it commits or rolls back. */
  readonly writing = new Set<string>();

  /** A read of `table` that reads `topics`: from the read cache when it has the rows as of this transaction's snapshot, else from the database. */
  private async select(table: string, sql: string, params: unknown[], topics: string[]): Promise<Row[]> {
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

  reader() {
    return {
      get: this.get.bind(this),
      getMany: this.getMany.bind(this),
      query: this.query.bind(this),
      include: async (table: string, docs: Doc | Doc[] | null, spec: IncludeSpec) => {
        if (docs == null) return null;
        if (Array.isArray(docs)) return this.join(table, docs, spec);
        return (await this.join(table, [docs], spec))[0];
      },
    };
  }

  writer() {
    return {
      ...this.reader(),
      insert: this.insert.bind(this),
      patch: this.patch.bind(this),
      replace: this.replace.bind(this),
      delete: this.delete.bind(this),
    };
  }

  private table(name: string) {
    const t = this.tables[name];
    if (!t) throw new ValidationError(`Unknown table "${name}"`);
    return t;
  }

  private toDoc(row: any): Doc {
    const fields = typeof row.doc === "string" ? JSON.parse(row.doc) : row.doc;
    return { _id: row._id, _creationTime: row._creationTime, ...fields };
  }

  private parseId(id: unknown) {
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

  async get(id: string): Promise<Doc | null> {
    const table = this.parseId(id);
    const read = topic(table, "by_id", [id]);
    this.reads.add(read);
    const [row] = await this.select(table, `${SELECT} "${table}" WHERE "_id" = ?`, [id], [read]);
    return row ? this.toDoc(row) : null;
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
    /** filter() and include() in the order they were called: a filter sees what was included before it. */
    const steps: ({ filter: (doc: Doc) => boolean } | { include: IncludeSpec })[] = [];

    const indexFields = () => {
      if (index === undefined || index === "by_creation_time") return ["_creationTime"];
      const fields = t.indexes[index];
      if (!fields) throw new ValidationError(`Unknown index "${table}.${index}"`);
      return [...fields];
    };

    /** The SQL for the index range, after `after` (the order key of the last document already seen). Also records what the query reads. */
    const plan = (after?: unknown[]) => {
      const fields = indexFields();
      eqs.forEach(([f], i) => {
        if (fields[i] !== f) throw new ValidationError(`Index "${table}.${index}" field ${i} is "${fields[i]}", not "${f}"`);
      });
      if (boundField !== undefined && fields[eqs.length] !== boundField)
        throw new ValidationError(`Index "${table}.${index}": a range must be on "${fields[eqs.length]}", the field after the equalities`);
      const conds: { sql: string; params: unknown[] }[] = eqs.map(([f, value]) =>
        f === "_creationTime" ? { sql: `"_creationTime" = ?`, params: [value] } : this.dialect.fieldEquals(f, value),
      );
      for (const b of bounds) {
        const c = this.col(boundField!);
        conds.push({ sql: `${c.expr} ${b.op} ${c.param}`, params: [c.encode(b.value)] });
      }
      // Order key: the index fields after the equalities, then _creationTime and _id (unique).
      const keyFields = [...fields.slice(eqs.length).filter((f) => f !== "_creationTime"), "_creationTime", "_id"];
      const key = keyFields.map((f) => this.col(f));
      if (after) {
        const op = order === "asc" ? ">" : "<";
        conds.push({ sql: `(${key.map((k) => k.expr).join(", ")}) ${op} (${key.map((k) => k.param).join(", ")})`, params: key.map((k, i) => k.encode(after[i])) });
      }
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
      return {
        read,
        where: conds.length ? `WHERE ${conds.map((c) => c.sql).join(" AND ")}` : "",
        params: conds.flatMap((c) => c.params),
        orderBy: key.map((k) => `${k.expr}${order === "desc" ? " DESC" : ""}`).join(", "),
        keyFields,
      };
    };

    const run = async (limit?: number, after?: unknown[], skip = 0) => {
      const p = plan(after);
      // SQLite needs a LIMIT before an OFFSET; Postgres takes any bigint.
      const page = skip ? ` LIMIT ${limit ?? Number.MAX_SAFE_INTEGER} OFFSET ${skip}` : limit === undefined ? "" : ` LIMIT ${limit}`;
      const rows = await this.select(table, `${SELECT} "${table}" ${p.where} ORDER BY ${p.orderBy}${page}`, p.params, [p.read]);
      return { docs: rows.map((r) => this.toDoc(r)), keyFields: p.keyFields };
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
    const finish = (docs: Doc[]) => apply(docs, steps.slice(lastFilter() + 1));

    /** Up to `want` documents after `after` that pass the filters, past the first `skip` of them, scanning the range in batches. */
    const matches = async (want: number, after?: unknown[], skip = offset) => {
      const out: Doc[] = [];
      let keyFields: string[] = [];
      if (!hasFilter()) {
        const r = await run(Number.isFinite(want) ? want : undefined, after, skip); // the database skips them: never loaded
        return { docs: r.docs, keyFields: r.keyFields };
      }
      let seen = 0;
      for (let cursor = after; ;) {
        const batch = await run(SCAN_BATCH, cursor);
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
        if (batch.docs.length < SCAN_BATCH) return { docs: out, keyFields };
        if (seen >= MAX_SCAN) throw new ValidationError(`filter() scanned ${MAX_SCAN} documents of "${table}" without finishing; narrow the range with withIndex()`);
        cursor = keyOf(keyFields, batch.docs.at(-1)!);
      }
    };

    /** Every matching document, a batch at a time, for aggregates. */
    const each = async (visit: (doc: Doc) => void) => {
      let cursor: unknown[] | undefined;
      let seen = 0;
      let skip = offset;
      for (;;) {
        const batch = await run(SCAN_BATCH * 4, cursor);
        for (const d of await scanned(batch.docs)) {
          if (skip > 0) skip--;
          else visit(d);
        }
        seen += batch.docs.length;
        if (batch.docs.length < SCAN_BATCH * 4) return;
        if (seen >= MAX_SCAN) throw new ValidationError(`Aggregates scan at most ${MAX_SCAN} documents of "${table}"; narrow the range with withIndex()`);
        cursor = keyOf(batch.keyFields, batch.docs.at(-1)!);
      }
    };

    const numbers = async (name: string, field: string) => {
      const v = t.fields[field];
      if (field !== "_creationTime" && t.strict && v?.kind !== "number") throw new ValidationError(`${name}() needs a number field; "${table}.${field}" isn't one`);
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
      /** Adds related documents to each result; see `IncludeSpec`. */
      include: (spec: IncludeSpec) => {
        this.checkInclude(table, spec);
        steps.push({ include: spec });
        return q;
      },
      collect: async () => finish((await matches(Infinity)).docs),
      first: async () => (await finish((await matches(1)).docs))[0] ?? null,
      unique: async () => {
        const { docs } = await matches(2);
        if (docs.length > 1) throw new ValidationError(`unique() found more than one document in "${table}"`);
        return (await finish(docs))[0] ?? null;
      },
      take: async (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return finish((await matches(n)).docs);
      },
      count: async () => {
        if (hasFilter()) {
          let n = 0;
          await each(() => n++);
          return n;
        }
        const p = plan();
        const [row] = await this.select(table, `SELECT COUNT(*) AS "n" FROM "${table}" ${p.where}`, p.params, [p.read]);
        return Math.max(0, Number(row?.n ?? 0) - offset);
      },
      sum: async (field: string) => (await numbers("sum", field)).reduce((a, b) => a + b, 0),
      avg: async (field: string) => {
        const xs = await numbers("avg", field);
        return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
      },
      min: async (field: string) => {
        const xs = await numbers("min", field);
        return xs.length ? xs.reduce((a, b) => Math.min(a, b)) : null;
      },
      max: async (field: string) => {
        const xs = await numbers("max", field);
        return xs.length ? xs.reduce((a, b) => Math.max(a, b)) : null;
      },
      paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => {
        if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_PAGE) throw new ValidationError(`paginate() numItems must be an integer from 1 to ${MAX_PAGE}`);
        const keyLength =
          indexFields()
            .slice(eqs.length)
            .filter((f) => f !== "_creationTime").length + 2;
        const after = cursor === null ? undefined : decodeCursor(cursor, keyLength);
        // skip() places the first page; a cursor already says where the next one starts.
        const { docs, keyFields } = await matches(numItems + 1, after, after ? 0 : offset);
        const page = docs.slice(0, numItems);
        const last = page.at(-1);
        return {
          page: await finish(page),
          isDone: docs.length <= numItems,
          continueCursor: last ? encodeCursor(keyOf(keyFields, last)) : (cursor ?? encodeCursor([])),
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
    const byTable = new Map<string, Set<string>>();
    for (const id of ids) {
      const table = this.parseId(id);
      if (!byTable.has(table)) byTable.set(table, new Set());
      byTable.get(table)!.add(id);
    }
    const found = new Map<string, Doc>();
    for (const [table, set] of byTable) {
      const unique = [...set];
      for (const id of unique) this.reads.add(topic(table, "by_id", [id]));
      for (let i = 0; i < unique.length; i += IN_CHUNK) {
        const chunk = unique.slice(i, i + IN_CHUNK);
        const topics = chunk.map((id) => topic(table, "by_id", [id]));
        for (const row of await this.select(table, `${SELECT} "${table}" WHERE "_id" IN (${chunk.map(() => "?").join(", ")})`, chunk, topics)) found.set(row._id, this.toDoc(row));
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
    const perParent = (id: string) => {
      const q = this.query(rule.table)
        .withIndex(rule.index, (b: any) => b.eq(field, id))
        .order(order);
      return q;
    };
    if (rule.count) {
      // Counts are cached per parent (a write to one parent's children drops only that parent's count); the ones the cache doesn't have
      // come from one grouped query per chunk. A parent with no children isn't in that result and counts 0.
      const counts = new Map<string, number>();
      const countKey = (id: string) => `count\u0000${rule.table}\u0000${field}\u0000${id}`;
      const missing: string[] = [];
      for (const id of new Set(docs.map((d) => d._id))) {
        this.reads.add(topic(rule.table, rule.index, [id])); // what perParent(id).count() would have read
        const hit = this.peek(rule.table, countKey(id));
        if (hit) counts.set(id, hit[0]!.n);
        else missing.push(id);
      }
      // One count per parent, as scalar subqueries in one statement: each is answered from the index alone, where a GROUP BY on the
      // field would have to read every child row to evaluate it (2x slower at a few hundred children each).
      for (let i = 0; i < missing.length; i += OR_CHUNK) {
        const chunk = missing.slice(i, i + OR_CHUNK);
        const conds = chunk.map((id) => this.dialect.fieldEquals(field, id));
        this.toDb();
        const rows = await this.tx.query(
          chunk.map((_, k) => `SELECT ${k} AS "k", (SELECT COUNT(*) FROM "${rule.table}" WHERE ${conds[k]!.sql}) AS "n"`).join(" UNION ALL "),
          conds.flatMap((c) => c.params),
        );
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
    if (rule.take !== undefined) {
      // A limit per parent needs a query per parent.
      for (const d of docs) {
        const q = perParent(d._id);
        if (rule.include) q.include(rule.include);
        d[key] = await q.take(rule.take);
      }
      return;
    }
    // Everything at once: one query for a chunk of parents, grouped afterwards.
    const rest = [...(child.indexes[rule.index] ?? []).slice(1).filter((f) => f !== "_creationTime"), "_creationTime", "_id"].map((f) => this.col(f));
    const groups = new Map<string, Doc[]>(docs.map((d) => [d._id, []]));
    const ids = [...groups.keys()];
    for (let i = 0; i < ids.length; i += OR_CHUNK) {
      const chunk = ids.slice(i, i + OR_CHUNK);
      const topics = chunk.map((id) => topic(rule.table, rule.index, [id]));
      for (const t of topics) this.reads.add(t);
      const conds = chunk.map((id) => this.dialect.fieldEquals(field, id));
      const orderBy = rest.map((k) => `${k.expr}${order === "desc" ? " DESC" : ""}`).join(", ");
      const rows = await this.select(
        rule.table,
        `${SELECT} "${rule.table}" WHERE (${conds.map((c) => c.sql).join(" OR ")}) ORDER BY ${orderBy}`,
        conds.flatMap((c) => c.params),
        topics,
      );
      for (const row of rows) {
        const doc = this.toDoc(row);
        groups.get(doc[field])?.push(doc);
      }
    }
    const all = rule.include ? await this.join(rule.table, [...groups.values()].flat(), rule.include) : [...groups.values()].flat();
    const joined = new Map(all.map((c) => [c._id, c]));
    for (const d of docs) d[key] = groups.get(d._id)!.map((c) => joined.get(c._id)!);
  }

  private written(table: string, doc: Record<string, unknown>) {
    const w = this.writes!;
    // From here this transaction reads its own uncommitted writes, so only from the database; and nobody may use the table until it settles.
    this.dirty = true;
    if (this.cache && !this.writing.has(table)) {
      this.writing.add(table);
      this.cache.writing(table);
    }
    w.add(table);
    w.add(topic(table, "by_id", [doc._id]));
    for (const [name, fields] of Object.entries(this.table(table).indexes))
      for (let k = 1; k <= fields.length; k++)
        w.add(
          topic(
            table,
            name,
            fields.slice(0, k).map((f) => doc[f]),
          ),
        );
  }

  private async syncSearch(table: string, id: string, doc: Record<string, unknown> | undefined) {
    for (const [name, { searchField }] of Object.entries(this.table(table).searchIndexes ?? {})) {
      const text = typeof doc?.[searchField] === "string" ? (doc[searchField] as string) : undefined;
      for (const s of this.dialect.searchWrite(table, name, id, text)) await this.tx.execute(s.sql, s.params);
    }
  }

  private checked(table: string, value: Record<string, unknown>) {
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
    const _id = `${table}:${crypto.randomUUID().replaceAll("-", "")}`;
    // Fractional ms keeps insertion order within one process.
    const _creationTime = performance.timeOrigin + performance.now();
    await this.tx.execute(`INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES (?, ?, ${this.dialect.jsonParam})`, [_id, _creationTime, json]);
    await this.syncSearch(table, _id, fields);
    this.written(table, { ...fields, _id });
    return _id;
  }

  private async update(id: string, next: (old: Doc) => Record<string, unknown>) {
    const table = this.parseId(id);
    const [row] = await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    if (!row) throw new ValidationError(`Document ${id} not found`);
    const old = this.toDoc(row);
    const { fields, json } = this.checked(table, next(old));
    await this.tx.execute(`UPDATE "${table}" SET "doc" = ${this.dialect.jsonParam} WHERE "_id" = ?`, [json, id]);
    await this.syncSearch(table, id, fields);
    this.written(table, old);
    this.written(table, { ...fields, _id: id });
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
    const [row] = await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    if (!row) return;
    await this.tx.execute(`DELETE FROM "${table}" WHERE "_id" = ?`, [id]);
    await this.syncSearch(table, id, undefined);
    this.written(table, this.toDoc(row));
  }

  /** Empties a table and its search indexes, for a restore that is about to write the table again. */
  async truncate(table: string) {
    if (!this.writes) throw new Error("Database is read-only in queries");
    const t = this.table(table);
    await this.tx.execute(`DELETE FROM "${table}"`);
    // Postgres searches a GIN index over the table itself; SQLite keeps an FTS table next to it.
    if (this.dialect.name === "sqlite") for (const index of Object.keys(t.searchIndexes ?? {})) await this.tx.execute(`DELETE FROM "${ftsTable(table, index)}"`);
    this.written(table, { _id: "" });
  }

  /** Inserts a document with a known id and creation time (imports). Validated like any write. */
  async restore(table: string, _id: string, _creationTime: number, value: Record<string, unknown>) {
    if (tableOf(_id) !== table) throw new ValidationError(`Id ${_id} doesn't belong to table "${table}"`);
    const { fields, json } = this.checked(table, value);
    await this.tx.execute(`INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES (?, ?, ${this.dialect.jsonParam})`, [_id, _creationTime, json]);
    await this.syncSearch(table, _id, fields);
    this.written(table, { ...fields, _id });
  }
}
