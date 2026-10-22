import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPostgresDb } from "../src/server/db/postgres";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";

export const tempDir = () => mkdtempSync(join(tmpdir(), "afx-"));

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
];
