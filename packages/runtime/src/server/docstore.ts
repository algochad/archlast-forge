import { tableOf, validateFields, ValidationError, type Validator } from "../values";
import type { DbTx, Dialect } from "./db/types";

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

/** Reactivity topics: `todos`, `todos:by_list:["lists:…"]`, `todos:by_id:["todos:…"]`. */
export const topic = (table: string, index: string, values: unknown[]) => `${table}:${index}:${JSON.stringify(values)}`;

const SELECT = `SELECT "_id", "_creationTime", "doc" FROM`;
const MAX_PAGE = 8192;
const MAX_SEARCH = 1024;

type Bound = { op: ">" | ">=" | "<" | "<="; value: unknown };

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
  ) {}

  reader() {
    return { get: this.get.bind(this), query: this.query.bind(this) };
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
    return f === "_creationTime" || f === "_id" ? { expr: `"${f}"`, param: "?", encode: (x: unknown) => x } : { expr: this.dialect.field(f), param: this.dialect.valueParam, encode: this.dialect.encode };
  }

  async get(id: string): Promise<Doc | null> {
    const table = this.parseId(id);
    this.reads.add(topic(table, "by_id", [id]));
    const [row] = await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    return row ? this.toDoc(row) : null;
  }

  query(table: string) {
    const t = this.table(table);
    let index: string | undefined;
    let order: "asc" | "desc" = "asc";
    const eqs: [string, unknown][] = [];
    const bounds: Bound[] = [];
    let boundField: string | undefined;

    const indexFields = () => {
      if (index === undefined || index === "by_creation_time") return ["_creationTime"];
      const fields = t.indexes[index];
      if (!fields) throw new ValidationError(`Unknown index "${table}.${index}"`);
      return [...fields];
    };

    const run = async (limit?: number, after?: unknown[]) => {
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
      const key = [...fields.slice(eqs.length).filter((f) => f !== "_creationTime"), "_creationTime", "_id"].map((f) => this.col(f));
      if (after) {
        const op = order === "asc" ? ">" : "<";
        conds.push({ sql: `(${key.map((k) => k.expr).join(", ")}) ${op} (${key.map((k) => k.param).join(", ")})`, params: key.map((k, i) => k.encode(after[i])) });
      }
      // Reads of a range or page are tracked at the equality prefix: coarser, never missed.
      this.reads.add(eqs.length && index !== undefined ? topic(table, index, eqs.map(([, value]) => value)) : table);
      const where = conds.length ? `WHERE ${conds.map((c) => c.sql).join(" AND ")}` : "";
      const orderBy = key.map((k) => `${k.expr}${order === "desc" ? " DESC" : ""}`).join(", ");
      const rows = await this.tx.query(`${SELECT} "${table}" ${where} ORDER BY ${orderBy}${limit === undefined ? "" : ` LIMIT ${limit}`}`, conds.flatMap((c) => c.params));
      return { docs: rows.map((r) => this.toDoc(r)), keyFields: [...fields.slice(eqs.length).filter((f) => f !== "_creationTime"), "_creationTime", "_id"] };
    };

    const q = {
      order(o: "asc" | "desc") {
        if (o !== "asc" && o !== "desc") throw new ValidationError(`order() expects "asc" or "desc"`);
        order = o;
        return q;
      },
      collect: async () => (await run()).docs,
      first: async () => (await run(1)).docs[0] ?? null,
      take: async (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return (await run(n)).docs;
      },
      paginate: async ({ numItems, cursor }: { numItems: number; cursor: string | null }) => {
        if (!Number.isInteger(numItems) || numItems < 1 || numItems > MAX_PAGE)
          throw new ValidationError(`paginate() numItems must be an integer from 1 to ${MAX_PAGE}`);
        const keyLength = indexFields().slice(eqs.length).filter((f) => f !== "_creationTime").length + 2;
        const after = cursor === null ? undefined : decodeCursor(cursor, keyLength);
        const { docs, keyFields } = await run(numItems + 1, after);
        const page = docs.slice(0, numItems);
        const last = page.at(-1);
        return {
          page,
          isDone: docs.length <= numItems,
          continueCursor: last ? encodeCursor(keyFields.map((f) => last[f] ?? null)) : (cursor ?? encodeCursor([])),
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
      return (await this.tx.query(sql, params)).map((r) => this.toDoc(r));
    };
    return {
      take: (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return run(n);
      },
      first: async () => (await run(1))[0] ?? null,
      collect: () => run(MAX_SEARCH),
    };
  }

  private written(table: string, doc: Record<string, unknown>) {
    const w = this.writes!;
    w.add(table);
    w.add(topic(table, "by_id", [doc._id]));
    for (const [name, fields] of Object.entries(this.table(table).indexes))
      for (let k = 1; k <= fields.length; k++) w.add(topic(table, name, fields.slice(0, k).map((f) => doc[f])));
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
    if (json.length > this.maxDocumentBytes)
      throw new ValidationError(`Document in "${table}" is ${json.length} bytes; the limit is ${this.maxDocumentBytes} (MAX_DOCUMENT_BYTES)`);
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

  /** Inserts a document with a known id and creation time (imports). Validated like any write. */
  async restore(table: string, _id: string, _creationTime: number, value: Record<string, unknown>) {
    if (tableOf(_id) !== table) throw new ValidationError(`Id ${_id} doesn't belong to table "${table}"`);
    const { fields, json } = this.checked(table, value);
    await this.tx.execute(`INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES (?, ?, ${this.dialect.jsonParam})`, [_id, _creationTime, json]);
    await this.syncSearch(table, _id, fields);
    this.written(table, { ...fields, _id });
  }
}
