import { initTRPC, TRPCError } from "@trpc/server";
import type { AdminInfo, AdminRole } from "./admin-ops";
import type { CallHeaders, LogEntry } from "./executor";
import type { Manifest } from "./project";
import { toPublicError } from "./public-error";
import type { FunctionRuntime } from "./runtime";
import type { QueryRunner, SubscriptionManager } from "./subscriptions";

export type Context = {
  headers: CallHeaders;
  requestId: string;
  /** Per WebSocket connection, for the subscription cap. */
  conn?: { subscriptions: number };
};

/** "admin/users:get" → ["admin", "users", "get"]; the client uses the same mapping. */
export const procedurePath = (name: string) => name.replace(":", "/").split("/");

function setPath(tree: Record<string, any>, path: string[], value: unknown) {
  let node = tree;
  for (const seg of path.slice(0, -1)) node = node[seg] ??= {};
  node[path.at(-1)!] = value;
}

type ErrorCause = { forge: { data?: unknown; requestId: string } };

const formatter = ({ shape, error }: { shape: any; error: TRPCError }) => {
  const forge = (error.cause as unknown as ErrorCause | undefined)?.forge;
  const { stack: _stack, ...data } = shape.data ?? {};
  return { ...shape, data: { ...data, ...(forge && { forge }) } };
};

export interface RouterOptions {
  dev: boolean;
  maxSubscriptionsPerConnection: number;
}

/** One tRPC procedure per public function; queries also get a subscription under `_sub`. Args are validated in the runtime. */
export function buildRouter(manifest: Manifest, runtime: FunctionRuntime, queries: QueryRunner, subs: SubscriptionManager, opts: RouterOptions) {
  const t = initTRPC.context<Context>().create({ isDev: opts.dev, errorFormatter: formatter });
  const guard = async <T>(ctx: Context, name: string, fn: () => Promise<T>) => {
    try {
      return await fn();
    } catch (e) {
      const err = toPublicError(e, ctx.requestId, opts.dev, { function: name });
      throw new TRPCError({ code: err.code, message: err.message, cause: { forge: { data: err.data, requestId: err.requestId } } as any });
    }
  };
  const tree: Record<string, any> = {};
  const subTree: Record<string, any> = {};
  const input = t.procedure.input((raw: unknown) => raw ?? {});
  for (const { name, kind, visibility } of manifest.functions) {
    if (visibility === "internal") continue;
    const path = procedurePath(name);
    if (kind === "query") {
      setPath(tree, path, input.query(({ input, ctx }) => guard(ctx, name, async () => (await queries.run(name, input, ctx.headers, ctx.requestId)).value)));
      setPath(
        subTree,
        path,
        input.subscription(async function* ({ input, ctx, signal }) {
          const conn = ctx.conn ?? { subscriptions: 0 };
          if (conn.subscriptions >= opts.maxSubscriptionsPerConnection)
            throw new TRPCError({ code: "TOO_MANY_REQUESTS", message: `At most ${opts.maxSubscriptionsPerConnection} subscriptions per connection` });
          conn.subscriptions++;
          try {
            yield* subs.subscribe(name, input, ctx.headers, signal, ctx.requestId);
          } finally {
            conn.subscriptions--;
          }
        }),
      );
    } else {
      setPath(
        tree,
        path,
        input.mutation(({ input, ctx }) => guard(ctx, name, async () => (await runtime.call(name, kind, input, ctx.headers, { requestId: ctx.requestId })).value)),
      );
    }
  }
  return t.router({ ...tree, _sub: subTree });
}

// ---- admin API ----

export type AdminContext = { admin: AdminInfo | null; requestId: string };

const RANK: Record<AdminRole, number> = { viewer: 0, admin: 1, owner: 2 };

/** Read operations (viewer) and write operations (admin), all served by the function runtime. */
const READ_OPS = ["docs", "counts", "scheduled", "crons", "files", "users", "sessions", "audit", "env", "logs", "metrics"] as const;
const WRITE_OPS = ["insertDoc", "patchDoc", "replaceDoc", "deleteDoc", "cancelJob", "retryJob", "deleteFile", "revokeSession", "banUser", "run"] as const;

export function buildAdminRouter(opts: {
  runtime: FunctionRuntime;
  subs: SubscriptionManager;
  recentLogs: LogEntry[];
  dev: boolean;
  serverInfo: () => object;
  reload: () => Promise<unknown>;
}) {
  const a = initTRPC.context<AdminContext>().create({ isDev: opts.dev, errorFormatter: formatter });
  const as = (role: AdminRole) =>
    a.procedure.use(({ ctx, next }) => {
      if (!ctx.admin) throw new TRPCError({ code: "UNAUTHORIZED", message: "Sign in to the dashboard" });
      if (RANK[ctx.admin.role] < RANK[role]) throw new TRPCError({ code: "FORBIDDEN", message: `Requires the ${role} role` });
      return next({ ctx: { ...ctx, admin: ctx.admin } });
    });
  const forward = (op: string, role: AdminRole) =>
    as(role)
      .input((raw) => (raw ?? {}) as Record<string, unknown>)
      [role === "viewer" ? "query" : "mutation"](async ({ input, ctx }) => {
        try {
          return await opts.runtime.admin(op, { ...input, requestId: ctx.requestId }, ctx.admin.email);
        } catch (e) {
          const err = toPublicError(e, ctx.requestId, true, { admin: op }); // admins see real messages
          throw new TRPCError({ code: err.code, message: err.message });
        }
      });
  const ops: Record<string, any> = {};
  for (const op of READ_OPS) ops[op] = forward(op, "viewer");
  for (const op of WRITE_OPS) ops[op] = forward(op, "admin");
  return a.router({
    ...ops,
    me: a.procedure.query(({ ctx }) => ctx.admin),
    manifest: as("viewer").query(() => opts.runtime.manifest ?? { functions: [], tables: {}, crons: [], storage: false, error: opts.runtime.loadError }),
    subscriptions: as("viewer").query(() => opts.subs.list()),
    recentLogs: as("viewer").query(() => opts.recentLogs),
    server: as("viewer").query(() => opts.serverInfo()),
    /** Restarts this server's function runtime, e.g. to pick up `archlast-forge env` changes. */
    reload: as("admin").mutation(async () => {
      await opts.reload();
      return true;
    }),
  });
}

export type AdminRouter = ReturnType<typeof buildAdminRouter>;
