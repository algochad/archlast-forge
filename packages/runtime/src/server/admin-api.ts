// The dashboard's API: POST for changes, GET (`?input=<json>`) for reads, each answered with the plain JSON result.
// Operations run in the function runtime, which owns the database; this file only checks who may call them.
import type { AdminInfo, AdminRole } from "./admin-ops";
import type { LogEntry } from "./executor";
import { toPublicError } from "./public-error";
import { errorResponse, HttpError, readJson } from "./rpc";
import type { FunctionRuntime } from "./runtime";
import type { SubscriptionManager } from "./subscriptions";
import type { TelemetryClient } from "./telemetry/client";

export type AdminContext = { admin: AdminInfo | null; requestId: string };

const RANK: Record<AdminRole, number> = { viewer: 0, admin: 1, owner: 2 };

/** Read operations (viewer) and write operations (admin), all served by the function runtime. */
const READ_OPS = ["docs", "docsByIds", "references", "counts", "scheduled", "crons", "files", "users", "sessions", "audit", "env", "backups.list"] as const;

/** The observability pages' reads, answered by the telemetry store (`obs.<name>`), and what changes there with the role it needs. */
const OBS_READS = [
  "overview",
  "requests",
  "jobs",
  "operation",
  "trace",
  "errors",
  "error",
  "users",
  "user",
  "spans",
  "span",
  "hotspots",
  "nodes",
  "map",
  "runtime",
  "metrics",
  "releases",
  "services",
  "logs",
  "search",
  "slos",
  "alertRules",
  "alertEvents",
  "notifications",
  "keys",
] as const;
const OBS_WRITES: Record<string, AdminRole> = {
  setErrorState: "admin",
  saveSlo: "admin",
  deleteSlo: "admin",
  saveAlertRule: "admin",
  deleteAlertRule: "admin",
  testAlert: "admin",
  createKey: "admin",
  revokeKey: "admin",
  markSeen: "viewer",
};
const WRITE_OPS = ["insertDoc", "patchDoc", "replaceDoc", "deleteDoc", "cancelJob", "retryJob", "deleteFile", "revokeSession", "banUser", "run"] as const;

type Input = Record<string, unknown>;
type Operation = { role: AdminRole | null; write: boolean; run(input: Input, ctx: AdminContext & { admin: AdminInfo }): unknown };

export function buildAdminApi(opts: {
  runtime: FunctionRuntime;
  subs: SubscriptionManager;
  recentLogs: LogEntry[];
  serverInfo: () => object;
  reload: () => Promise<unknown>;
  cache: () => object;
  clearCache: () => Promise<number>;
  customFunctions: boolean;
  /** The telemetry store; without it (TELEMETRY=off) the observability operations say so. */
  telemetry?: TelemetryClient;
  /** Lines of the project's source around a stack frame. */
  source?: (file: string, line: number) => unknown;
  /** Every engine setting with where its value comes from. */
  settings: () => Promise<unknown>;
  /** Checks a setting (would the engine start with it?) and stores it; null removes it. */
  saveSetting: (name: string, value: string | null, actor: string) => Promise<unknown>;
  /** Restarts the whole server in this process, when its host can (the CLI can). */
  restart?: () => void;
  /** The security headers (Helmet): what each surface sends, the CSP reports, and a change of the dashboard's part (live, saved). */
  security: {
    info: () => Promise<unknown>;
    save: (input: Input, actor: string) => Promise<unknown>;
    clearReports: () => void;
  };
  maxRequestBytes: number;
  /** This app's name in telemetry and its microservices (MICROSERVICES), which its dashboard can show. */
  microservices?: () => { self: string; services: { name: string; url: string }[] };
}) {
  const forward = (op: string, role: AdminRole, allowed = true): Operation => ({
    role,
    write: role !== "viewer",
    run: (input, ctx) => {
      if (!allowed) throw new HttpError("FORBIDDEN", "Custom functions are off. Set ALLOW_CUSTOM_FUNCTIONS=on to allow owners to run them.");
      return opts.runtime.admin(op, { ...input, requestId: ctx.requestId }, ctx.admin.email);
    },
  });
  const ops: Record<string, Operation> = {};
  for (const op of READ_OPS) ops[op] = forward(op, "viewer");
  for (const op of WRITE_OPS) ops[op] = forward(op, "admin");
  // Arbitrary code runs with the function runtime's privileges, so it takes the top role, not just an admin's.
  ops.runCustom = forward("runCustom", "owner", opts.customFunctions);
  // Anyone who can sign in may take a backup. Restoring and deleting one, and the variables and settings (secrets among them), are the owner's.
  ops["backups.create"] = forward("backups.create", "admin");
  for (const op of ["backups.restore", "backups.delete", "env.set", "env.remove"]) ops[op] = forward(op, "owner");
  const telemetry = () => {
    if (!opts.telemetry) throw new HttpError("NOT_FOUND", "Telemetry is off (TELEMETRY=off), so there is nothing to show here");
    return opts.telemetry;
  };
  for (const op of OBS_READS) ops[`obs.${op}`] = { role: "viewer", write: false, run: (input) => telemetry().call(op, input) };
  for (const [op, role] of Object.entries(OBS_WRITES))
    ops[`obs.${op}`] = {
      role,
      write: true,
      run: async (input, ctx) => {
        const out = await telemetry().call(op, input, ctx.admin.email);
        // Into the same audit log as data changes (the runtime keeps it); a key's value is never in it, only its name.
        if (op !== "markSeen")
          void opts.runtime
            .admin(
              "recordAudit",
              { action: `obs.${op}`, target: String(input.id ?? input.name ?? input.fingerprint ?? "") || null, details: JSON.stringify({ ...input, webhook: undefined }).slice(0, 2000) },
              ctx.admin.email,
            )
            .catch(() => {});
        return out;
      },
    };
  ops["obs.source"] = { role: "viewer", write: false, run: (input) => opts.source?.(String(input.file ?? ""), Number(input.line) || 1) ?? null };
  Object.assign(ops, {
    me: { role: null, write: false, run: (_input, ctx) => ctx.admin },
    manifest: { role: "viewer", write: false, run: () => opts.runtime.manifest ?? { functions: [], tables: {}, crons: [], storage: false, error: opts.runtime.loadError } },
    subscriptions: { role: "viewer", write: false, run: () => opts.subs.list() },
    recentLogs: { role: "viewer", write: false, run: () => opts.recentLogs },
    server: { role: "viewer", write: false, run: () => opts.serverInfo() },
    microservices: { role: "viewer", write: false, run: () => opts.microservices?.() ?? { self: "", services: [] } },
    /** This server's query cache: contents and per-function counters. */
    cache: { role: "viewer", write: false, run: () => opts.cache() },
    /** Empties this server's cache (or the shared Redis cache) and records it in the audit log. */
    clearCache: {
      role: "admin",
      write: true,
      run: async (_input, ctx) => {
        const entries = await opts.clearCache();
        await opts.runtime.admin("clearCache", { entries, requestId: ctx.requestId }, ctx.admin.email);
        return entries;
      },
    },
    /** Restarts this server's function runtime, e.g. to pick up `archlast-forge env` changes. */
    reload: { role: "admin", write: true, run: async () => (await opts.reload(), true) },
    settings: { role: "viewer", write: false, run: () => opts.settings() },
    security: { role: "viewer", write: false, run: () => opts.security.info() },
    /** What reaches the app's visitors and the dashboard's: the owner's, like the other settings. */
    "security.save": { role: "owner", write: true, run: (input, ctx) => opts.security.save(input, ctx.admin.email) },
    "security.clearReports": { role: "admin", write: true, run: () => (opts.security.clearReports(), true) },
    saveSetting: {
      role: "owner",
      write: true,
      run: (input, ctx) => opts.saveSetting(String(input.name ?? ""), input.value === null || input.value === undefined ? null : String(input.value), ctx.admin.email),
    },
    /** Restarts the whole server, which applies saved settings; the dashboard reconnects when it is back. */
    restart: {
      role: "owner",
      write: true,
      run: async (_input, ctx) => {
        if (!opts.restart) throw new HttpError("BAD_REQUEST", "This server can't restart itself: restart its process or container to apply the settings");
        await opts.runtime.admin("recordAudit", { action: "restart", target: null, details: "{}" }, ctx.admin.email).catch(() => {});
        setTimeout(opts.restart, 250); // after this answer has gone out
        return { restarting: true };
      },
    },
  } satisfies Record<string, Operation>);

  return async (op: string, req: Request, ctx: AdminContext): Promise<Response> => {
    try {
      const def = Object.hasOwn(ops, op) ? ops[op] : undefined;
      if (!def) throw new HttpError("NOT_FOUND", `No admin operation "${op}"`);
      if ((req.method === "POST") !== def.write || !["GET", "POST"].includes(req.method)) throw new HttpError("METHOD_NOT_ALLOWED", `${op} takes ${def.write ? "POST" : "GET"}`);
      if (def.role) {
        if (!ctx.admin) throw new HttpError("UNAUTHORIZED", "Sign in to the dashboard");
        if (RANK[ctx.admin.role] < RANK[def.role]) throw new HttpError("FORBIDDEN", `Requires the ${def.role} role`);
      }
      const input = ((await readJson(req, "input", new URL(req.url), opts.maxRequestBytes)) ?? {}) as Input;
      return Response.json((await def.run(input, ctx as AdminContext & { admin: AdminInfo })) ?? null);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse({ message: e.message, code: e.code, requestId: ctx.requestId });
      return errorResponse(toPublicError(e, ctx.requestId, true, { admin: op })); // admins see real messages
    }
  };
}

export type AdminApi = ReturnType<typeof buildAdminApi>;
