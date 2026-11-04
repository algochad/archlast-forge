// The engine's own tables (the scheduler, dashboard admins and sessions, the audit log, environment, migrations, settings, backups) are written as SQL
// by about ten files, and the scheduler's rows must commit with a mutation's documents. On MongoDB they are collections like the documents, in the
// same transactions, and this module runs the statements those files make: one SELECT / INSERT / UPDATE / DELETE over one table, WHERE a list of
// conditions joined by AND (=, <, <=, >, >=, IN, LIKE 'prefix%'), ORDER BY one column, LIMIT, ON CONFLICT, RETURNING. Anything else throws, so a
// statement written for SQL that MongoDB can't run fails loudly and in a test (test/db-system.test.ts runs every statement the engine makes).
import type { ClientSession, Collection, Document, Db as MongoDatabase } from "mongodb";
import type { Row } from "./types";

/** An engine table: its SQL columns (the ones a row has, NULL when unset), its primary key when that isn't `_id`, and its indexes. */
interface SystemTable {
  columns: string[];
  /** A primary key other than `_id` is kept in `_id`, so it is unique and found through the index every collection has. */
  key?: string;
  unique?: string[];
  indexes?: string[][];
}

export const SYSTEM_TABLES: Record<string, SystemTable> = {
  _scheduled_functions: { columns: ["_id", "_creationTime", "name", "args", "scheduledTime", "state", "error", "completedTime"], indexes: [["state", "scheduledTime"]] },
  _admins: { columns: ["_id", "email", "passwordHash", "role", "createdAt"], unique: ["email"] },
  _admin_sessions: { columns: ["_id", "adminId", "expiresAt"], indexes: [["expiresAt"], ["adminId"]] },
  _audit: { columns: ["_id", "time", "actor", "action", "target", "details"], indexes: [["time"]] },
  _env: { columns: ["name", "value", "updatedAt"], key: "name" },
  _migrations: { columns: ["name", "state", "cursor", "processed", "error", "updatedAt"], key: "name" },
  _settings: { columns: ["name", "value", "updatedAt", "updatedBy"], key: "name" },
  _backups: {
    columns: ["_id", "name", "createdAt", "kind", "state", "bytes", "location", "manifest", "progress", "error", "actor", "server", "finishedAt"],
    indexes: [["createdAt"]],
  },
};

/** Thrown for a unique key or primary key that is already taken, as the SQL databases do. */
export class UniqueViolation extends Error {
  constructor(table: string) {
    super(`UNIQUE constraint failed: ${table}`);
  }
}

// ---- reading the statement ----

type Token = { kind: "id" | "str" | "num" | "param" | "word" | "sym"; value: string };

const TOKEN = /\s+|"([^"]*)"|'((?:[^']|'')*)'|(\?)|(-?\d+(?:\.\d+)?)|([A-Za-z_][A-Za-z0-9_]*)|(<=|>=|<>|!=|[(),=<>*.])/y;

function lex(sql: string): Token[] {
  const out: Token[] = [];
  TOKEN.lastIndex = 0;
  while (TOKEN.lastIndex < sql.length) {
    const at = TOKEN.lastIndex;
    const m = TOKEN.exec(sql);
    if (!m) throw new Error(`MongoDB can't run this SQL (at ${at}): ${sql}`);
    if (m[1] !== undefined) out.push({ kind: "id", value: m[1] });
    else if (m[2] !== undefined) out.push({ kind: "str", value: m[2].replaceAll("''", "'") });
    else if (m[3]) out.push({ kind: "param", value: "?" });
    else if (m[4] !== undefined) out.push({ kind: "num", value: m[4] });
    else if (m[5] !== undefined) out.push({ kind: "word", value: m[5] });
    else if (m[6] !== undefined) out.push({ kind: "sym", value: m[6] });
  }
  return out;
}

class Reader {
  private i = 0;
  private p = 0;
  constructor(
    readonly sql: string,
    private tokens: Token[],
    private params: unknown[],
  ) {}
  fail(what: string): never {
    throw new Error(`MongoDB can't run this SQL (${what}): ${this.sql}`);
  }
  peek = () => this.tokens[this.i];
  done = () => this.i >= this.tokens.length;
  isWord(w: string) {
    const t = this.peek();
    return t?.kind === "word" && t.value.toUpperCase() === w;
  }
  eatWord(w: string) {
    if (!this.isWord(w)) return false;
    this.i++;
    return true;
  }
  word(w: string) {
    if (!this.eatWord(w)) this.fail(`expected ${w}`);
  }
  isSym(s: string) {
    const t = this.peek();
    return t?.kind === "sym" && t.value === s;
  }
  eatSym(s: string) {
    if (!this.isSym(s)) return false;
    this.i++;
    return true;
  }
  sym(s: string) {
    if (!this.eatSym(s)) this.fail(`expected ${s}`);
  }
  /** A column or table name: quoted, or a bare word. */
  name(): string {
    const t = this.tokens[this.i++];
    if (!t || (t.kind !== "id" && t.kind !== "word")) this.fail("expected a name");
    return t.value;
  }
  /** `?`, a string, a number or NULL. */
  value(): unknown {
    const t = this.tokens[this.i++];
    if (!t) this.fail("expected a value");
    if (t.kind === "param") {
      const v = this.params[this.p++];
      return v === undefined ? null : v;
    }
    if (t.kind === "str") return t.value;
    if (t.kind === "num") return Number(t.value);
    if (t.kind === "word" && t.value.toUpperCase() === "NULL") return null;
    return this.fail(`expected a value, got ${t.value}`);
  }
  /** `excluded."col"` of ON CONFLICT DO UPDATE. */
  isExcluded() {
    const t = this.peek();
    return t?.kind === "word" && t.value.toLowerCase() === "excluded";
  }
  finish() {
    if (!this.done()) this.fail(`unexpected ${this.peek()!.value}`);
  }
}

// ---- running it ----

export interface Run {
  database: MongoDatabase;
  session?: ClientSession;
}

const key = (table: string) => SYSTEM_TABLES[table]?.key ?? "_id";
/** The field a SQL column is kept in. */
const fieldOf = (table: string, column: string) => (column === key(table) ? "_id" : column);

function whereOf(r: Reader, table: string): Document {
  if (!r.eatWord("WHERE")) return {};
  const all: Document[] = [];
  do {
    const field = fieldOf(table, r.name());
    if (r.eatWord("IN")) {
      r.sym("(");
      const values = [r.value()];
      while (r.eatSym(",")) values.push(r.value());
      r.sym(")");
      all.push({ [field]: { $in: values } });
    } else if (r.eatWord("LIKE")) {
      const pattern = String(r.value());
      all.push({ [field]: { $regex: "^" + pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replaceAll("%", ".*").replaceAll("_", ".") + "$" } });
    } else {
      const t = r.peek();
      const op = t?.kind === "sym" ? t.value : "";
      const mongo = ({ "=": "$eq", "<": "$lt", "<=": "$lte", ">": "$gt", ">=": "$gte", "<>": "$ne", "!=": "$ne" } as Record<string, string>)[op];
      if (!mongo) r.fail(`unsupported comparison ${op}`);
      r.sym(op);
      const value = r.value();
      // `= NULL` never matches in SQL, and a missing field is NULL here
      all.push({ [field]: { [mongo]: value } });
    }
  } while (r.eatWord("AND"));
  return all.length === 1 ? all[0]! : { $and: all };
}

function orderOf(r: Reader, table: string): Record<string, 1 | -1> | undefined {
  if (!r.eatWord("ORDER")) return undefined;
  r.word("BY");
  const sort: Record<string, 1 | -1> = {};
  let dir: 1 | -1 = 1;
  do {
    const field = fieldOf(table, r.name());
    dir = r.eatWord("DESC") ? -1 : (r.eatWord("ASC"), 1);
    sort[field] = dir;
  } while (r.eatSym(","));
  // ties come back in a fixed order
  sort._id ??= dir;
  return sort;
}

/** A row as SQL would return it: every column, NULL where the document has none. */
function rowOf(table: string, doc: Document, columns?: string[]): Row {
  const t = SYSTEM_TABLES[table];
  if (!t) return columns ? Object.fromEntries(columns.map((c) => [c, doc[c] ?? null])) : doc;
  const out: Row = {};
  for (const c of columns ?? t.columns) out[c] = (c === t.key ? doc._id : doc[c]) ?? null;
  return out;
}

const columnsOf = (table: string) => SYSTEM_TABLES[table]?.columns;

/** Executes one statement. SELECT and `UPDATE … RETURNING` give rows; the others give none. */
export async function runSql(run: Run, sql: string, params: unknown[] = []): Promise<Row[]> {
  const r = new Reader(sql, lex(sql), params);
  const s = run.session ? { session: run.session } : {};
  if (r.eatWord("SELECT")) return select(run, r, s);
  if (r.eatWord("INSERT")) return insert(run, r, s);
  if (r.eatWord("UPDATE")) return update(run, r, s);
  if (r.eatWord("DELETE")) return remove(run, r, s);
  return r.fail("only SELECT, INSERT, UPDATE and DELETE");
}

type Options = { session?: ClientSession };

async function select(run: Run, r: Reader, s: Options): Promise<Row[]> {
  let count: string | undefined;
  let max: { column: string; as: string } | undefined;
  let columns: string[] | undefined;
  if (r.eatSym("*")) columns = undefined;
  else if (r.eatWord("COUNT")) {
    r.sym("(");
    r.sym("*");
    r.sym(")");
    r.word("AS");
    count = r.name();
  } else if (r.eatWord("MAX")) {
    r.sym("(");
    const column = r.name();
    r.sym(")");
    r.word("AS");
    max = { column, as: r.name() };
  } else {
    columns = [r.name()];
    while (r.eatSym(",")) columns.push(r.name());
  }
  r.word("FROM");
  const table = r.name();
  const filter = whereOf(r, table);
  const sort = orderOf(r, table);
  const limit = r.eatWord("LIMIT") ? Number(r.value()) : undefined;
  r.finish();
  const col = run.database.collection(table);
  if (count) return [{ [count]: await col.countDocuments(filter, s) }];
  if (max) {
    const [row] = await col.aggregate([{ $match: filter }, { $group: { _id: null, m: { $max: `$${fieldOf(table, max.column)}` } } }], s).toArray();
    return [{ [max.as]: row?.m ?? null }];
  }
  const projection = columns && Object.fromEntries(columns.map((c) => [fieldOf(table, c), 1]));
  let cursor = col.find(filter, { ...s, ...(projection && { projection }) });
  if (sort) cursor = cursor.sort(sort);
  if (limit !== undefined) {
    if (limit <= 0) return [];
    cursor = cursor.limit(limit);
  }
  return (await cursor.toArray()).map((d) => rowOf(table, d, columns));
}

async function insert(run: Run, r: Reader, s: Options): Promise<Row[]> {
  r.word("INTO");
  const table = r.name();
  r.sym("(");
  const names = [r.name()];
  while (r.eatSym(",")) names.push(r.name());
  r.sym(")");
  r.word("VALUES");
  r.sym("(");
  const values = [r.value()];
  while (r.eatSym(",")) values.push(r.value());
  r.sym(")");
  if (names.length !== values.length) r.fail("columns and values differ");
  const doc: Document = {};
  for (const c of columnsOf(table) ?? []) doc[fieldOf(table, c)] = null;
  names.forEach((c, i) => (doc[fieldOf(table, c)] = values[i]));
  if (key(table) !== "_id") doc[key(table)] = doc._id;
  const col = run.database.collection(table);

  if (!r.eatWord("ON")) {
    r.finish();
    try {
      await col.insertOne(doc, s);
    } catch (e) {
      if ((e as { code?: number }).code === 11000) throw new UniqueViolation(table);
      throw e;
    }
    return [];
  }
  r.word("CONFLICT");
  r.sym("(");
  const target = fieldOf(table, r.name());
  r.sym(")");
  r.word("DO");
  const filter = { [target]: doc[target] };
  const update: Document = {};
  let set: Record<string, unknown> = {};
  if (r.eatWord("NOTHING")) {
    // nothing to change
  } else {
    r.word("UPDATE");
    r.word("SET");
    do {
      const c = fieldOf(table, r.name());
      r.sym("=");
      if (r.isExcluded()) {
        r.name();
        r.sym(".");
        const from = fieldOf(table, r.name());
        set[c] = doc[from];
      } else set[c] = r.value();
    } while (r.eatSym(","));
  }
  r.finish();
  // What the conflict target fixes is in the filter already, and what DO UPDATE sets can't be set again on insert.
  const onInsert = Object.fromEntries(Object.entries(doc).filter(([f]) => f !== target && !(f in set)));
  if (Object.keys(set).length) update.$set = set;
  if (Object.keys(onInsert).length) update.$setOnInsert = onInsert;
  // A concurrent upsert of the same key can lose to a unique index; outside a transaction it is run again, inside one the executor retries it.
  for (let attempt = 0; ; attempt++) {
    try {
      await col.updateOne(filter, update, { ...s, upsert: true });
      return [];
    } catch (e) {
      if ((e as { code?: number }).code === 11000 && !s.session && attempt === 0) continue;
      if ((e as { code?: number }).code === 11000) throw new UniqueViolation(table);
      throw e;
    }
  }
}

async function update(run: Run, r: Reader, s: Options): Promise<Row[]> {
  const table = r.name();
  r.word("SET");
  const set: Record<string, unknown> = {};
  do {
    const c = fieldOf(table, r.name());
    r.sym("=");
    set[c] = r.value();
  } while (r.eatSym(","));
  const filter = whereOf(r, table);
  const returning = r.eatWord("RETURNING");
  const columns = returning ? [r.name()] : undefined;
  while (returning && r.eatSym(",")) columns!.push(r.name());
  r.finish();
  const col = run.database.collection(table);
  if (!returning) {
    await col.updateMany(filter, { $set: set }, s);
    return [];
  }
  // Each row is claimed by one atomic update, so the rows given back are the ones this statement changed and nobody else did.
  const rows: Row[] = [];
  const seen = new Set<unknown>();
  for (;;) {
    const doc = await (col as Collection<Document>).findOneAndUpdate(filter, { $set: set }, { ...s, returnDocument: "after" });
    if (!doc || seen.has(doc._id)) break;
    seen.add(doc._id);
    rows.push(rowOf(table, doc, columns));
  }
  return rows;
}

async function remove(run: Run, r: Reader, s: Options): Promise<Row[]> {
  r.word("FROM");
  const table = r.name();
  const filter = whereOf(r, table);
  r.finish();
  await run.database.collection(table).deleteMany(filter, s);
  return [];
}
