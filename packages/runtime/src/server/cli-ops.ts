// Commands that work on a project's database directly, in the CLI's process (or inside the engine container).
import { mkdirSync } from "node:fs";
import { validateFields, ValidationError } from "../values";
import { addAdmin, listAdmins, removeAdmin, type AdminRole } from "./admin-ops";
import { loadConfig, type Config } from "./config";
import { openDatabase } from "./db/open";
import type { Db } from "./db/types";
import { Executor } from "./executor";
import { loadProject, tableSpecs, type Project } from "./project";
import { migrateSystem } from "./system";
import { listEnv, removeEnv, setEnv } from "./env-store";
import { readStoredSettings, withSettings } from "./settings";
import { createStorage, type Storage } from "./storage";
import { Backups, restoreArchive, writeArchive } from "./backup/backups";

export interface ProjectDb {
  config: Config;
  db: Db;
  project: Project;
  exec: Executor;
  storage?: Storage;
  forgeDir: string;
  env: Record<string, string | undefined>;
  serverId?: string;
  close(): Promise<void>;
}

/** Connects to the project's database and applies table/index migrations. */
export async function openProject(forgeDir: string, env: Record<string, string | undefined> = process.env, dev = true): Promise<ProjectDb> {
  const cliEnv = { ...env, ALLOW_INSECURE_HTTP: "1", BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET || "cli" };
  const boot = loadConfig(cliEnv, dev);
  // Settings saved from the dashboard (storage, limits) apply here as they do in the server; a bad one is ignored as it is there.
  const stored = await readStoredSettings(boot).catch(() => ({}));
  let config = boot;
  try {
    config = loadConfig(withSettings(cliEnv, stored), dev);
  } catch {}
  if (config.databaseKind !== "postgres") mkdirSync(config.dataDir, { recursive: true });
  const db = await openDatabase(cliPools(config));
  await migrateSystem(db);
  for (const { name, value } of await db.query<{ name: string; value: string }>(`SELECT "name", "value" FROM "_env"`)) env[name] ??= value;
  const project = await loadProject(forgeDir);
  await db.migrate(tableSpecs(project.tables));
  const exec = new Executor({ db, tables: project.tables, functions: project.functions, limits: config.limits, publish: () => {}, log: () => {} });
  return { config, db, project, exec, storage: createStorage(config), forgeDir, env: withSettings(cliEnv, stored), close: () => db.close() };
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
  // One transaction for the clearing and every row, so an import that fails (or is cut off) changes nothing, and nobody reads the tables
  // half-cleared or half-loaded. It publishes one reset, like a restore, instead of a topic per document.
  await p.exec.rewrite(async (s) => {
    if (replace) for (const t of tables) for (const d of await s.query(t).collect()) await s.delete(d._id);
    for (const r of rows) await s.restore(r.table, r._id, r._creationTime, r.doc);
  });
  return rows.length;
}

/** A consistent copy of the SQLite database. Postgres has its own tools. */
export async function backup(p: ProjectDb, file: string) {
  if (p.db.dialect.name !== "sqlite") throw new ValidationError(`For ${p.db.dialect.name === "mongodb" ? "MongoDB, back up with mongodump" : "Postgres, back up with pg_dump"} (or use \`archlast-forge export\`, or a full backup).`);
  await p.db.execute(`VACUUM INTO ?`, [file]);
}

const backupDeps = (p: ProjectDb) => ({
  db: p.db,
  exec: p.exec,
  tables: p.project.tables,
  forgeDir: p.forgeDir,
  storage: p.storage,
  config: p.config,
  env: p.env,
  serverId: p.serverId ?? "cli",
});

/** A full backup (data, forge/ source, files) as a .tar.gz at `file`, the format the dashboard's Backups page makes and restores. */
export async function fullBackup(p: ProjectDb, file: string, { files = true } = {}) {
  return writeArchive(backupDeps(p), file, { kind: "cli", files });
}

/** Restores a full backup from `file`. A safety backup of what is there now goes to the backup store first, as from the dashboard. */
export async function restore(p: ProjectDb, file: string, { files = true, config = false, safety = true } = {}) {
  const d = backupDeps(p);
  if (safety) {
    const made = await (await new Backups(d).start({ kind: "pre-restore", files, actor: "cli" })).done;
    if (made.state !== "done") throw new Error(`The safety backup failed, so nothing was restored: ${made.error}`);
  }
  const out = await restoreArchive(d, Bun.file(file), { files, config });
  return { documents: out.documents, files: out.files, tables: out.tables, config: out.config };
}

// ---- environment variables ----

export { listEnv, removeEnv, setEnv };

export { addAdmin, listAdmins, removeAdmin, type AdminRole };

/** A CLI command is one process doing one thing at a time: a few connections, whatever the server's pools are. */
const cliPools = (config: Config): Config => ({ ...config, databasePoolSize: config.databasePoolSize ?? 2, databaseWritePoolSize: config.databaseWritePoolSize ?? 2 });

/** Opens just the database (no user code), for env and admin commands. */
export async function openDb(env: Record<string, string | undefined> = process.env) {
  const config = loadConfig({ ...env, ALLOW_INSECURE_HTTP: "1", BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET || "cli" }, true);
  if (config.databaseKind !== "postgres") mkdirSync(config.dataDir, { recursive: true });
  const db = await openDatabase(cliPools(config));
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
    case "backup.full":
      return fullBackup(p, a.file, { files: a.files !== false });
    case "restore":
      return restore(p, a.file, { files: a.files !== false, config: Boolean(a.config), safety: a.safety !== false });
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
export const AUDITED_COMMANDS = new Set(["import", "restore", "env.set", "env.rm", "admin.add", "admin.remove", "migrate.run"]);
