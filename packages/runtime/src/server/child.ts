// Function runtime process: owns convex/ modules, the database, auth and the scheduler.
// The server restarts this process alone when code or dependencies change.
import { mkdirSync } from "node:fs";
import { ValidationError } from "../values";
import { createAuth } from "./auth";
import { loadConfig, sqlitePath } from "./config";
import { createPostgresDb } from "./db/postgres";
import { createSqliteDb } from "./db/sqlite";
import { Executor, logContext } from "./executor";
import { loadProject, type Manifest } from "./project";
import type { HostMessage, RuntimeMessage, SerializedResponse } from "./protocol";
import { migrateScheduler, SchedulerLoop } from "./scheduler";
import { S3Storage } from "./storage";

const send = (msg: RuntimeMessage) => process.send!(msg);
process.on("disconnect", () => process.exit(0)); // the server is gone

for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const ctx = logContext.getStore();
    if (ctx) {
      const message = args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ");
      send({ t: "log", entry: { time: Date.now(), name: ctx.name, level, message } });
      original(`[${ctx.name}]`, ...args);
    } else original(...args);
  };
}

async function main() {
  const convexDir = process.env.ARCHLAST_CONVEX_DIR!;
  const config = loadConfig(process.env, process.env.ARCHLAST_DEV === "1");
  const project = await loadProject(convexDir);

  if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });
  const db = config.databaseUrl ? createPostgresDb(config.databaseUrl) : createSqliteDb(sqlitePath(config));
  await db.migrate(Object.entries(project.tables).map(([name, t]) => ({ name, indexes: t.indexes })));
  await migrateScheduler(db);

  const exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    storage: config.s3 ? new S3Storage(config.s3) : undefined,
    publish: (topics) => send({ t: "publish", topics }),
    log: (entry) => send({ t: "log", entry }),
  });
  const auth = createAuth(exec, project.tables, project.authOptions, config);
  const scheduler = new SchedulerLoop(exec, db, project.functions, project.crons);

  async function handle(msg: HostMessage): Promise<unknown> {
    switch (msg.t) {
      case "call":
        return exec.run(msg.name, msg.kind, msg.args, msg.headers);
      case "auth": {
        const { method, url, headers, body } = msg.req;
        const res = await auth.handler(new Request(url, { method, headers, body }));
        return { status: res.status, headers: [...res.headers], body: await res.text() } satisfies SerializedResponse;
      }
      case "docs":
        return (await exec.read((s) => s.query(msg.table).collect())).value.reverse().slice(0, msg.limit);
      case "scheduled":
        return db.query(`SELECT * FROM "_scheduled_functions" ORDER BY "scheduledTime" DESC LIMIT ?`, [msg.limit]);
    }
  }

  process.on("message", async (msg: HostMessage | { t: "shutdown" }) => {
    if (msg.t === "shutdown") {
      scheduler.stop();
      await db.close();
      process.exit(0);
    }
    try {
      send({ t: "result", id: msg.id, ok: true, value: await handle(msg) });
    } catch (e) {
      const err = e as Error;
      const code = err instanceof ValidationError || err?.name === "ValidationError" ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR";
      send({ t: "result", id: msg.id, ok: false, error: { message: err?.message ?? String(e), code } });
    }
  });

  scheduler.start();
  const manifest: Manifest = {
    functions: [...project.functions].map(([name, fn]) => ({ name, kind: fn.kind, args: fn.args })),
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
