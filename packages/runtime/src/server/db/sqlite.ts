import { Database } from "bun:sqlite";
import { migrateTables } from "./migrate";
import type { Db, DbTx, Dialect } from "./types";

const field = (name: string) => `json_extract("doc", '$.${name}')`;

export const sqliteDialect: Dialect = {
  name: "sqlite",
  realType: "REAL",
  jsonType: "TEXT",
  jsonParam: "?",
  field,
  fieldEquals(name, value) {
    if (value === undefined) return { sql: `${field(name)} IS NULL`, params: [] };
    // json_extract returns 1/0 for booleans and minified JSON text for arrays/objects.
    const param = typeof value === "boolean" ? Number(value) : typeof value === "object" ? JSON.stringify(value) : value;
    return { sql: `${field(name)} = ?`, params: [param] };
  },
  listIndexesSql: `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ?`,
};

/** WAL mode, one write connection, a small pool of readers. `:memory:` runs everything on one connection. */
export function createSqliteDb(path: string, readers = 4): Db {
  const open = () => {
    const c = new Database(path, { create: true });
    c.exec("PRAGMA busy_timeout = 5000");
    return c;
  };
  const writer = open();
  writer.exec("PRAGMA journal_mode = WAL");
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
    try {
      const result = await fn(txOf(c));
      c.exec("COMMIT");
      return result;
    } catch (e) {
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
    migrate: (tables) => migrateTables(db, tables),
    async close() {
      await lock;
      for (const c of [writer, ...pool]) c.close();
    },
  };
  return db;
}
