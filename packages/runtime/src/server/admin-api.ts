// The dashboard's API: POST for changes, GET (`?input=<json>`) for reads, each answered with the plain JSON result.
// Operations run in the function runtime, which owns the database; this file only checks who may call them.
import type { AdminInfo, AdminRole } from "./admin-ops";
import type { LogEntry } from "./executor";
import { toPublicError } from "./public-error";
import { errorResponse, HttpError, readJson } from "./rpc";
import type { FunctionRuntime } from "./runtime";
import type { SubscriptionManager } from "./subscriptions";

export type AdminContext = { admin: AdminInfo | null; requestId: string };

const RANK: Record<AdminRole, number> = { viewer: 0, admin: 1, owner: 2 };

/** Read operations (viewer) and write operations (admin), all served by the function runtime. */
const READ_OPS = ["docs", "docsByIds", "references", "counts", "scheduled", "crons", "files", "users", "sessions", "audit", "env", "logs", "metrics"] as const;
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
  Object.assign(ops, {
    me: { role: null, write: false, run: (_input, ctx) => ctx.admin },
    manifest: { role: "viewer", write: false, run: () => opts.runtime.manifest ?? { functions: [], tables: {}, crons: [], storage: false, error: opts.runtime.loadError } },
    subscriptions: { role: "viewer", write: false, run: () => opts.subs.list() },
    recentLogs: { role: "viewer", write: false, run: () => opts.recentLogs },
    server: { role: "viewer", write: false, run: () => opts.serverInfo() },
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
      const input = ((await readJson(req, "input", new URL(req.url))) ?? {}) as Input;
      return Response.json((await def.run(input, ctx as AdminContext & { admin: AdminInfo })) ?? null);
    } catch (e) {
      if (e instanceof HttpError) return errorResponse({ message: e.message, code: e.code, requestId: ctx.requestId });
      return errorResponse(toPublicError(e, ctx.requestId, true, { admin: op })); // admins see real messages
    }
  };
}

export type AdminApi = ReturnType<typeof buildAdminApi>;
