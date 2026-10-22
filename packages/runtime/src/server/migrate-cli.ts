import { mkdirSync } from "node:fs";
import { validateFields } from "../values";
import { loadConfig, sqlitePath } from "./config";
import { createPostgresDb } from "./db/postgres";
import { createSqliteDb } from "./db/sqlite";
import { DocStore } from "./docstore";
import { loadProject, tableSpecs } from "./project";
import { migrateScheduler } from "./scheduler";

/** Applies table/index migrations, then reports stored documents that no longer match the schema. */
export async function migrate(convexDir: string, env = process.env, dev = true) {
  const config = loadConfig(env, dev);
  const project = await loadProject(convexDir);
  if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });
  const db = config.databaseUrl ? createPostgresDb(config.databaseUrl) : createSqliteDb(sqlitePath(config));
  try {
    await db.migrate(tableSpecs(project.tables));
    await migrateScheduler(db);
    const invalid: { id: string; error: string }[] = [];
    await db.transaction("read", async (tx) => {
      const store = new DocStore(tx, db.dialect, project.tables);
      for (const [name, t] of Object.entries(project.tables)) {
        if (!t.strict) continue;
        for (const { _id, _creationTime, ...fields } of await store.query(name).collect()) {
          try {
            validateFields(t.fields, fields, name);
          } catch (e) {
            invalid.push({ id: _id, error: (e as Error).message });
          }
        }
      }
    });
    return { tables: Object.keys(project.tables), invalid };
  } finally {
    await db.close();
  }
}
