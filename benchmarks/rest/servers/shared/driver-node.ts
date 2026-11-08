// The SQLite driver of the JavaScript servers on Node.js: node:sqlite. The Dockerfile puts this, rules.ts and store-sqlite.ts in one file, store.ts, so the servers' code is the one the in-memory benchmark runs.
import { DatabaseSync } from "node:sqlite";

interface Statement {
  get(...params: unknown[]): any;
  all(...params: unknown[]): any[];
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
}
interface Db {
  exec(sql: string): void;
  prepare(sql: string): Statement;
}
const open = (path: string): Db => new DatabaseSync(path) as unknown as Db;
