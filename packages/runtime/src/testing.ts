// Test helper for user code: run a project's functions against an in-memory database, no server.
//   const t = await createTestBackend("convex");
//   const id = await t.withIdentity({ email: "a@b.c" }).mutation(api.todos.add, { listId, title: "milk" });
import { resolve } from "node:path";
import { getFunctionName, type FunctionArgs, type FunctionReference, type FunctionReturn, type MutationCtx, type OptionalArgs, type UserIdentity } from "./functions";
import { createSqliteDb } from "./server/db/sqlite";
import { Executor } from "./server/executor";
import { loadProject, tableSpecs } from "./server/project";
import { SchedulerLoop } from "./server/scheduler";
import { migrateSystem } from "./server/system";

type Caller = {
  query<R extends FunctionReference<"query">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
  mutation<R extends FunctionReference<"mutation">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
  action<R extends FunctionReference<"action">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
};

export async function createTestBackend(convexDir = "convex") {
  const db = createSqliteDb(":memory:");
  await migrateSystem(db);
  const project = await loadProject(resolve(convexDir));
  await db.migrate(tableSpecs(project.tables));
  const exec = new Executor({ db, tables: project.tables, functions: project.functions, publish: () => {}, log: () => {} });
  const scheduler = new SchedulerLoop(exec, db, project.functions, []);

  const caller = (identity: UserIdentity | null): Caller => ({
    query: async (ref, ...args) => (await exec.call(getFunctionName(ref), "query", args[0] ?? {}, identity)).value as never,
    mutation: async (ref, ...args) => (await exec.call(getFunctionName(ref), "mutation", args[0] ?? {}, identity)).value as never,
    action: async (ref, ...args) => (await exec.call(getFunctionName(ref), "action", args[0] ?? {}, identity)).value as never,
  });

  return {
    ...caller(null),
    /** Calls as a signed-in user. Creates a `users` document unless `userId` is given. */
    async withIdentity(user: { email: string; name?: string; userId?: string }) {
      const userId =
        user.userId ??
        (await exec.mutate((s) => s.insert("users", { email: user.email, name: user.name ?? user.email, emailVerified: false, createdAt: Date.now(), updatedAt: Date.now() })));
      return caller({ userId: userId as UserIdentity["userId"], sessionId: "test", email: user.email, name: user.name ?? user.email });
    },
    /** Direct database access, e.g. to seed data or inspect it. */
    run<T>(fn: (ctx: Pick<MutationCtx, "db">) => Promise<T>) {
      return exec.mutate((s) => fn({ db: s.writer() as unknown as MutationCtx["db"] }));
    },
    /** Runs every scheduled function that's due (including ones scheduled meanwhile), as if time had passed. */
    async finishScheduledFunctions(maxRounds = 100) {
      for (let i = 0; i < maxRounds; i++) {
        const [{ n }] = (await db.query<{ n: number }>(`SELECT COUNT(*) AS n FROM "_scheduled_functions" WHERE "state" = 'pending'`)) as [{ n: number }];
        if (!Number(n)) return;
        await scheduler.tick(Number.MAX_SAFE_INTEGER);
      }
      throw new Error("Scheduled functions keep scheduling more; gave up");
    },
    close: () => db.close(),
  };
}

export type TestBackend = Awaited<ReturnType<typeof createTestBackend>>;
export type { FunctionArgs };
