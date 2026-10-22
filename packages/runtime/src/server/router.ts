import { initTRPC, TRPCError } from "@trpc/server";
import { timingSafeEqual } from "node:crypto";
import type { FunctionKind } from "../functions";
import type { CallHeaders, LogEntry } from "./executor";
import type { Manifest } from "./project";
import { RuntimeCallError, type FunctionRuntime } from "./runtime";
import type { QueryRunner, SubscriptionManager } from "./subscriptions";

export type Context = { headers: CallHeaders };

const t = initTRPC.context<Context>().create();

/** "admin/users:get" → ["admin", "users", "get"]; the client uses the same mapping. */
export const procedurePath = (name: string) => name.replace(":", "/").split("/");

const toTRPCError = (e: unknown) =>
  e instanceof RuntimeCallError ? new TRPCError({ code: e.code, message: e.message }) : new TRPCError({ code: "INTERNAL_SERVER_ERROR", message: String((e as Error)?.message ?? e) });

const guard = async <T>(fn: () => Promise<T>) => {
  try {
    return await fn();
  } catch (e) {
    throw toTRPCError(e);
  }
};

function setPath(tree: Record<string, any>, path: string[], value: unknown) {
  let node = tree;
  for (const seg of path.slice(0, -1)) node = node[seg] ??= {};
  node[path.at(-1)!] = value;
}

/** One tRPC procedure per function; queries also get a subscription under `_sub`. Args are validated in the runtime. */
export function buildRouter(manifest: Manifest, runtime: FunctionRuntime, queries: QueryRunner, subs: SubscriptionManager) {
  const tree: Record<string, any> = {};
  const subTree: Record<string, any> = {};
  const input = t.procedure.input((raw: unknown) => raw ?? {});
  for (const { name, kind } of manifest.functions) {
    const path = procedurePath(name);
    if (kind === "query") {
      setPath(tree, path, input.query(({ input, ctx }) => guard(async () => (await queries.run(name, input, ctx.headers)).value)));
      setPath(
        subTree,
        path,
        input.subscription(({ input, ctx, signal }) => subs.subscribe(name, input, ctx.headers, signal)),
      );
    } else {
      setPath(tree, path, input.mutation(({ input, ctx }) => guard(async () => (await runtime.call(name, kind, input, ctx.headers)).value)));
    }
  }
  return t.router({ ...tree, _sub: subTree });
}

export type AdminContext = { adminKey: string | null };

const a = initTRPC.context<AdminContext>().create();

export function buildAdminRouter(opts: {
  adminKey?: string;
  runtime: FunctionRuntime;
  subs: SubscriptionManager;
  logs: LogEntry[];
}) {
  const expected = opts.adminKey ? Buffer.from(opts.adminKey) : undefined;
  const authed = a.procedure.use(({ ctx, next }) => {
    const given = Buffer.from(ctx.adminKey ?? "");
    if (!expected) throw new TRPCError({ code: "FORBIDDEN", message: "Dashboard disabled: set ADMIN_KEY" });
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) throw new TRPCError({ code: "UNAUTHORIZED", message: "Invalid admin key" });
    return next();
  });
  const { runtime } = opts;
  return a.router({
    manifest: authed.query(() => runtime.manifest ?? { functions: [], tables: {}, crons: [], storage: false, error: runtime.loadError }),
    docs: authed
      .input((raw) => raw as { table: string; limit?: number })
      .query(({ input }) => guard(() => runtime.request({ t: "docs", table: input.table, limit: Math.min(input.limit ?? 100, 1000) }))),
    scheduled: authed.query(() => guard(() => runtime.request({ t: "scheduled", limit: 200 }))),
    run: authed
      .input((raw) => raw as { name: string; kind: FunctionKind; args: unknown })
      .mutation(({ input }) => guard(async () => (await runtime.call(input.name, input.kind, input.args, {})).value)),
    logs: authed.query(() => opts.logs),
    subscriptions: authed.query(() => opts.subs.list()),
  });
}

export type AdminRouter = ReturnType<typeof buildAdminRouter>;
