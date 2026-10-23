// Function runtime process: owns forge/ modules, the database, auth and the scheduler.
// The server restarts this process alone when code or dependencies change, and kills it if a call hangs.
import { mkdirSync } from "node:fs";
import { validateFields } from "../values";
import { adminOp, LogWriter } from "./admin-ops";
import { createAuth } from "./auth";
import { loadConfig, sqlitePath } from "./config";
import { createPostgresDb } from "./db/postgres";
import { createLocalDb } from "./db/factory";
import { AUDITED_COMMANDS, runCommand } from "./cli-ops";
import { Executor, logContext, serializeError, type LogEntry } from "./executor";
import { loadProject, tableSpecs, type Manifest, type Project } from "./project";
import type { HostMessage, RuntimeMessage, SerializedResponse } from "./protocol";
import { SchedulerLoop } from "./scheduler";
import { S3Storage } from "./storage";
import { migrateSystem } from "./system";
import type { Db } from "./db/types";

const send = (msg: RuntimeMessage) => process.send!(msg);
process.on("disconnect", () => process.exit(0)); // the server is gone

let logWriter: LogWriter | undefined;
const emit = (entry: LogEntry) => {
  send({ t: "log", entry });
  logWriter?.push(entry);
};

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const ctx = logContext.getStore();
    if (ctx) {
      const message = args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ");
      const time = Date.now();
      emit({ time, name: ctx.name, level, message, requestId: ctx.requestId });
      ctx.logs?.push({ time, level, message });
      original(`[${ctx.name}]`, ...args);
    } else original(...args);
  };
}

/** Variables set with `archlast-forge env`; the process environment wins over them. */
async function loadEnv(db: Db) {
  for (const { name, value } of await db.query<{ name: string; value: string }>(`SELECT "name", "value" FROM "_env"`)) process.env[name] ??= value;
}

/** Production startup check: refuses to serve when stored documents no longer match the schema. */
async function checkSchema(exec: Executor, project: Project) {
  const problems: string[] = [];
  for (const [name, t] of Object.entries(project.tables)) {
    if (!t.strict) continue;
    let cursor: string | null = null;
    for (;;) {
      const page: any = (await exec.read((s) => s.query(name).paginate({ numItems: 1000, cursor }))).value;
      for (const { _id, _creationTime, ...fields } of page.page) {
        try {
          validateFields(t.fields, fields, name);
        } catch (e) {
          problems.push(`${_id}: ${(e as Error).message}`);
          if (problems.length >= 10) break;
        }
      }
      if (page.isDone || problems.length >= 10) break;
      cursor = page.continueCursor;
    }
  }
  if (problems.length)
    throw new Error(
      `Stored documents don't match the schema (fix them with a migration, or set SCHEMA_CHECK=off):\n  ${problems.join("\n  ")}`,
    );
}

async function main() {
  const forgeDir = process.env.ARCHLAST_FORGE_DIR!;
  const worker = Number(process.env.ARCHLAST_WORKER ?? 0);
  const serverId = process.env.ARCHLAST_SERVER_ID ?? "local";
  const config = loadConfig(process.env, process.env.ARCHLAST_DEV === "1");

  if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });
  const db = config.databaseUrl ? createPostgresDb(config.databaseUrl) : await createLocalDb(sqlitePath(config), config.sqliteDriver);
  await migrateSystem(db);
  await loadEnv(db);
  const project = await loadProject(forgeDir);
  await db.migrate(tableSpecs(project.tables));
  logWriter = new LogWriter(db, serverId, config.logRetentionDays * 86400_000);

  const storage = config.s3 ? new S3Storage(config.s3) : undefined;
  const exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    storage,
    limits: config.limits,
    publish: (topics) => send({ t: "publish", topics }),
    log: emit,
  });
  if (config.schemaCheck && worker === 0) await checkSchema(exec, project);
  const auth = createAuth(exec, project.tables, project.authOptions, config);
  // One scheduler per server: in a runtime pool only the first process polls.
  const scheduler = worker === 0 ? new SchedulerLoop(exec, db, project.functions, project.crons, config.limits.actionTimeoutMs + 60_000) : undefined;
  const deps = { db, exec, functions: project.functions, tables: project.tables, crons: project.crons, storage, serverId };

  /** CLI data commands, run here because this process holds the database. */
  async function cli({ cmd, args = {} }: { cmd: string; args?: Record<string, unknown> }) {
    const out = await runCommand({ config, db, project, exec, close: async () => {} }, cmd, args);
    if (AUDITED_COMMANDS.has(cmd)) {
      const { name, email, file } = args as Record<string, unknown>; // never the values or passwords
      await db.execute(`INSERT INTO "_audit" ("_id", "time", "actor", "action", "target", "details") VALUES (?, ?, ?, ?, ?, ?)`, [
        `_audit:${crypto.randomUUID().replaceAll("-", "")}`,
        Date.now(),
        "cli",
        cmd,
        String(name ?? email ?? file ?? "") || null,
        "{}",
      ]);
    }
    return out;
  }

  async function handle(msg: HostMessage): Promise<unknown> {
    switch (msg.t) {
      case "call":
        return exec.run(msg.name, msg.kind, msg.args, msg.headers, { allowInternal: msg.allowInternal, requestId: msg.requestId, identity: msg.identity });
      case "identity":
        return exec.identityOf(msg.headers);
      case "auth": {
        const { method, url, headers, body } = msg.req;
        const res = await auth.handler(new Request(url, { method, headers, body }));
        return { status: res.status, headers: [...res.headers], body: await res.text() } satisfies SerializedResponse;
      }
      case "admin":
        if (msg.op === "cli") return cli(msg.args as { cmd: string; args?: Record<string, unknown> });
        return adminOp(deps, msg.op, msg.args ?? {}, msg.actor);
    }
  }

  process.on("message", async (msg: HostMessage | { t: "shutdown" }) => {
    if (msg.t === "shutdown") {
      scheduler?.stop();
      await logWriter?.close().catch(() => {});
      await db.close();
      process.exit(0);
    }
    try {
      send({ t: "result", id: msg.id, ok: true, value: await handle(msg) });
    } catch (e) {
      send({ t: "result", id: msg.id, ok: false, error: serializeError(e) });
    }
  });

  scheduler?.start();
  const manifest: Manifest = {
    functions: [...project.functions].map(([name, fn]) => ({ name, kind: fn.kind, visibility: fn.visibility ?? "public", args: fn.args, returns: fn.returns })),
    tables: project.tables,
    crons: project.crons,
    storage: Boolean(config.s3),
  };
  send({ t: "ready", manifest });
}

main().catch((e) => {
  send({ t: "fatal", error: (e as Error)?.message ?? String(e) });
  setTimeout(() => process.exit(1), 50); // let the IPC message flush
});
