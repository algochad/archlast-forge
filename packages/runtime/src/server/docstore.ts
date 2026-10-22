import { tableOf, validateFields, ValidationError, type Validator } from "../values";
import type { DbTx, Dialect } from "./db/types";

export type TablesSpec = Record<string, { fields: Record<string, Validator>; indexes: Record<string, readonly string[]>; strict: boolean }>;

type Doc = Record<string, any> & { _id: string; _creationTime: number };

/** Reactivity topics: `todos`, `todos:by_list:["lists:…"]`, `todos:by_id:["todos:…"]`. */
export const topic = (table: string, index: string, values: unknown[]) => `${table}:${index}:${JSON.stringify(values)}`;

const SELECT = `SELECT "_id", "_creationTime", "doc" FROM`;

export class DocStore {
  constructor(
    private tx: DbTx,
    private dialect: Dialect,
    private tables: TablesSpec,
    /** Topics this transaction read. */
    readonly reads = new Set<string>(),
    /** Topics this transaction wrote; absent in read-only transactions. */
    readonly writes?: Set<string>,
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

  async get(id: string): Promise<Doc | null> {
    const table = this.parseId(id);
    this.reads.add(topic(table, "by_id", [id]));
    const [row] = await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    return row ? this.toDoc(row) : null;
  }

  query(table: string) {
    const t = this.table(table);
    let index: string | undefined;
    const eqs: [string, unknown][] = [];
    const run = async (limit?: number) => {
      let where = "";
      let params: unknown[] = [];
      let order = `"_creationTime", "_id"`;
      if (index !== undefined) {
        const fields = t.indexes[index];
        if (!fields) throw new ValidationError(`Unknown index "${table}.${index}"`);
        eqs.forEach(([f], i) => {
          if (fields[i] !== f) throw new ValidationError(`Index "${table}.${index}" field ${i} is "${fields[i]}", not "${f}"`);
        });
        const conds = eqs.map(([f, value]) => this.dialect.fieldEquals(f, value));
        if (conds.length) where = `WHERE ${conds.map((c) => c.sql).join(" AND ")}`;
        params = conds.flatMap((c) => c.params);
        order = [...fields.slice(eqs.length).map((f) => this.dialect.field(f)), order].join(", ");
      }
      this.reads.add(eqs.length ? topic(table, index!, eqs.map(([, value]) => value)) : table);
      const rows = await this.tx.query(`${SELECT} "${table}" ${where} ORDER BY ${order}${limit === undefined ? "" : ` LIMIT ${limit}`}`, params);
      return rows.map((r) => this.toDoc(r));
    };
    const q = {
      collect: () => run(),
      first: async () => (await run(1))[0] ?? null,
      take: (n: number) => {
        if (!Number.isInteger(n) || n < 0) throw new ValidationError(`take() expects a non-negative integer, got ${n}`);
        return run(n);
      },
    };
    return {
      ...q,
      withIndex(name: string, range?: (b: any) => unknown) {
        index = name;
        const builder = {
          eq(f: string, value: unknown) {
            eqs.push([f, value]);
            return builder;
          },
        };
        range?.(builder);
        return q;
      },
    };
  }

  private written(table: string, doc: Record<string, unknown>) {
    const w = this.writes!;
    w.add(table);
    w.add(topic(table, "by_id", [doc._id]));
    for (const [name, fields] of Object.entries(this.table(table).indexes))
      for (let k = 1; k <= fields.length; k++) w.add(topic(table, name, fields.slice(0, k).map((f) => doc[f])));
  }

  private checked(table: string, value: Record<string, unknown>) {
    if (!this.writes) throw new Error("Database is read-only in queries");
    const t = this.table(table);
    const { _id, _creationTime, ...rest } = value ?? {};
    const fields = Object.fromEntries(Object.entries(t.strict ? (value ?? {}) : rest).filter(([, x]) => x !== undefined));
    if (t.strict) validateFields(t.fields, fields, table);
    return fields;
  }

  async insert(table: string, value: Record<string, unknown>): Promise<string> {
    const fields = this.checked(table, value);
    const _id = `${table}:${crypto.randomUUID().replaceAll("-", "")}`;
    // Fractional ms keeps insertion order within one process.
    const _creationTime = performance.timeOrigin + performance.now();
    await this.tx.execute(`INSERT INTO "${table}" ("_id", "_creationTime", "doc") VALUES (?, ?, ${this.dialect.jsonParam})`, [
      _id,
      _creationTime,
      JSON.stringify(fields),
    ]);
    this.written(table, { ...fields, _id });
    return _id;
  }

  private async update(id: string, next: (old: Doc) => Record<string, unknown>) {
    const table = this.parseId(id);
    const [row] = await this.tx.query(`${SELECT} "${table}" WHERE "_id" = ?`, [id]);
    if (!row) throw new ValidationError(`Document ${id} not found`);
    const old = this.toDoc(row);
    const fields = this.checked(table, next(old));
    await this.tx.execute(`UPDATE "${table}" SET "doc" = ${this.dialect.jsonParam} WHERE "_id" = ?`, [JSON.stringify(fields), id]);
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
    this.written(table, this.toDoc(row));
  }
}
