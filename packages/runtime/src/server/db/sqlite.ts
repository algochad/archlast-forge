import { Database } from "bun:sqlite";
import { ftsTable, migrateSqlite } from "./migrate";
import { scopedTx, type Db, type DbTx, type Dialect } from "./types";

const field = (name: string) => `json_extract("doc", '$.${name}')`;

// json_extract returns 1/0 for booleans and minified JSON text for arrays/objects.
const encode = (value: unknown) => (typeof value === "boolean" ? Number(value) : typeof value === "object" && value !== null ? JSON.stringify(value) : value);

export const sqliteDialect: Dialect = {
  name: "sqlite",
  realType: "REAL",
  jsonType: "TEXT",
  jsonParam: "?",
  valueParam: "?",
  encode,
  field,
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    return { sql: `${field(name)} = ?`, params: [encode(value)] };
  },
  listIndexesSql: `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
  searchWrite(table, index, id, text) {
    const fts = ftsTable(table, index);
    const del = { sql: `DELETE FROM "${fts}" WHERE doc_id = ?`, params: [id] };
    return text === undefined ? [del] : [del, { sql: `INSERT INTO "${fts}" (doc_id, body) VALUES (?, ?)`, params: [id, text] }];
  },
  searchSql(table, index, _field, terms, filters, limit) {
    const fts = ftsTable(table, index);
    const match = terms.map((t, i) => `"${t}"${i === terms.length - 1 ? "*" : ""}`).join(" ");
    return {
      sql: `SELECT "${table}"."_id", "${table}"."_creationTime", "${table}"."doc" FROM "${fts}" JOIN "${table}" ON "${table}"."_id" = "${fts}".doc_id WHERE "${fts}" MATCH ?${filters.map((f) => ` AND ${f.sql}`).join("")} ORDER BY "${fts}".rank LIMIT ${limit}`,
      params: [match, ...filters.flatMap((f) => f.params)],
    };
  },
};

/** WAL mode, one write connection, a small pool of readers. `:memory:` runs everything on one connection. */
export function createSqliteDb(path: string, readers = 4): Db {
  const open = () => {
    const c = new Database(path, { create: true });
    c.exec("PRAGMA busy_timeout = 5000");
    return c;
  };
  const writer = open();
  try {
    writer.exec("PRAGMA journal_mode = WAL");
  } catch (e) {
    if (/not a database/i.test((e as Error).message)) throw new Error(`${path} was created by the Turso driver, whose file format SQLite can't read. Delete it to start fresh, or set SQLITE_DRIVER=turso to keep using it.`, { cause: e });
    throw e;
  }
  writer.exec("PRAGMA synchronous = NORMAL");
  const memory = path === ":memory:";
  const pool = memory
    ? []
    : Array.from({ length: readers }, () => {
        const c = open();
        c.exec("PRAGMA query_only = ON");
        return c;
      });
  const waiting: ((c: Database) => void)[] = [];

  let lock: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const run = lock.then(fn);
    lock = run.catch(() => {});
    return run;
  };
  const acquire = () => new Promise<Database>((resolve) => (pool.length ? resolve(pool.pop()!) : waiting.push(resolve)));
  const release = (c: Database) => (waiting.length ? waiting.shift()!(c) : pool.push(c));

  const txOf = (c: Database): DbTx => ({
    async query(sql, params = []) {
      return c.query(sql).all(...(params as any[])) as any[];
    },
    async execute(sql, params = []) {
      c.query(sql).run(...(params as any[]));
    },
  });

  async function run<T>(c: Database, begin: string, fn: (tx: DbTx) => Promise<T>): Promise<T> {
    c.exec(begin);
    const tx = scopedTx(txOf(c));
    try {
      const result = await fn(tx);
      tx.end();
      c.exec("COMMIT");
      return result;
    } catch (e) {
      tx.end();
      if (c.inTransaction) c.exec("ROLLBACK");
      throw e;
    }
  }

  const db: Db = {
    dialect: sqliteDialect,
    async query(sql, params) {
      if (memory) return serialize(() => txOf(writer).query(sql, params));
      const c = await acquire();
      try {
        return await txOf(c).query(sql, params);
      } finally {
        release(c);
      }
    },
    execute: (sql, params) => serialize(() => txOf(writer).execute(sql, params)),
    async transaction(mode, fn) {
      if (mode === "write" || memory) return serialize(() => run(writer, mode === "write" ? "BEGIN IMMEDIATE" : "BEGIN", fn));
      const c = await acquire();
      try {
        return await run(c, "BEGIN", fn);
      } finally {
        release(c);
      }
    },
    migrate: (tables) => migrateSqlite(db, tables),
    async close() {
      await lock;
      for (const c of [writer, ...pool]) c.close();
    },
  };
  return db;
}
