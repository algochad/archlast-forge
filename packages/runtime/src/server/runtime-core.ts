// The function runtime: forge/ modules, the database, auth and the scheduler. See startCore().
import { mkdirSync } from "node:fs";
import { validateFields } from "../values";
import { adminOp } from "./admin-ops";
import { createAuth } from "./auth";
import { AUDITED_COMMANDS, runCommand } from "./cli-ops";
import { loadConfig, sqlitePath } from "./config";
import { createPostgresDb } from "./db/postgres";
import { createSqliteDb } from "./db/sqlite";
import type { Db } from "./db/types";
import type { UserIdentity } from "../functions";
import { Executor, logContext, type CallHeaders, type LogEntry } from "./executor";
import { loadProject, tableSpecs, type Manifest, type Project } from "./project";
import { matchRoute, routeName } from "./http";
import type { HostEvent, HostMessage, HttpResponseMessage, RuntimeMessage, SerializedResponse } from "./protocol";
import { SchedulerLoop } from "./scheduler";
import { S3Storage } from "./storage";
import { migrateSystem } from "./system";
import { ReadCache } from "./read-cache";
import { annotate, inSpan, instrumentFetch, spanned, traced, type CallTelemetry } from "./telemetry/context";
import { MetricAggregator } from "./telemetry/metrics";
import { instanceId, processSampler } from "./telemetry/sampler";
import { releaseOf } from "./project";

/** Where a call's log lines go: the server, which streams them to the dashboard and keeps them in the telemetry store. */
let emit: (entry: LogEntry) => void = () => {};
let patched = false;

/** Function console output is attributed to the call that printed it. Once per process, whichever mode it runs in. */
function patchConsole() {
  if (patched) return;
  patched = true;
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    const ctx = logContext.getStore();
    if (ctx) {
      const message = args.map((a) => (typeof a === "string" ? a : Bun.inspect(a))).join(" ");
      const time = Date.now();
      emit({ time, name: ctx.name, level, message, requestId: ctx.requestId, traceId: ctx.trace?.traceId, spanId: ctx.spanId });
      ctx.logs?.push({ time, level, message });
      original(`[${ctx.name}]`, ...args);
    } else original(...args);
  };
  }
}

/** Names this process took from `_env`, so a later load can change or remove them. A variable that was in the process environment to begin with is never touched. */
const fromStore = new Set<string>();

/** Variables set with `archlast-forge env`; the process environment wins over them. Runs again on every reload. */
export async function loadEnv(db: Db) {
  const rows = await db.query<{ name: string; value: string }>(`SELECT "name", "value" FROM "_env"`);
  const wanted = new Set(rows.map((r) => r.name));
  for (const name of [...fromStore]) if (!wanted.has(name)) (delete process.env[name], fromStore.delete(name));
  for (const { name, value } of rows)
    if (process.env[name] === undefined || fromStore.has(name)) {
      process.env[name] = value;
      fromStore.add(name);
    }
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

export interface RuntimeCore {
  manifest: Manifest;
  handle(msg: HostMessage): Promise<unknown>;
  /** A socket event: given to whatever registered for them (the Nest bridge), or the socket is closed. */
  event(msg: HostEvent): void;
  shutdown(): Promise<void>;
}

/** Set by a project's @archlast/forge-runtime/nest: where socket events go. A global, because the project's copy of that package is not this module. */
const SOCKETS = Symbol.for("archlast-forge.sockets");
/** Set by the same package: where relayed PubSub events go. */
const RELAY = Symbol.for("archlast-forge.relay");
/** Marks a Response whose body is sent as it is written instead of when it ends. */
const STREAM = Symbol.for("archlast-forge.stream");

/**
 * Loads `forge/`, opens the database, migrates, and starts auth and the scheduler. The same core runs in a function-runtime process
 * (child.ts, behind IPC) or inside the server process (RUNTIME_MODE=inline); `send` carries what it publishes and logs to the server.
 */
export async function startCore(opts: {
  forgeDir: string;
  /** The engine's configuration. Functions read `process.env`, which is this same object outside tests. */
  env: Record<string, string | undefined>;
  worker: number;
  serverId: string;
  dev: boolean;
  send(msg: RuntimeMessage): void;
  /** Report this process's CPU, memory and event loop: in a child process; inline the server reports for both. */
  sample?: boolean;
}): Promise<RuntimeCore> {
  const { forgeDir, worker, serverId, send } = opts;
  patchConsole();
  instrumentFetch();
  emit = (entry: LogEntry) => send({ t: "log", entry });
  const instance = instanceId(serverId, opts.sample ? worker : undefined);
  // What forge/ code reaches through `trace` and `metrics` from @archlast/forge-runtime (a global: the project's copy of the package isn't this one).
  const metrics = new MetricAggregator();
  (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.telemetry")] = {
    span: (name: string, fn: () => unknown, attrs?: Record<string, string | number | boolean>) => inSpan(String(name), "custom", attrs, fn, 1),
    // For @archlast/forge-runtime/nest: the methods of the app's controllers and services, timed per call.
    wrap: <T extends (...args: any[]) => any>(fn: T, name: string, attrs?: Record<string, string | number | boolean>) => spanned(fn, name, "nest", attrs),
    annotate: (attrs: Record<string, string | number | boolean>, request?: boolean) => annotate(attrs, request),
    metric: (type: "counter" | "gauge" | "histogram", name: string, value: number, attrs?: Record<string, string | number | boolean>, unit?: string) => metrics.record(type, name, value, attrs, unit),
  };
  const sendMetrics = () => {
    const points = metrics.drain();
    if (points.length) send({ t: "metrics", points, instance });
  };
  const metricsTimer = setInterval(sendMetrics, 5000);
  const health = opts.sample ? processSampler() : undefined;
  const sampleTimer = health && setInterval(() => send({ t: "sample", sample: { time: Date.now(), instance, role: "runtime", ...health() } }), 10_000);
  const config = loadConfig(opts.env, opts.dev);

  if (!config.databaseUrl) mkdirSync(config.dataDir, { recursive: true });
  const db = config.databaseUrl ? createPostgresDb(config.databaseUrl) : createSqliteDb(sqlitePath(config));
  await migrateSystem(db);
  await loadEnv(db);
  const project = await loadProject(forgeDir);
  await db.migrate(tableSpecs(project.tables));
  const storage = config.s3 ? new S3Storage(config.s3) : undefined;
  const exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    storage,
    limits: config.limits,
    publish: (topics) => send({ t: "publish", topics }),
    log: emit,
    // Only this process writes the local database when it is the one function runtime, so its own writes keep the cache exact.
    readCache: !config.databaseUrl && config.runtimeWorkers === 1 ? new ReadCache() : undefined,
  });
  if (config.schemaCheck && worker === 0) await checkSchema(exec, project);
  // What @archlast/forge-runtime/nest reaches the engine through, for work that doesn't start as a call: gateway sockets and microservice messages.
  (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.host")] = {
    identityOf: (headers: CallHeaders) => exec.identityOf(headers),
    actionCtx: (identity: UserIdentity | null, requestId?: string) => exec.actionCtx({ getUserIdentity: async () => identity }, identity, requestId),
    wsSend: (sid: string, data: string | ArrayBuffer) => send({ t: "ws", op: "send", sid, data }),
    wsClose: (sid: string, code?: number, reason?: string) => send({ t: "ws", op: "close", sid, code, reason }),
    relay: (topic: string, payload: unknown) => send({ t: "relay", topic, payload }),
    worker,
  };
  const auth = createAuth(exec, project.tables, project.authOptions, config);
  // One scheduler per server: in a runtime pool only the first process polls.
  const scheduler =
    worker === 0
      ? new SchedulerLoop(exec, db, project.functions, project.crons, config.limits.actionTimeoutMs + 60_000, 500, config.logRetentionDays * 86_400_000, config.telemetry ? (trace) => send({ t: "trace", trace }) : undefined)
      : undefined;
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

  const isText = (bytes: ArrayBuffer) => {
    try {
      new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  };

  async function handle(msg: HostMessage): Promise<unknown> {
    switch (msg.t) {
      case "call":
        return exec.run(msg.name, msg.kind, msg.args, msg.headers, { allowInternal: msg.allowInternal, requestId: msg.requestId, identity: msg.identity, trace: msg.trace });
      case "identity":
        return exec.identityOf(msg.headers);
      case "auth": {
        const { method, url, headers, body } = msg.req;
        const { value: res, telemetry } = await traced(msg.trace, "auth", () => auth.handler(new Request(url, { method, headers, body })));
        const text = await res.text();
        return { status: res.status, headers: [...res.headers], body: text, ...(telemetry && { telemetry }) } satisfies SerializedResponse;
      }
      case "http": {
        const { method, url, headers, body } = msg.req;
        const found = matchRoute(project.http, method, new URL(url).pathname);
        const answer = (status: number, extra: [string, string][] = []): HttpResponseMessage => ({ status, headers: [["content-type", "text/plain"], ...extra], body: new TextEncoder().encode(status === 404 ? "Not found" : "Method not allowed").buffer as ArrayBuffer });
        if (!("route" in found)) return answer(found.status, found.status === 405 ? [["allow", found.allow.join(", ")]] : []);
        const route = found.route;
        let telemetry: CallTelemetry | undefined;
        const res = await traced(msg.trace, routeName(route), () => {
          // The route's pattern, for the request's name; a Nest controller names its own, finer one.
          annotate({ "http.route": route.path ?? `${route.pathPrefix}*` }, true);
          return exec.runHttp(routeName(route), route.handler, new Request(url, { method, headers, body }), msg.headers, msg.requestId);
        }).then((r) => ((telemetry = r.telemetry), r.value));
        const out = [...res.headers].filter(([k]) => k !== "content-length");
        if (res.body && ((res as unknown as Record<symbol, unknown>)[STREAM] || res.headers.get("content-type")?.startsWith("text/event-stream")))
          return { status: res.status, headers: out, body: res.body, stream: true, ...(telemetry && { telemetry }) } satisfies HttpResponseMessage;
        const blob = await res.blob();
        const bytes = await blob.arrayBuffer();
        // `new Response("text")` has no content-type header of its own: Bun.serve adds one when it sends. Passing the bytes along loses that,
        // so give text bodies the type the platform would have (binary bodies keep the default, and a handler can always set one).
        if (!out.some(([k]) => k === "content-type") && blob.type.startsWith("text/plain") && isText(bytes)) out.push(["content-type", blob.type]);
        return { status: res.status, headers: out, body: bytes, ...(telemetry && { telemetry }) } satisfies HttpResponseMessage;
      }
      case "admin":
        if (msg.op === "cli") return cli(msg.args as { cmd: string; args?: Record<string, unknown> });
        return adminOp(deps, msg.op, msg.args ?? {}, msg.actor);
    }
  }

  scheduler?.start();
  const manifest: Manifest = {
    functions: [...project.functions].map(([name, fn]) => ({ name, kind: fn.kind, visibility: fn.visibility ?? "public", args: fn.args, returns: fn.returns })),
    tables: project.tables,
    crons: project.crons,
    storage: Boolean(config.s3),
    release: releaseOf(forgeDir, opts.env),
  };
  function event(msg: HostEvent) {
    const take = (globalThis as Record<symbol, unknown>)[msg.t === "relay" ? RELAY : SOCKETS] as ((msg: HostEvent) => void) | undefined;
    if (take) return take(msg);
    if (msg.t === "ws" && msg.op === "open") send({ t: "ws", op: "close", sid: msg.sid, code: 1008, reason: "No WebSocket gateway at this path" });
  }

  return {
    manifest,
    handle,
    event,
    async shutdown() {
      scheduler?.stop();
      clearInterval(metricsTimer);
      clearInterval(sampleTimer);
      sendMetrics();
      await db.close();
    },
  };
}

