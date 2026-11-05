import type { HelmetOptions } from "helmet";
import { checkDocsConfig, type ApiDocsConfig, type RouteDocs } from "./api-docs";

/** Helmet's options per surface, or false for no security headers there. */
export type HelmetConfig = { api?: HelmetOptions | false; app?: HelmetOptions | false; dashboard?: HelmetOptions | false };
import type { BetterAuthOptions } from "better-auth";
import type {
  Doc,
  IndexFields,
  IndexNames,
  SearchIndexConfig,
  SearchIndexNames,
  TableNames,
  WithoutSystemFields,
} from "./schema";
import type { Expand, Id, Infer, ObjectType, PropertyValidators, Validator } from "./values";

export type FunctionKind = "query" | "mutation" | "action";

// ---- database ----

export interface IndexRange {
  readonly __indexRange: true;
}

type Tail<T extends readonly unknown[]> = T extends readonly [any, ...infer R] ? R : T;

/** After equality on a prefix of the index's fields, the next field may take a lower and/or upper bound. */
export interface IndexRangeBuilder<D, Fields extends readonly string[]> extends IndexRange {
  /** Only the index's fields, in order, can be compared. */
  eq<F extends Fields[0] & keyof D>(field: F, value: D[F]): IndexRangeBuilder<D, Tail<Fields>>;
  gt<F extends Fields[0] & keyof D>(field: F, value: D[F]): UpperBoundBuilder<D, F>;
  gte<F extends Fields[0] & keyof D>(field: F, value: D[F]): UpperBoundBuilder<D, F>;
  lt<F extends Fields[0] & keyof D>(field: F, value: D[F]): IndexRange;
  lte<F extends Fields[0] & keyof D>(field: F, value: D[F]): IndexRange;
}

export interface UpperBoundBuilder<D, F extends keyof D> extends IndexRange {
  lt(field: F, value: D[F]): IndexRange;
  lte(field: F, value: D[F]): IndexRange;
}

/** One page: keyset (`cursor`, for feeds and infinite lists) or numbered (`offset`, for "page 3 of 10"), or both. */
export interface PaginationOptions {
  numItems: number;
  /** null for the first page, then the previous page's `continueCursor`. */
  cursor: string | null;
  /** Matching documents to pass over before the page, counted from `cursor` (or the start): page N is `offset: (N - 1) * numItems`. */
  offset?: number;
  /** Also count the documents in the range (the whole range, not the page), as `total`. */
  withTotal?: boolean;
}

export interface PaginationResult<D> {
  page: D[];
  isDone: boolean;
  continueCursor: string;
  /** With `withTotal`: how many documents the range holds. */
  total?: number;
}

// ---- relationships ----

/** Fields of `D` that hold an `Id` (or an array of them): the ones a join can follow. */
type ReferenceFields<D> = {
  [K in keyof D & string]-?: [NonNullable<D[K]>] extends [never] ? never : [NonNullable<D[K]>] extends [Id<string> | readonly Id<string>[]] ? K : never;
}[keyof D & string];

type TargetOf<V> = NonNullable<V> extends readonly (infer E)[] ? TargetOf<E> : NonNullable<V> extends Id<infer N> ? N : never;

/** What `include({ x: "field" })` adds: the document the field points at, or all of them for an array of ids. */
type ForwardResult<V> = NonNullable<V> extends readonly unknown[] ? Doc<Extract<TargetOf<V>, TableNames>>[] : Doc<Extract<TargetOf<V>, TableNames>> | null;

/** The documents of another table that point back at this one, found through an index that starts with that reference. */
export type ReverseRule<R extends TableNames = TableNames> = R extends TableNames
  ? { table: R; index: IndexNames<R>; take?: number; order?: "asc" | "desc"; include?: IncludeSpec<R>; count?: boolean }
  : never;

/**
 * Related documents to add to each result, by the name they'll have:
 *
 *     { list: "listId" }                                        // follow a field: Doc<"lists"> | null
 *     { todos: { table: "todos", index: "by_list" } }           // look the other way: Doc<"todos">[]
 *     { open: { table: "todos", index: "by_list", count: true } } // just how many: number
 */
export type IncludeSpec<T extends TableNames> = { [key: string]: ReferenceFields<Doc<T>> | ReverseRule };

type Joined<T extends TableNames, S> = {
  [K in keyof S]: S[K] extends string
    ? ForwardResult<Doc<T>[Extract<S[K], keyof Doc<T>>]>
    : S[K] extends { count: true }
      ? number
      : S[K] extends { table: infer R extends TableNames }
        ? Expand<Doc<R> & (S[K] extends { include: infer I } ? Joined<R, I> : {})>[]
        : never;
};

type NumberFields<D> = { [K in keyof D & string]-?: [NonNullable<D[K]>] extends [never] ? never : NonNullable<D[K]> extends number ? K : never }[keyof D & string];

type StringFields<D> = { [K in keyof D & string]-?: [NonNullable<D[K]>] extends [never] ? never : NonNullable<D[K]> extends string ? K : never }[keyof D & string];

/** A where() condition. Only the builder makes them. */
export interface Predicate {
  readonly __predicate: true;
}

/**
 * Conditions on a table's stored fields, which run in the database (SQL, not JavaScript): comparisons on the fields of an index use it (the
 * one withIndex() names, or one the database picks), the rest read the range. A comparison with a field a document doesn't have is false;
 * `neq` and `not` count such documents as not matching what they negate.
 */
export interface WhereBuilder<D> {
  eq<K extends keyof D & string>(field: K, value: D[K] | null): Predicate;
  neq<K extends keyof D & string>(field: K, value: D[K] | null): Predicate;
  gt<K extends keyof D & string>(field: K, value: NonNullable<D[K]>): Predicate;
  gte<K extends keyof D & string>(field: K, value: NonNullable<D[K]>): Predicate;
  lt<K extends keyof D & string>(field: K, value: NonNullable<D[K]>): Predicate;
  lte<K extends keyof D & string>(field: K, value: NonNullable<D[K]>): Predicate;
  /** Inclusive at both ends. */
  between<K extends keyof D & string>(field: K, low: NonNullable<D[K]>, high: NonNullable<D[K]>): Predicate;
  in<K extends keyof D & string>(field: K, values: readonly NonNullable<D[K]>[]): Predicate;
  /** A string field that starts with `prefix` (case-sensitive). */
  prefix(field: StringFields<D>, prefix: string): Predicate;
  and(...predicates: Predicate[]): Predicate;
  or(...predicates: Predicate[]): Predicate;
  not(predicate: Predicate): Predicate;
}

export interface Query<D, T extends TableNames = TableNames> {
  /** Ascending (the default) or descending, by the index's fields then `_creationTime`. */
  order(order: "asc" | "desc"): Query<D, T>;
  /**
   * Keeps the documents `predicate` returns true for. It sees whatever `include()` added before it, so you can filter on related data.
   * It runs while scanning the index range, so narrow the range with `withIndex()` first: a query scans at most 100,000 documents.
   */
  filter(predicate: (doc: D) => boolean): Query<D, T>;
  /**
   * Keeps the documents a condition holds for, evaluated in the database: `where((q) => q.or(q.eq("status", "open"), q.in("priority", [1, 2])))`.
   * Unlike `filter()`, documents it rejects are never loaded, and `skip`, `count` and pages stay in SQL. Several calls must all hold.
   */
  where(condition: (q: WhereBuilder<Doc<T>>) => Predicate): Query<D, T>;
  /** Sorts by these fields in turn, each `"asc"` or `"desc"`, then `_creationTime` and `_id`, in place of the index's order. `order("desc")` reverses it all. */
  orderBy(keys: readonly (readonly [field: keyof Doc<T> & string, direction: "asc" | "desc"])[]): Query<D, T>;
  /** Keeps only these fields of each result, besides `_id` and `_creationTime` (fields added by `include()` can be named too). */
  select<const K extends keyof D & string>(fields: readonly K[]): Query<Expand<Pick<D, Extract<K | "_id" | "_creationTime", keyof D>>>, T>;
  /** Adds related documents to each result: see `IncludeSpec`. Loaded in batches, and the query stays reactive to them. */
  include<const S extends IncludeSpec<T>>(spec: S): Query<Expand<D & Joined<T, S>>, T>;
  /**
   * Passes over the first `n` matching documents, in the query's order: numbered pages are `skip((page - 1) * size).take(size)`.
   * Without a `filter()` the database skips them (an `OFFSET` over the index range), so they are never loaded; with one, `n` counts
   * documents that pass every filter, and the skipped ones count toward the 100,000 a query scans. `include()` runs only on what is returned.
   * With `paginate()` it places the first page (`cursor: null`); a cursor carries on from where its page ended. At most 100,000.
   */
  skip(n: number): Query<D, T>;
  collect(): Promise<D[]>;
  first(): Promise<D | null>;
  /** The one matching document, `null` if there is none, an error if there are several. */
  unique(): Promise<D | null>;
  take(n: number): Promise<D[]>;
  paginate(opts: PaginationOptions): Promise<PaginationResult<D>>;
  /** How many documents match (counted by the database unless there is a `filter()`). */
  count(): Promise<number>;
  /** Aggregates over a number field of the matching documents; documents without the field are skipped. `avg`, `min` and `max` are `null` when nothing matched. */
  sum(field: NumberFields<D>): Promise<number>;
  avg(field: NumberFields<D>): Promise<number | null>;
  min(field: NumberFields<D>): Promise<number | null>;
  max(field: NumberFields<D>): Promise<number | null>;
}

export interface SearchFilter {
  readonly __searchFilter: true;
}

export interface SearchFilterBuilder<D, C extends { searchField: string; filterFields: readonly string[] }> {
  search(field: C["searchField"], query: string): SearchFilterFinalizer<D, C>;
}

export interface SearchFilterFinalizer<D, C extends { searchField: string; filterFields: readonly string[] }> extends SearchFilter {
  eq<F extends C["filterFields"][number] & keyof D>(field: F, value: D[F]): SearchFilterFinalizer<D, C>;
}

/** Results come back by relevance; every query term must match (the last one as a prefix). */
export interface SearchQuery<D, T extends TableNames = TableNames> {
  /** Adds related documents to each result: see `IncludeSpec`. */
  include<const S extends IncludeSpec<T>>(spec: S): SearchQuery<Expand<D & Joined<T, S>>, T>;
  take(n: number): Promise<D[]>;
  first(): Promise<D | null>;
  /** Up to 1024 results. */
  collect(): Promise<D[]>;
}

type IndexNamesWithBuiltins<T extends TableNames> = IndexNames<T> | "by_creation_time";
type FieldsOf<T extends TableNames, I extends IndexNamesWithBuiltins<T>> = I extends IndexNames<T> ? IndexFields<T, I> : ["_creationTime"];

export interface QueryInitializer<T extends TableNames> extends Query<Doc<T>, T> {
  withIndex<I extends IndexNamesWithBuiltins<T>>(index: I, range?: (q: IndexRangeBuilder<Doc<T>, FieldsOf<T, I>>) => IndexRange): Query<Doc<T>, T>;
  withSearchIndex<I extends SearchIndexNames<T>>(
    index: I,
    filter: (q: SearchFilterBuilder<Doc<T>, SearchIndexConfig<T, I>>) => SearchFilter,
  ): SearchQuery<Doc<T>, T>;
}

export interface DatabaseReader {
  get<T extends TableNames>(id: Id<T>): Promise<Doc<T> | null>;
  /** Many documents by id in one round trip, in the order given; `null` where one doesn't exist. */
  getMany<T extends TableNames>(ids: readonly Id<T>[]): Promise<(Doc<T> | null)[]>;
  query<T extends TableNames>(table: T): QueryInitializer<T>;
  /** Adds related documents to documents you already have (a `get`, a page, your own list): see `IncludeSpec`. `null` stays `null`. */
  include<T extends TableNames, const S extends IncludeSpec<T>>(table: T, docs: Doc<T>, spec: S): Promise<Expand<Doc<T> & Joined<T, S>>>;
  include<T extends TableNames, const S extends IncludeSpec<T>>(table: T, docs: Doc<T> | null, spec: S): Promise<Expand<Doc<T> & Joined<T, S>> | null>;
  include<T extends TableNames, const S extends IncludeSpec<T>>(table: T, docs: readonly Doc<T>[], spec: S): Promise<Expand<Doc<T> & Joined<T, S>>[]>;
}

/** One document of a batch that wasn't written, by its position in the batch. */
export interface BatchError {
  index: number;
  message: string;
}

export interface DatabaseWriter extends DatabaseReader {
  insert<T extends TableNames>(table: T, value: WithoutSystemFields<Doc<T>>): Promise<Id<T>>;
  /**
   * Many documents in one call (and one statement per 200), each validated against the schema before any is written. With `mode: "all"`, the
   * default, one invalid document fails the call and nothing is inserted.
   */
  insertMany<T extends TableNames>(table: T, values: readonly WithoutSystemFields<Doc<T>>[], opts?: { mode?: "all" }): Promise<Id<T>[]>;
  /** With `mode: "partial"`, the valid documents are inserted: `ids` has `null` where one wasn't, and `errors` says why. */
  insertMany<T extends TableNames>(table: T, values: readonly WithoutSystemFields<Doc<T>>[], opts: { mode: "partial" }): Promise<{ ids: (Id<T> | null)[]; errors: BatchError[] }>;
  /** Patches many documents of `table` (shallow merges, like `patch`), each result validated before any is written. `mode` works as for `insertMany`. */
  updateMany<T extends TableNames>(table: T, updates: readonly { id: Id<T>; patch: Partial<WithoutSystemFields<Doc<T>>> }[], opts?: { mode?: "all" }): Promise<null>;
  updateMany<T extends TableNames>(table: T, updates: readonly { id: Id<T>; patch: Partial<WithoutSystemFields<Doc<T>>> }[], opts: { mode: "partial" }): Promise<{ errors: BatchError[] }>;
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

export type Visibility = "public" | "internal";

export interface RegisteredFunction<K extends FunctionKind = FunctionKind, Args = any, Return = any, V extends Visibility = Visibility> {
  readonly kind: K;
  /** Internal functions can only be called by other functions, the scheduler and crons. */
  readonly visibility: V;
  readonly args: PropertyValidators;
  readonly returns?: Validator;
  readonly handler: (ctx: any, args: any) => unknown;
  /** Queries only: who may run this query, checked for every caller on every serve. When set, the result is shared by every caller that passes. */
  readonly access?: (ctx: any, args: any) => unknown;
  readonly [fnTypes]?: { args: Args; return: Return };
}

/** What a handler may return for a `returns` validator; returning nothing counts as null. */
type HandlerReturn<V extends Validator<any, false>> = Infer<V> | (null extends Infer<V> ? void : never);

/**
 * A query may split who can run it from what it returns. `access` runs for every caller each time the query is served or pushed, and
 * throws (a ForgeError, say) to refuse; the handler then returns the same result for everyone who passes, so one run, and one cache entry, serve all
 * of them. The handler can't read `ctx.auth` (it would make the result depend on the caller); `access` can.
 */
type AccessFor<K extends FunctionKind, A extends PropertyValidators> = K extends "query" ? { access?: (ctx: QueryCtx, args: ObjectType<A>) => unknown } : {};

interface FunctionBuilder<K extends FunctionKind, Vis extends Visibility> {
  <A extends PropertyValidators = {}, R = unknown>(
    def: {
      args?: A;
      handler: (ctx: CtxFor<K>, args: ObjectType<A>) => R;
    } & AccessFor<K, A>,
  ): RegisteredFunction<K, ObjectType<A>, Awaited<R>, Vis>;
  // Last, so a mismatch reports this overload's error rather than "unknown property returns".
  /** With `returns`, the validator is the function's return type and is checked at runtime (a mismatch rolls back a mutation). */
  <A extends PropertyValidators = {}, V extends Validator<any, false> = Validator<any, false>>(
    def: {
      args?: A;
      returns: V;
      handler: (ctx: CtxFor<K>, args: ObjectType<A>) => HandlerReturn<V> | Promise<HandlerReturn<V>>;
    } & AccessFor<K, A>,
  ): RegisteredFunction<K, ObjectType<A>, Infer<V>, Vis>;
}

const define = <K extends FunctionKind, Vis extends Visibility>(kind: K, visibility: Vis): FunctionBuilder<K, Vis> =>
  ((def: { args?: PropertyValidators; returns?: Validator; handler: RegisteredFunction["handler"]; access?: RegisteredFunction["access"] }) => ({
    kind,
    visibility,
    args: def.args ?? {},
    returns: def.returns,
    handler: def.handler,
    ...(def.access && { access: def.access }),
  })) as FunctionBuilder<K, Vis>;

export const query = define("query", "public");
export const mutation = define("mutation", "public");
export const action = define("action", "public");
export const internalQuery = define("query", "internal");
export const internalMutation = define("mutation", "internal");
export const internalAction = define("action", "internal");

// ---- data migrations ----

export interface MigrationResult {
  cursor: string;
  isDone: boolean;
  processed: number;
}

/**
 * A resumable data migration over one table: `archlast-forge migrate --run-migrations` calls `migrateOne` for every
 * document, in batches (one transaction each). Return a patch to apply, or nothing; use ctx.db for anything else.
 * Registered as an internal mutation, so clients can't run it.
 */
export function migration<T extends TableNames>(def: {
  table: T;
  migrateOne: (ctx: MutationCtx, doc: Doc<T>) => Promise<Partial<WithoutSystemFields<Doc<T>>> | void> | Partial<WithoutSystemFields<Doc<T>>> | void;
  batchSize?: number;
}): RegisteredFunction<"mutation", { cursor: string | null; batchSize?: number }, MigrationResult, "internal"> & { migration: { table: string } } {
  return {
    kind: "mutation",
    visibility: "internal",
    migration: { table: def.table },
    args: {
      cursor: { kind: "union", optional: false, members: [{ kind: "string", optional: false }, { kind: "null", optional: false }] },
      batchSize: { kind: "number", optional: true },
    } as PropertyValidators,
    handler: async (ctx: MutationCtx, args: { cursor: string | null; batchSize?: number }): Promise<MigrationResult> => {
      const page = await (ctx.db.query(def.table) as any).paginate({ numItems: args.batchSize ?? def.batchSize ?? 100, cursor: args.cursor });
      for (const doc of page.page) {
        const patch = await def.migrateOne(ctx, doc);
        if (patch && Object.keys(patch).length) await ctx.db.patch(doc._id, patch as never);
      }
      return { cursor: page.continueCursor, isDone: page.isDone, processed: page.page.length };
    },
  };
}

// ---- references, as produced by codegen ----

declare const refTypes: unique symbol;

export interface FunctionReference<K extends FunctionKind = FunctionKind, Args = any, Return = any, V extends Visibility = Visibility> {
  readonly [refTypes]?: { kind: K; args: Args; return: Return; visibility: V };
}

export type FunctionArgs<R> = R extends FunctionReference<any, infer A, any> ? A : never;
export type FunctionReturn<R> = R extends FunctionReference<any, any, infer T> ? T : never;
/** Args may be omitted when the function takes none. */
export type OptionalArgs<R> = keyof FunctionArgs<R> extends never ? [args?: FunctionArgs<R>] : [args: FunctionArgs<R>];

/** Codegen builds `api` from public functions and `internal` from internal ones. */
export type ModuleRefs<M, Vis extends Visibility = "public"> = {
  [K in keyof M as M[K] extends RegisteredFunction<any, any, any, Vis> ? K : never]: M[K] extends RegisteredFunction<infer Kind, infer A, infer R, Vis>
    ? FunctionReference<Kind, A, R, Vis>
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

/** Default export of `forge/auth.ts`. Without that file, email and password sign-in is enabled. */
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

// ---- HTTP endpoints ----

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "OPTIONS";
const HTTP_METHODS: readonly string[] = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];

/** A handler for a raw HTTP request. It gets the action context, so it can call queries, mutations and actions. */
export interface HttpAction {
  kind: "httpAction";
  handler: (ctx: ActionCtx, request: Request) => Response | Promise<Response>;
}

export function httpAction(handler: HttpAction["handler"]): HttpAction {
  return { kind: "httpAction", handler };
}

export interface HttpRoute extends RouteDocs {
  method: HttpMethod;
  /** Exact path, e.g. "/stripe/webhook". */
  path?: string;
  /** Every path under it, e.g. "/files/". Exact paths win, then the longest prefix. */
  pathPrefix?: string;
  handler: HttpAction;
  /**
   * The query string's parameters. Checked before the handler runs (a mismatch answers 400) and described in the OpenAPI document. Values
   * arrive as text: a `v.number()` or `v.boolean()` parameter is converted first, a `v.array(...)` one takes every value given.
   */
  query?: PropertyValidators;
  /** The JSON body: checked before the handler runs (400 when it doesn't match) and described in the OpenAPI document. */
  body?: Validator;
  /** The JSON the route answers with, for the OpenAPI document. */
  returns?: Validator;
  /** For the OpenAPI document and the API docs page. */
  summary?: string;
  description?: string;
  tags?: string[];
}

export interface HttpRouterOptions {
  /**
   * Also serve the routes at the root of the server, without `/http`: `path: "/api/v1/tasks"` answers at `/api/v1/tasks` (and still at
   * `/http/api/v1/tasks`). The engine's own paths (`/rpc`, `/api/auth`, `/_admin`, `/_dashboard`, `/_storage`, `/_app`, `/health`, ...)
   * win, and a route inside one of them is refused. In a full-stack app the pages get every path no route matches, so give routes a
   * prefix of their own (`nest(http, { prefix: "/api/" })`): a prefix of "/" stays under `/http` there.
   */
  root?: boolean;
}

/**
 * `forge/http.ts` default-exports one of these. Routes are served under `/http`: `path: "/hello"` answers at `/http/hello`. With
 * `httpRouter({ root: true })` they also answer at the root (`/hello`).
 */
export function httpRouter(options: HttpRouterOptions = {}) {
  const routes: HttpRoute[] = [];
  let helmetConfig: HelmetConfig | undefined;
  let docsConfig: ApiDocsConfig | undefined;
  return {
    routes,
    /** What `helmet()` was given. */
    get helmetConfig() {
      return helmetConfig;
    },
    /**
     * The security headers (Helmet) of the app's surfaces, over the engine's presets: `api` (a Nest app's REST API, also `nest(http, { helmet })`),
     * `app` (a full-stack app's pages) and `dashboard`. Each takes Helmet's own options (plain data; CSP directives merge one by one), or false
     * for none. The dashboard's Security page can change them again. Call it once.
     */
    helmet(config: HelmetConfig) {
      if (helmetConfig) throw new Error("http.helmet() is called once");
      helmetConfig = config;
    },
    /** Whether the routes are also served at the root, without `/http`. */
    root: options.root === true,
    /** What `docs()` was given. */
    get docsConfig() {
      return docsConfig;
    },
    /**
     * The API docs: where they are, who they are for (`include`, `functions: false`), and what the OpenAPI document says beyond the
     * validators (info, servers, security schemes, errors, parameters, headers, tags, webhooks), plus the page's look. Call it once.
     */
    docs(config: ApiDocsConfig) {
      if (docsConfig) throw new Error("http.docs() is called once");
      checkDocsConfig(config);
      docsConfig = config;
    },
    route(spec: HttpRoute) {
      const { method, path, pathPrefix, handler } = spec;
      if (!HTTP_METHODS.includes(method)) throw new Error(`HTTP route method must be one of ${HTTP_METHODS.join(", ")}, got "${method}"`);
      if ((path === undefined) === (pathPrefix === undefined)) throw new Error("An HTTP route needs exactly one of path and pathPrefix");
      if (path !== undefined && !path.startsWith("/")) throw new Error(`HTTP route path must start with "/", got "${path}"`);
      if (pathPrefix !== undefined && !(pathPrefix.startsWith("/") && pathPrefix.endsWith("/"))) throw new Error(`HTTP route pathPrefix must start and end with "/", got "${pathPrefix}"`);
      if (handler?.kind !== "httpAction") throw new Error(`HTTP route ${method} ${path ?? pathPrefix} needs a handler made with httpAction()`);
      if (routes.some((r) => r.method === method && r.path === path && r.pathPrefix === pathPrefix)) throw new Error(`Duplicate HTTP route ${method} ${path ?? pathPrefix}`);
      routes.push(spec);
    },
  };
}
