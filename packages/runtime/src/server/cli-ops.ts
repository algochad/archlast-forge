// Commands that work on a project's database directly, in the CLI's process (or inside the engine container).
import { mkdirSync } from "node:fs";
import { validateFields, ValidationError } from "../values";
import { addAdmin, listAdmins, removeAdmin, type AdminRole } from "./admin-ops";
import { loadConfig, sqlitePath, type Config } from "./config";
import { createPostgresDb } from "./db/postgres";
import { createSqliteDb } from "./db/sqlite";
import type { Db } from "./db/types";
import { Executor } from "./executor";
import { loadProject, tableSpecs, type Project } from "./project";
import { migrateSystem } from "./system";

export interface ProjectDb {
  config: Config;
  db: Db;
  project: Project;
  exec: Executor;
  close(): Promise<void>;
}

/** Connects to the project's database and applies table/index migrations. */
export async function openProject(forgeDir: string, env: Record<string, string | undefined> = process.env, dev = true): Promise<ProjectDb> {
  const config = loadConfig({ ...env, ALLOW_INSECURE_HTTP: "1", BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET || "cli" }, dev);
  if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });
  const db = config.databaseUrl ? createPostgresDb(config.databaseUrl, config.databasePoolSize) : createSqliteDb(sqlitePath(config));
  await migrateSystem(db);
  for (const { name, value } of await db.query<{ name: string; value: string }>(`SELECT "name", "value" FROM "_env"`)) env[name] ??= value;
  const project = await loadProject(forgeDir);
  await db.migrate(tableSpecs(project.tables));
  const exec = new Executor({ db, tables: project.tables, functions: project.functions, limits: config.limits, publish: () => {}, log: () => {} });
  return { config, db, project, exec, close: () => db.close() };
}

/** Documents that don't match the schema, for `migrate` (check). */
export async function invalidDocuments(p: ProjectDb, limit = 1000) {
  const invalid: { id: string; error: string }[] = [];
  for (const [name, t] of Object.entries(p.project.tables)) {
    if (!t.strict) continue;
    let cursor: string | null = null;
    for (;;) {
      const page: any = (await p.exec.read((s) => s.query(name).paginate({ numItems: 1000, cursor }))).value;
      for (const { _id, _creationTime, ...fields } of page.page) {
        try {
          validateFields(t.fields, fields, name);
        } catch (e) {
          invalid.push({ id: _id, error: (e as Error).message });
        }
      }
      if (page.isDone || invalid.length >= limit) break;
      cursor = page.continueCursor;
    }
  }
  return invalid;
}

// ---- data migrations ----

export async function migrationStatus(p: ProjectDb) {
  const rows = await p.db.query<{ name: string; state: string; processed: number; error: string | null }>(`SELECT * FROM "_migrations"`);
  return [...p.project.functions]
    .filter(([, fn]) => (fn as any).migration)
    .map(([name, fn]) => ({ name, table: (fn as any).migration.table as string, ...(rows.find((r) => r.name === name) ?? { state: "pending", processed: 0, error: null }) }));
}

/** Runs pending migrations (or the named ones) to completion, one batch per transaction; resumable after a failure. */
export async function runMigrations(p: ProjectDb, names: string[] = [], onProgress: (name: string, processed: number) => void = () => {}) {
  const status = await migrationStatus(p);
  const todo = status.filter((m) => (names.length ? names.includes(m.name) : m.state !== "done"));
  for (const n of names) if (!status.some((m) => m.name === n)) throw new ValidationError(`No migration named "${n}"`);
  for (const m of todo) {
    let [row] = await p.db.query<{ cursor: string | null; processed: number; state: string }>(`SELECT * FROM "_migrations" WHERE "name" = ?`, [m.name]);
    if (!row || row.state === "done") {
      // Named again after finishing: run from the start.
      row = { cursor: null, processed: 0, state: "running" };
    }
    let { cursor, processed } = row;
    const save = (state: string, error: string | null = null) =>
      p.db.execute(
        `INSERT INTO "_migrations" ("name", "state", "cursor", "processed", "error", "updatedAt") VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT ("name") DO UPDATE SET "state" = excluded."state", "cursor" = excluded."cursor", "processed" = excluded."processed", "error" = excluded."error", "updatedAt" = excluded."updatedAt"`,
        [m.name, state, cursor, processed, error, Date.now()],
      );
    await save("running");
    try {
      for (;;) {
        const r = (await p.exec.call(m.name, "mutation", { cursor }, null)).value as { cursor: string; isDone: boolean; processed: number };
        processed += r.processed;
        cursor = r.cursor;
        onProgress(m.name, processed);
        if (r.isDone) break;
        await save("running");
      }
      await save("done");
    } catch (e) {
      await save("failed", (e as Error).message);
      throw new Error(`Migration ${m.name} failed after ${processed} documents: ${(e as Error).message}. Fix it and run again; it resumes.`);
    }
  }
  return todo.map((m) => m.name);
}

// ---- export, import, backup ----

/** Every document table: the schema's, auth and _storage. JSON Lines, one `{table, _id, _creationTime, doc}` per line. */
export async function exportData(p: ProjectDb, file: string) {
  const writer = Bun.file(file).writer();
  let count = 0;
  for (const table of Object.keys(p.project.tables)) {
    let cursor: string | null = null;
    for (;;) {
      const page: any = (await p.exec.read((s) => s.query(table).paginate({ numItems: 1000, cursor }))).value;
      for (const { _id, _creationTime, ...doc } of page.page) {
        writer.write(JSON.stringify({ table, _id, _creationTime, doc }) + "\n");
        count++;
      }
      if (page.isDone) break;
      cursor = page.continueCursor;
    }
  }
  await writer.end();
  return count;
}

/** Restores an export. Target tables must be empty unless `replace` clears them first. Documents are validated. */
export async function importData(p: ProjectDb, file: string, { replace = false } = {}) {
  const lines = (await Bun.file(file).text()).split("\n").filter(Boolean);
  const rows = lines.map((l, i) => {
    try {
      return JSON.parse(l) as { table: string; _id: string; _creationTime: number; doc: Record<string, unknown> };
    } catch {
      throw new ValidationError(`Line ${i + 1} of ${file} isn't valid JSON`);
    }
  });
  const tables = [...new Set(rows.map((r) => r.table))];
  for (const t of tables) if (!p.project.tables[t]) throw new ValidationError(`Table "${t}" in the export isn't in the schema`);
  for (const t of tables) {
    const [{ n }] = (await p.db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "${t}"`)) as [{ n: number }];
    if (Number(n) && !replace) throw new ValidationError(`Table "${t}" already has ${n} documents; pass --replace to clear it first`);
  }
  if (replace)
    await p.exec.mutate(async (s) => {
      for (const t of tables) for (const d of await s.query(t).collect()) await s.delete(d._id);
    });
  for (let i = 0; i < rows.length; i += 500)
    await p.exec.mutate(async (s) => {
      for (const r of rows.slice(i, i + 500)) await s.restore(r.table, r._id, r._creationTime, r.doc);
    });
  return rows.length;
}

/** A consistent copy of the SQLite database. Postgres has its own tools. */
export async function backup(p: ProjectDb, file: string) {
  if (p.db.dialect.name !== "sqlite") throw new ValidationError("For Postgres, back up with pg_dump (or use `archlast-forge export`).");
  await p.db.execute(`VACUUM INTO ?`, [file]);
}

// ---- environment variables ----

export const listEnv = (db: Db) => db.query<{ name: string; value: string; updatedAt: number }>(`SELECT * FROM "_env" ORDER BY "name"`);

export async function setEnv(db: Db, name: string, value: string) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new ValidationError(`Invalid variable name "${name}"`);
  await db.execute(
    `INSERT INTO "_env" ("name", "value", "updatedAt") VALUES (?, ?, ?) ON CONFLICT ("name") DO UPDATE SET "value" = excluded."value", "updatedAt" = excluded."updatedAt"`,
    [name, value, Date.now()],
  );
}

export const removeEnv = (db: Db, name: string) => db.execute(`DELETE FROM "_env" WHERE "name" = ?`, [name]);

export { addAdmin, listAdmins, removeAdmin, type AdminRole };

/** Opens just the database (no user code), for env and admin commands. */
export async function openDb(env: Record<string, string | undefined> = process.env) {
  const config = loadConfig({ ...env, ALLOW_INSECURE_HTTP: "1", BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET || "cli" }, true);
  if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });
  const db = config.databaseUrl ? createPostgresDb(config.databaseUrl, config.databasePoolSize) : createSqliteDb(sqlitePath(config));
  await migrateSystem(db);
  return db;
}

// ---- commands ----

type Context = Pick<ProjectDb, "db"> | ProjectDb;

/**
 * The CLI's data commands as `cmd` + JSON `args` in, JSON out, so they can run in this process or, over `/_cli`, inside the running server.
 * Inside the server, an import reaches subscribers and a command never contends with the server for the write lock.
 */
export async function runCommand(c: Context, cmd: string, a: Record<string, any> = {}): Promise<any> {
  const p = c as ProjectDb;
  switch (cmd) {
    case "migrate.status":
      return migrationStatus(p);
    case "migrate.run":
      return runMigrations(p, a.names ?? []);
    case "migrate.check":
      return { tables: Object.keys(p.project.tables).length, invalid: await invalidDocuments(p) };
    case "export":
      return exportData(p, a.file);
    case "import":
      return importData(p, a.file, { replace: Boolean(a.replace) });
    case "backup":
      return backup(p, a.file);
    case "env.list":
      return listEnv(c.db);
    case "env.set":
      return setEnv(c.db, a.name, a.value);
    case "env.rm":
      return removeEnv(c.db, a.name);
    case "admin.list":
      return listAdmins(c.db);
    case "admin.add":
      return addAdmin(c.db, a.email, a.password, a.role);
    case "admin.remove":
      return removeAdmin(c.db, a.email);
  }
  throw new ValidationError(`Unknown command "${cmd}"`);
}

/** Commands that read or change secrets or accounts, recorded in the audit log without their values. */
export const AUDITED_COMMANDS = new Set(["import", "env.set", "env.rm", "admin.add", "admin.remove", "migrate.run"]);
