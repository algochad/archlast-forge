// The SQLite driver of the JavaScript servers on Bun: bun:sqlite. The Dockerfile puts this, rules.ts and store-sqlite.ts in one file, store.ts, so the servers' code is the one the in-memory benchmark runs.
import { Database } from "bun:sqlite";

interface Statement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
const open = (path: string): Db => new Database(path) as unknown as Db;
