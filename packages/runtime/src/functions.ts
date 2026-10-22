import type { BetterAuthOptions } from "better-auth";
import type {
  Doc,
  IndexFields,
  IndexNames,
  TableNames,
  WithoutSystemFields,
} from "./schema";
import type { Id, ObjectType, PropertyValidators } from "./values";

export type FunctionKind = "query" | "mutation" | "action";

// ---- database ----

export interface IndexRange {
  readonly __indexRange: true;
}

type Tail<T extends readonly unknown[]> = T extends readonly [any, ...infer R] ? R : T;

export interface IndexRangeBuilder<D, Fields extends readonly string[]> extends IndexRange {
  /** Only the index's fields, in order, can be compared. */
  eq<F extends Fields[0] & keyof D>(field: F, value: D[F]): IndexRangeBuilder<D, Tail<Fields>>;
}

export interface Query<D> {
  collect(): Promise<D[]>;
  first(): Promise<D | null>;
  take(n: number): Promise<D[]>;
}

export interface QueryInitializer<T extends TableNames> extends Query<Doc<T>> {
  withIndex<I extends IndexNames<T>>(
    index: I,
    range?: (q: IndexRangeBuilder<Doc<T>, IndexFields<T, I>>) => IndexRange,
  ): Query<Doc<T>>;
}

export interface DatabaseReader {
  get<T extends TableNames>(id: Id<T>): Promise<Doc<T> | null>;
  query<T extends TableNames>(table: T): QueryInitializer<T>;
}

export interface DatabaseWriter extends DatabaseReader {
  insert<T extends TableNames>(table: T, value: WithoutSystemFields<Doc<T>>): Promise<Id<T>>;
  /** Shallow merge; a field set to `undefined` is removed. */
  patch<T extends TableNames>(id: Id<T>, value: Partial<WithoutSystemFields<Doc<T>>>): Promise<void>;
  replace<T extends TableNames>(id: Id<T>, value: WithoutSystemFields<Doc<T>>): Promise<void>;
  delete(id: Id<TableNames>): Promise<void>;
}

// ---- auth, storage, scheduler ----

export interface UserIdentity {
  userId: Id<"users">;
  sessionId: string;
  email: string;
  name: string;
}

export interface Auth {
  getUserIdentity(): Promise<UserIdentity | null>;
}

export interface StorageReader {
  /** Presigned download URL, or null if the file doesn't exist. */
  getUrl(id: Id<"_storage">): Promise<string | null>;
}

export interface StorageWriter extends StorageReader {
  /** Creates the `_storage` row and a presigned PUT URL; the client uploads directly to S3. */
  generateUploadUrl(opts?: { contentType?: string }): Promise<{ uploadUrl: string; storageId: Id<"_storage"> }>;
  delete(id: Id<"_storage">): Promise<void>;
}

export interface Scheduler {
  runAfter<R extends FunctionReference<"mutation" | "action">>(delayMs: number, ref: R, ...args: OptionalArgs<R>): Promise<string>;
  runAt<R extends FunctionReference<"mutation" | "action">>(timestamp: number, ref: R, ...args: OptionalArgs<R>): Promise<string>;
  cancel(id: string): Promise<void>;
}

export interface QueryCtx {
  db: DatabaseReader;
  auth: Auth;
  storage: StorageReader;
}

export interface MutationCtx {
  db: DatabaseWriter;
  auth: Auth;
  storage: StorageWriter;
  scheduler: Scheduler;
}

/** No `db`: actions do external I/O and reach the database only through queries and mutations. */
export interface ActionCtx {
  auth: Auth;
  storage: StorageWriter;
  scheduler: Scheduler;
  runQuery<R extends FunctionReference<"query">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
  runMutation<R extends FunctionReference<"mutation">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
  runAction<R extends FunctionReference<"action">>(ref: R, ...args: OptionalArgs<R>): Promise<FunctionReturn<R>>;
}

type CtxFor<K extends FunctionKind> = K extends "query" ? QueryCtx : K extends "mutation" ? MutationCtx : ActionCtx;

// ---- registration ----

declare const fnTypes: unique symbol;

export interface RegisteredFunction<K extends FunctionKind = FunctionKind, Args = any, Return = any> {
  readonly kind: K;
  readonly args: PropertyValidators;
  readonly handler: (ctx: any, args: any) => unknown;
  readonly [fnTypes]?: { args: Args; return: Return };
}

type Definition<K extends FunctionKind, A extends PropertyValidators, R> = {
  args?: A;
  handler: (ctx: CtxFor<K>, args: ObjectType<A>) => R;
};

const define =
  <K extends FunctionKind>(kind: K) =>
  <A extends PropertyValidators = {}, R = unknown>(def: Definition<K, A, R>): RegisteredFunction<K, ObjectType<A>, Awaited<R>> => ({
    kind,
    args: def.args ?? {},
    handler: def.handler,
  });

export const query = define("query");
export const mutation = define("mutation");
export const action = define("action");

// ---- references, as produced by codegen ----

declare const refTypes: unique symbol;

export interface FunctionReference<K extends FunctionKind = FunctionKind, Args = any, Return = any> {
  readonly [refTypes]?: { kind: K; args: Args; return: Return };
}

export type FunctionArgs<R> = R extends FunctionReference<any, infer A, any> ? A : never;
export type FunctionReturn<R> = R extends FunctionReference<any, any, infer T> ? T : never;
/** Args may be omitted when the function takes none. */
export type OptionalArgs<R> = keyof FunctionArgs<R> extends never ? [args?: FunctionArgs<R>] : [args: FunctionArgs<R>];

export type ModuleRefs<M> = {
  [K in keyof M as M[K] extends RegisteredFunction ? K : never]: M[K] extends RegisteredFunction<infer Kind, infer A, infer R>
    ? FunctionReference<Kind, A, R>
    : never;
};

function refProxy(path: string[]): any {
  return new Proxy(
    {},
    {
      get(_, prop) {
        if (prop === "_name") return path.length > 1 ? `${path.slice(0, -1).join("/")}:${path.at(-1)}` : undefined;
        if (typeof prop !== "string" || prop === "then" || prop === "toJSON") return undefined;
        return refProxy([...path, prop]);
      },
    },
  );
}

/** `anyApi.todos.add` is a reference to "todos:add"; codegen gives it a precise type. */
export const anyApi: any = refProxy([]);

export function getFunctionName(ref: FunctionReference | string): string {
  const name = typeof ref === "string" ? ref : (ref as { _name?: unknown })._name;
  if (typeof name !== "string" || !name.includes(":")) throw new Error("Expected a function reference like api.module.fn");
  return name;
}

// ---- auth config ----

export type AuthOptions = Omit<BetterAuthOptions, "database" | "secret" | "baseURL">;

/** Default export of `convex/auth.ts`. Without that file, email and password sign-in is enabled. */
export const defineAuth = (options: AuthOptions): AuthOptions => options;

// ---- crons ----

export type CronSchedule = { kind: "interval"; ms: number } | { kind: "cron"; expression: string };

export interface CronJob {
  name: string;
  schedule: CronSchedule;
  fn: string;
  args: Record<string, unknown>;
}

export function cronJobs() {
  const jobs: CronJob[] = [];
  const add = (name: string, schedule: CronSchedule, ref: FunctionReference<"mutation" | "action">, args: object = {}) => {
    if (jobs.some((j) => j.name === name)) throw new Error(`Duplicate cron job "${name}"`);
    jobs.push({ name, schedule, fn: getFunctionName(ref), args: args as Record<string, unknown> });
  };
  return {
    jobs,
    interval<R extends FunctionReference<"mutation" | "action">>(
      name: string,
      every: { seconds?: number; minutes?: number; hours?: number },
      ref: R,
      ...args: OptionalArgs<R>
    ) {
      const ms = ((every.hours ?? 0) * 3600 + (every.minutes ?? 0) * 60 + (every.seconds ?? 0)) * 1000;
      if (ms < 1000) throw new Error(`Cron "${name}" interval must be at least one second`);
      add(name, { kind: "interval", ms }, ref, args[0]);
    },
    /** Standard 5-field cron expression, evaluated in UTC. */
    cron<R extends FunctionReference<"mutation" | "action">>(name: string, expression: string, ref: R, ...args: OptionalArgs<R>) {
      add(name, { kind: "cron", expression }, ref, args[0]);
    },
  };
}
