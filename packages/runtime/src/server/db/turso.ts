// The Turso driver (@tursodatabase/database, pre-1.0): a Rust engine with MVCC, so writes on different connections run concurrently.
// Same `Db` as the bun:sqlite and Postgres drivers. It differs where the engine does:
//  - Everything is async, and a connection runs one transaction at a time, so the pool hands connections out exclusively.
//  - Writes use BEGIN CONCURRENT. Two transactions that change the same row conflict ("Write-write conflict"): the loser is aborted and
//    reported with Postgres' serialization-failure code, so the executor's existing retry loop covers it.
//  - DDL needs a plain BEGIN. A write transaction that turns out to contain DDL (migrations) is rolled back and run again that way.
//  - There is no FTS5. Search indexes are a plain table of (term, document, count) kept in step with writes.
//  - The file is locked to one process, and MVCC changes the file format: SQLite can't open it afterwards, and Turso refuses SQLite files.
import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { ftsTable, migrateSqlite } from "./migrate";
import { sqliteDialect } from "./sqlite";
import { PREFIX_END, tokenize } from "./tokens";
import { CONFLICT_CODE, scopedTx, type Db, type DbTx, type Dialect } from "./types";

type Turso = Awaited<ReturnType<typeof import("@tursodatabase/database").connect>>;

const DDL = /^\s*(CREATE|DROP|ALTER|REINDEX|VACUUM|ANALYZE)\b/i;
/** Statements that can't run inside a transaction. */
const PRAGMA = /^\s*(PRAGMA|VACUUM)\b/i;
const CONFLICT = /write-write conflict|commit dependency aborted/i;

export const tursoDialect: Dialect = {
  ...sqliteDialect,
  search: "tokens",
  searchWrite(table, index, id, text) {
    const t = ftsTable(table, index);
    const del = { sql: `DELETE FROM "${t}" WHERE "doc_id" = ?`, params: [id] };
    if (text === undefined) return [del];
    const terms = [...tokenize(text)];
    const inserts: { sql: string; params: unknown[] }[] = [];
    for (let i = 0; i < terms.length; i += 100) {
      const chunk = terms.slice(i, i + 100);
      inserts.push({ sql: `INSERT INTO "${t}" ("term", "doc_id", "tf") VALUES ${chunk.map(() => "(?, ?, ?)").join(", ")}`, params: chunk.flatMap(([term, tf]) => [term, id, tf]) });
    }
    return [del, ...inserts];
  },
  // Every term must match and the last one as a prefix, like FTS5. Relevance is how often the matched terms occur, newest first on ties.
  searchSql(table, index, _field, terms, filters, limit) {
    const t = ftsTable(table, index);
    const exact = [...new Set(terms.slice(0, -1))];
    const prefix = terms.at(-1)!;
    const matched = [...exact.map(() => `"term" = ?`), `("term" >= ? AND "term" < ?)`].join(" OR ");
    const requires = [...exact.map(() => `"doc_id" IN (SELECT "doc_id" FROM "${t}" WHERE "term" = ?)`), `"doc_id" IN (SELECT "doc_id" FROM "${t}" WHERE "term" >= ? AND "term" < ?)`].join(" AND ");
    return {
      sql: `SELECT "${table}"."_id" AS "_id", "${table}"."_creationTime" AS "_creationTime", "${table}"."doc" AS "doc" FROM (SELECT "doc_id", SUM("tf") AS "score" FROM "${t}" WHERE (${matched}) AND ${requires} GROUP BY "doc_id") AS m JOIN "${table}" ON "${table}"."_id" = m."doc_id"${filters.length ? ` WHERE ${filters.map((f) => f.sql).join(" AND ")}` : ""} ORDER BY m."score" DESC, "${table}"."_creationTime" DESC LIMIT ${limit}`,
      params: [...exact, prefix, prefix + PREFIX_END, ...exact, prefix, prefix + PREFIX_END, ...filters.flatMap((f) => f.params)],
    };
  },
};

class NeedsExclusive extends Error {}

/** One engine connection with its prepared statements. Statements are prepared once per SQL text; a schema change drops them. */
class Conn {
  private statements = new Map<string, Awaited<ReturnType<Turso["prepare"]>>>();
  private seen: number;
  constructor(
    readonly db: Turso,
    private schema: { version: number },
  ) {
    this.seen = schema.version;
  }

  private async statement(sql: string) {
    if (DDL.test(sql) || PRAGMA.test(sql)) return this.db.prepare(sql);
    if (this.seen !== this.schema.version) (this.statements.clear(), (this.seen = this.schema.version));
    let s = this.statements.get(sql);
    if (!s) {
      s = await this.db.prepare(sql);
      if (this.statements.size >= 256) this.statements.delete(this.statements.keys().next().value!);
      this.statements.set(sql, s);
    }
    return s;
  }

  async all(sql: string, params: unknown[]) {
    return (await this.statement(sql)).all(...(params as never[])) as Promise<any[]>;
  }

  async run(sql: string, params: unknown[]) {
    await (await this.statement(sql)).run(...(params as never[]));
  }
}

/**
 * A file SQLite made can't be opened by this engine safely (it doesn't see the file's own constraints and indexes), so don't try.
 * Both engines write the same magic string, but MVCC files carry format version 255 at bytes 18-19 where SQLite writes 1 or 2.
 */
function refuseSqliteFile(path: string) {
  if (!existsSync(path)) return;
  const fd = openSync(path, "r");
  const head = Buffer.alloc(20);
  try {
    if (readSync(fd, head, 0, 20, 0) < 20) return; // empty or tiny: nothing in it yet
  } finally {
    closeSync(fd);
  }
  if (head.toString("latin1", 0, 16) === "SQLite format 3\0" && (head[18] === 1 || head[18] === 2))
    throw new Error(`${path} was created by SQLite (the bun driver), which the Turso driver can't open safely. Delete it to start fresh, or set SQLITE_DRIVER=bun to keep using it.`);
}

export async function createTursoDb(path: string, opts: { connections?: number } = {}): Promise<Db> {
  const { connect } = await import("@tursodatabase/database");
  const memory = path === ":memory:";
  if (!memory) refuseSqliteFile(path);
  const schema = { version: 0 };
  const open = async () => {
    const c = await connect(path).catch((e: Error) => {
      if (/locked by another process/i.test(e.message)) throw new Error(`${path} is open in another process, probably the running server. Turso allows one process per database: the CLI reaches a running server when ADMIN_KEY is set, otherwise stop the server first.`, { cause: e });
      throw e;
    });
    await (await c.prepare(`PRAGMA busy_timeout = 5000`)).run();
    return new Conn(c, schema);
  };
  const first = await open();
  await first.all("PRAGMA journal_mode = 'mvcc'", []); // concurrent writers; stored in the file, so this is a no-op after the first time
  await first.run("PRAGMA synchronous = NORMAL", []);
  const conns = [first];
  // A memory database belongs to its connection, so it gets exactly one.
  for (let i = 1; i < (memory ? 1 : (opts.connections ?? 4)); i++) conns.push(await open());

  const idle = [...conns];
  const waiting: ((c: Conn) => void)[] = [];
  const acquire = () => new Promise<Conn>((resolve) => (idle.length ? resolve(idle.pop()!) : waiting.push(resolve)));
  const release = (c: Conn) => (waiting.length ? waiting.shift()!(c) : idle.push(c));

  // One write transaction at a time. Turso 0.8's concurrent writers (BEGIN CONCURRENT) can hang the whole process when a long write
  // transaction overlaps others on separate connections (a 600-row insert next to 50 small writers froze it for good), and one JS thread
  // gains nothing from interleaving them. Readers still run beside the writer, each on its own snapshot.
  let writer: Promise<unknown> = Promise.resolve();
  const exclusively = <T>(fn: () => Promise<T>): Promise<T> => {
    const turn = writer.then(fn, fn);
    writer = turn.catch(() => {});
    return turn;
  };

  const convert = (e: unknown) => (CONFLICT.test((e as Error)?.message ?? "") ? Object.assign(new Error((e as Error).message, { cause: e }), { code: CONFLICT_CODE }) : e);

  const txOf = (c: Conn, mode: "concurrent" | "exclusive" | "read"): DbTx => ({
    query: (sql, params = []) => c.all(sql, params),
    async execute(sql, params = []) {
      if (mode === "concurrent" && DDL.test(sql)) throw new NeedsExclusive();
      await c.run(sql, params);
    },
  });

  async function run<T>(c: Conn, mode: "concurrent" | "exclusive" | "read", fn: (tx: DbTx) => Promise<T>): Promise<T> {
    await c.db.exec(mode === "concurrent" ? "BEGIN CONCURRENT" : "BEGIN");
    const tx = scopedTx(txOf(c, mode));
    try {
      const result = await fn(tx);
      tx.end();
      await c.db.exec("COMMIT");
      if (mode === "exclusive") schema.version++; // prepared statements may mention what DDL just changed
      return result;
    } catch (e) {
      tx.end();
      if (c.db.inTransaction) await c.db.exec("ROLLBACK").catch(() => {});
      if (e instanceof NeedsExclusive) return run(c, "exclusive", fn);
      throw convert(e);
    }
  }

  const db: Db = {
    dialect: tursoDialect,
    async query(sql, params) {
      const c = await acquire();
      try {
        return (await c.all(sql, params ?? [])) as never;
      } catch (e) {
        throw convert(e);
      } finally {
        release(c);
      }
    },
    async execute(sql, params) {
      if (PRAGMA.test(sql)) {
        const c = await acquire();
        try {
          await c.run(sql, params ?? []);
        } finally {
          release(c);
        }
        return;
      }
      await db.transaction("write", (tx) => tx.execute(sql, params));
    },
    async transaction(mode, fn) {
      const go = async () => {
        const c = await acquire();
        try {
          return await run(c, mode === "write" ? "concurrent" : "read", fn);
        } finally {
          release(c);
        }
      };
      return mode === "write" ? exclusively(go) : go();
    },
    migrate: (tables) => migrateSqlite(db, tables),
    async close() {
      for (const c of conns) await c.db.close();
    },
  };
  return db;
}
