// The function runtime: forge/ modules, the database, auth and the scheduler. See startCore().
import { docsRouting } from "../api-docs";
import { mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { validateFields } from "../values";
import { adminOp } from "./admin-ops";
import { createAuth } from "./auth";
import { AUDITED_COMMANDS, runCommand } from "./cli-ops";
import { loadConfig } from "./config";
import { openDatabase } from "./db/open";
import { describePlan } from "./db/pool-size";
import { serverMemory } from "./db/sqlite";
import type { Db } from "./db/types";
import type { UserIdentity } from "../functions";
import { Executor, logContext, serializeError, type CallHeaders, type LogEntry } from "./executor";
import { loadProject, tableSpecs, type Manifest, type Project } from "./project";
import { checkHttpRequest, matchRoute, routeName } from "./http";
import { buildOpenApi, docsWarnings, NEST_MOUNT, type NestRoute } from "./openapi";
import { LIGHT, LightResponse } from "./light";
import type { HostEvent, HostMessage, HttpResponseMessage, RuntimeMessage, SerializedResponse } from "./protocol";
import { SchedulerLoop } from "./scheduler";
import { createStorage } from "./storage";
import { Backups } from "./backup/backups";
import { migrateSystem } from "./system";
import { ReadCache } from "./read-cache";
import { annotate, inSpan, instrumentFetch, now, outboundSpan, spanned, telemetryOf, traced, type CallTelemetry } from "./telemetry/context";
import { parseTraceparent, spanId, traceId } from "./telemetry/ids";
import { handledKind, statusOf } from "./telemetry/recorder";
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
  if (problems.length) throw new Error(`Stored documents don't match the schema (fix them with a migration, or set SCHEMA_CHECK=off):\n  ${problems.join("\n  ")}`);
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
    // For Forge RPC's WebSocket client: the span and traceparent that a fetch would have got from the patched global fetch.
    outbound: (name: string, attrs: Record<string, string | number | boolean>) => outboundSpan(name, attrs),
    annotate: (attrs: Record<string, string | number | boolean>, request?: boolean) => annotate(attrs, request),
    // For @archlast/forge-runtime/nest: a message a microservice transport (Forge RPC among them) or a gateway handed the app is a request of
    // its own, a trace whose root is this call, under the caller's trace when it sent a traceparent.
    entry: async <T>(kind: "rpc" | "ws", operation: string, incoming: string | undefined, fn: () => Promise<T>): Promise<T> => {
      if (!config.telemetry) return fn();
      const caller = parseTraceparent(incoming);
      const root = { traceId: caller?.traceId ?? traceId(), parentId: spanId() };
      const weight = sampleDetail(caller);
      const start = now();
      let failure: unknown;
      let telemetry: CallTelemetry | undefined;
      try {
        if (!weight) return await fn();
        const out = await traced(root, operation, fn);
        telemetry = out.telemetry;
        return out.value;
      } catch (e) {
        failure = e;
        telemetry = telemetryOf(e);
        throw e;
      } finally {
        const err = failure === undefined ? undefined : serializeError(failure);
        const duration = now() - start;
        const attrs = { "forge.kind": kind };
        send({
          t: "trace",
          trace: {
            request: {
              traceId: root.traceId,
              spanId: root.parentId,
              time: start,
              duration,
              service: "",
              kind,
              operation,
              method: kind === "rpc" ? "RPC" : "WS",
              status: statusOf(err?.kind),
              error: err && { type: err.type ?? "Error", message: err.message, stack: err.stack, handled: handledKind(err.kind) },
              weight: 1,
              attrs,
            },
            spans: [
              { traceId: root.traceId, spanId: root.parentId, parentId: caller?.parentId, name: operation, type: "request", kind: 2, start, duration, status: err ? 2 : 1, error: err?.message, attrs },
              ...(telemetry?.spans ?? []),
            ],
            detailWeight: weight || 1,
          },
        });
      }
    },
    metric: (type: "counter" | "gauge" | "histogram", name: string, value: number, attrs?: Record<string, string | number | boolean>, unit?: string) =>
      metrics.record(type, name, value, attrs, unit),
  };
  // Messages handed to the app (entry below) recorded in detail, at most this process's share of TELEMETRY_DETAIL_PER_SECOND, as the server
  // does for the requests it records: past it a message is only counted, and those recorded stand for the rest in span statistics.
  const detail = { second: 0, count: 0, rate: 0 };
  const sampleDetail = (incoming: { sampled: boolean } | undefined) => {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== detail.second) [detail.rate, detail.second, detail.count] = [sec === detail.second + 1 ? detail.count : 0, sec, 0];
    detail.count++;
    const budget = config.telemetryDetailPerSecond / config.runtimeWorkers;
    const p = incoming?.sampled || detail.rate <= budget ? 1 : budget / detail.rate;
    return p >= 1 || Math.random() < p ? 1 / p : 0;
  };
  const sendMetrics = () => {
    const points = metrics.drain();
    if (points.length) send({ t: "metrics", points, instance });
  };
  const metricsTimer = setInterval(sendMetrics, 5000);
  const health = opts.sample ? processSampler() : undefined;
  const sampleTimer = health && setInterval(() => send({ t: "sample", sample: { time: Date.now(), instance, role: "runtime", ...health() } }), 10_000);
  const config = loadConfig(opts.env, opts.dev);

  if (config.databaseKind !== "postgres") mkdirSync(config.dataDir, { recursive: true });
  // Every function runtime process holds its own connections, so they share the RAM SQLite is given.
  // On Postgres the first process says what the pools hold against what the database allows, and warns when that is close to the limit.
  const db = await openDatabase(config, serverMemory() / config.runtimeWorkers, {
    plan: (plan) => {
      if (worker !== 0) return;
      const { level, message } = describePlan(plan);
      if (level === "warn") console.warn(message);
      else console.log(message);
    },
  });
  await migrateSystem(db);
  await loadEnv(db);
  const project = await loadProject(forgeDir);
  await db.migrate(tableSpecs(project.tables));
  const storage = createStorage(config);
  const exec = new Executor({
    db,
    tables: project.tables,
    functions: project.functions,
    storage,
    limits: config.limits,
    publish: (topics) => send({ t: "publish", topics }),
    log: emit,
    // Only this process writes the local database when it is the one function runtime, so its own writes keep the cache exact.
    readCache: config.databaseKind === "sqlite" && config.runtimeWorkers === 1 ? new ReadCache() : undefined,
    // Inside a call, so the warning is listed with the function that ran the query.
    devWarn: config.dev ? (message) => console.warn(message) : undefined,
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
    // What the engine's own routes allow, for what nest-graphql serves: development tools, and the origins that may call with credentials.
    dev: config.dev,
    trustedOrigins: [new URL(config.authUrl).origin, ...config.trustedOrigins],
  };
  const auth = createAuth(exec, project.tables, project.authOptions, config);
  // One scheduler per server: in a runtime pool only the first process polls.
  const scheduler =
    worker === 0
      ? new SchedulerLoop(
          exec,
          db,
          project.functions,
          project.crons,
          config.limits.actionTimeoutMs + 60_000,
          500,
          config.logRetentionDays * 86_400_000,
          config.telemetry ? (trace) => send({ t: "trace", trace }) : undefined,
        )
      : undefined;
  const release = releaseOf(forgeDir, opts.env);
  // Backups run in the first process, next to the scheduler: one place per server makes them, so the scheduled one runs once.
  const backups = worker === 0 ? new Backups({ db, exec, tables: project.tables, forgeDir, storage, config, env: opts.env, serverId, release }) : undefined;
  await backups?.recover();
  const backupTimer =
    backups &&
    setInterval(() => {
      void backups.tick().catch((e) => console.error(`backup schedule: ${(e as Error).message}`));
    }, 30_000);
  (backupTimer as { unref?: () => void } | undefined)?.unref?.();
  const deps = { db, exec, functions: project.functions, tables: project.tables, crons: project.crons, storage, serverId, backups, dev: opts.dev };

  /** CLI data commands, run here because this process holds the database. */
  async function cli({ cmd, args = {} }: { cmd: string; args?: Record<string, unknown> }) {
    const out = await runCommand({ config, db, project, exec, storage, forgeDir, env: opts.env, serverId, close: async () => {} }, cmd, args);
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

  const EMPTY = new Uint8Array(0);
  const strict = new TextDecoder("utf-8", { fatal: true });
  const isText = (bytes: ArrayBuffer) => {
    try {
      strict.decode(bytes);
      return true;
    } catch {
      return false;
    }
  };

  async function handle(msg: HostMessage): Promise<unknown> {
    switch (msg.t) {
      case "call":
        return exec.run(msg.name, msg.kind, msg.args, msg.headers, {
          allowInternal: msg.allowInternal,
          requestId: msg.requestId,
          identity: msg.identity,
          trace: msg.trace,
          access: msg.access,
        });
      case "identity":
        return msg.detail ? exec.identityDetailOf(msg.headers) : exec.identityOf(msg.headers);
      case "auth": {
        const { method, url, headers, body } = msg.req;
        const { value: res, telemetry } = await traced(msg.trace, "auth", () => auth.handler(new Request(url, { method, headers, body })));
        const text = await res.text();
        return { status: res.status, headers: [...res.headers], body: text, ...(telemetry && { telemetry }) } satisfies SerializedResponse;
      }
      case "http": {
        const { method, url, headers, body } = msg.req;
        const pathname = msg.req.path ?? new URL(url).pathname;
        const found = matchRoute(project.http, method, pathname);
        const answer = (status: number, extra: [string, string][] = []): HttpResponseMessage => ({
          status,
          headers: [["content-type", "text/plain"], ...extra],
          body: new TextEncoder().encode(status === 404 ? "Not found" : "Method not allowed").buffer as ArrayBuffer,
        });
        if (!("route" in found)) return answer(found.status, found.status === 405 ? [["allow", found.allow.join(", ")]] : []);
        const route = found.route;
        // A route that declares its query or body answers 400 for a request that doesn't match, before its handler runs.
        const invalid = checkHttpRequest(route, url, body);
        if (invalid)
          return {
            status: 400,
            headers: [["content-type", "application/json"]],
            body: new TextEncoder().encode(JSON.stringify({ error: { code: "BAD_REQUEST", message: invalid, requestId: msg.requestId } })).buffer as ArrayBuffer,
          };
        let telemetry: CallTelemetry | undefined;
        const name = routeName(route);
        const run = () => {
          // The route's pattern, for the request's name; a Nest controller names its own, finer one.
          annotate({ "http.route": route.path ?? `${route.pathPrefix}*` }, true);
          // A route that can do without Web objects (Nest's mount) is given the fields of the request and answers with its own.
          const light = (route.handler as unknown as Record<symbol, unknown>)[LIGHT] === true;
          return exec.runHttp(
            name,
            route.handler,
            light ? { method, url, path: pathname, search: msg.req.search ?? new URL(url).search, headers, body } : new Request(url, { method, headers, body }),
            msg.headers,
            msg.requestId,
          );
        };
        let res: Response | LightResponse;
        if (msg.trace) {
          const traced_ = await traced(msg.trace, name, run);
          telemetry = traced_.telemetry;
          res = traced_.value;
        } else res = await run(); // a request that is only counted runs untraced: nothing to collect
        if (res instanceof LightResponse) {
          const out = res.headers.filter((h) => h[0] !== "content-length");
          const reply: HttpResponseMessage = { status: res.status, headers: out, body: res.body ?? EMPTY };
          if ((route.handler as unknown as Record<symbol, unknown>)[NEST_MOUNT] === true) reply.nest = true;
          if (telemetry) reply.telemetry = telemetry;
          return reply;
        }
        const out: [string, string][] = [];
        let typed = false;
        for (const h of res.headers) {
          if (h[0] === "content-length") continue;
          if (h[0] === "content-type") typed = true;
          out.push(h);
        }
        const reply: HttpResponseMessage = { status: res.status, headers: out, body: undefined as never };
        if ((route.handler as unknown as Record<symbol, unknown>)[NEST_MOUNT] === true) reply.nest = true;
        if (telemetry) reply.telemetry = telemetry;
        if (res.body && ((res as unknown as Record<symbol, unknown>)[STREAM] || res.headers.get("content-type")?.startsWith("text/event-stream"))) {
          reply.body = res.body;
          reply.stream = true;
          return reply;
        }
        // `new Response("text")` has no content-type header of its own: Bun.serve adds one when it sends. Passing the bytes along loses that,
        // so give text bodies the type the platform would have (binary bodies keep the default, and a handler can always set one). A response that
        // has a type already needs no blob to say so.
        if (typed) {
          reply.body = await res.arrayBuffer();
          return reply;
        }
        const blob = await res.blob();
        const bytes = await blob.arrayBuffer();
        if (blob.type.startsWith("text/plain") && isText(bytes)) out.push(["content-type", blob.type]);
        reply.body = bytes;
        return reply;
      }
      case "admin":
        if (msg.op === "cli") return cli(msg.args as { cmd: string; args?: Record<string, unknown> });
        if (msg.op === "openapi") return openApi((msg.args as { audience?: "public" | "all" } | undefined)?.audience);
        return adminOp(deps, msg.op, msg.args ?? {}, msg.actor);
    }
  }

  scheduler?.start();
  // The folder around forge/, whose package.json names the project.
  const projectRootOf = (dir: string) => (["forge", "convex"].includes(basename(dir)) ? dirname(dir) : dir);
  /** The OpenAPI document: the manifest's functions, forge/http.ts's routes and, once the Nest app has started, its controllers' routes. */
  let warned = false;
  const openApi = async (audience: "public" | "all" = "public") => {
    const nestRoutes = (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.nest-routes")] as (() => Promise<NestRoute[]>) | undefined;
    let title = basename(projectRootOf(forgeDir));
    try {
      title = JSON.parse(readFileSync(join(projectRootOf(forgeDir), "package.json"), "utf8")).name || title;
    } catch {}
    const doc = buildOpenApi({ title, version: release, functions: manifest.functions, http: project.http, httpRoot: project.httpRoot, nest: (await nestRoutes?.().catch(() => [])) ?? [], docs: project.docs, audience });
    // In development, once per load: what a reader of the public docs would miss.
    if (opts.dev && !warned && audience === "public") {
      warned = true;
      const missing = docsWarnings(doc);
      if (missing.length) console.warn(`[api docs] ${missing.length} documented route${missing.length === 1 ? " has" : "s have"} gaps a reader will notice:\n  ${missing.join("\n  ")}`);
    }
    return doc;
  };

  const manifest: Manifest = {
    functions: [...project.functions].map(([name, fn]) => ({
      name,
      kind: fn.kind,
      visibility: fn.visibility ?? "public",
      args: fn.args,
      returns: fn.returns,
      ...(fn.access && { access: true }),
    })),
    tables: project.tables,
    crons: project.crons,
    storage: Boolean(storage),
    release,
    // What the server matches at the root before handing a path to the pages: just the patterns, for a router with root: true.
    docs: docsRouting(project.docs, config.apiDocsPath),
    ...(project.helmet && { helmet: project.helmet }),
    ...(project.httpRoot && { rootRoutes: project.http.map((r) => ({ method: r.method, ...(r.path !== undefined ? { path: r.path } : { pathPrefix: r.pathPrefix }) })) }),
  };
  function event(msg: HostEvent) {
    // Another process writing would make cached rows stale: a fresh cache only once this one is the only writer again.
    if (msg.t === "pool") return exec.setReadCache(config.databaseKind === "sqlite" && msg.workers === 1 ? new ReadCache() : undefined);
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
      clearInterval(backupTimer);
      clearInterval(metricsTimer);
      clearInterval(sampleTimer);
      sendMetrics();
      await db.close();
    },
  };
}
