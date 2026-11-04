import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMongoDb } from "../src/server/db/mongodb";
import { createPostgresDb } from "../src/server/db/postgres";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";

const made: string[] = [];
process.on("exit", () => made.forEach((d) => rmSync(d, { recursive: true, force: true }))); // tests leave databases and projects behind otherwise
export const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "afx-"));
  made.push(dir);
  return dir;
};

/** Every Db adapter the contract suite runs against. Postgres needs TEST_POSTGRES_URL. */
export const dbAdapters: [string, () => Promise<Db>][] = [
  ["sqlite (file)", async () => createSqliteDb(join(tempDir(), "app.db"))],
  ["sqlite (:memory:)", async () => createSqliteDb(":memory:")],
  ...(process.env.TEST_POSTGRES_URL
    ? ([
        [
          "postgres",
          async () => {
            const db = createPostgresDb(process.env.TEST_POSTGRES_URL!, 4);
            // Fresh schema per test run so tables don't leak between suites.
            for (const { name } of await db.query<{ name: string }>(`SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'`))
              await db.execute(`DROP TABLE IF EXISTS "${name}" CASCADE`);
            return db;
          },
        ],
      ] as [string, () => Promise<Db>][])
    : []),
  ...(process.env.TEST_MONGODB_URL
    ? ([
        [
          "mongodb",
          async () => {
            // A database of its own per test, dropped when the test is done: collections would leak between tests otherwise.
            const db = createMongoDb(process.env.TEST_MONGODB_URL!, { database: `afx_test_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}` });
            const close = db.close.bind(db);
            const name = (db as unknown as { databaseName?: string }).databaseName;
            db.close = async () => {
              await (db as unknown as { drop?: () => Promise<void> }).drop?.();
              await close();
            };
            void name;
            return db;
          },
        ],
      ] as [string, () => Promise<Db>][])
    : []),
];
