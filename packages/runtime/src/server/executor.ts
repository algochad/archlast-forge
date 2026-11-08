import { SnapshotMoved, type ReadCache } from "./read-cache";
import { LightResponse, type LightRequest } from "./light";
import { isForgeError, TimeoutError } from "../errors";
import { getFunctionName, type ActionCtx, type FunctionKind, type HttpAction, type HttpCtx, type RegisteredFunction, type UserIdentity } from "../functions";
import { validate, validateFields, ValidationError } from "../values";
import type { Limits } from "./config";
import { isRetryableConflict, type Db, type DbTx } from "./db/types";
import { DocStore, RESET_TOPIC, type TablesSpec } from "./docstore";
import { cancelScheduled, schedule } from "./scheduler";
import type { Storage } from "./storage";
import { inSpan, logContext, telemetryOf, traced, tracedTx, type CallTelemetry, type TraceParent } from "./telemetry/context";

export { logContext };

/** A function span's attributes, one shared object per function. */
const functionAttrs = new Map<string, Record<string, string>>();
const attrsOfFunction = (name: string) => {
  let a = functionAttrs.get(name);
  if (!a) functionAttrs.set(name, (a = { "code.namespace": name.startsWith("http ") ? "http" : name.split(":")[0]!, "code.function": name }));
  return a;
};

export type CallHeaders = Record<string, string>;

/** Who is calling. `topics` and `until`, when given, are what that answer stays true while: a write to one of them, or the time, ends it. */
export interface IdentityDetail {
  identity: UserIdentity | null;
  topics?: string[];
  until?: number;
}

export interface CallResult {
  value: unknown;
  /** Read topics, for queries. */
  topics?: string[];
  /** The query called ctx.auth, so its result belongs to that caller and mustn't be shared. */
  usedAuth?: boolean;
  /** `JSON.stringify(value)`, made for the size check and reused for the response instead of serializing again. */
  json?: string;
  /** For a traced call: its spans and who it ran as. */
  telemetry?: CallTelemetry;
}

export interface LogEntry {
  time: number;
  name: string;
  level: "log" | "info" | "warn" | "error" | "debug" | "call";
  message: string;
  durationMs?: number;
  ok?: boolean;
  requestId?: string;
  /** The trace and span it was written in, when the call was traced. */
  traceId?: string;
  spanId?: string;
}

/** One console line from a function, as shown next to a custom function's result. */
export interface ConsoleLine {
  time: number;
  level: LogEntry["level"];
  message: string;
}

/** `overloaded`: the function runtime has more calls waiting than `MAX_PENDING_CALLS`, so this one was refused without running. */
export type ErrorKind = "user" | "validation" | "timeout" | "internal" | "overloaded";

export interface SerializedError {
  kind: ErrorKind;
  message: string;
  /** ForgeError data. */
  data?: unknown;
  stack?: string;
  /** The error's class name (TypeError, ForgeError). */
  type?: string;
  /** What a traced call recorded before it failed. */
  telemetry?: CallTelemetry;
}

/** How an error crosses the process boundary; only "user" and "validation" messages are meant for callers. */
export function serializeError(e: unknown): SerializedError {
  const err = e as Error;
  const message = err?.message ?? String(e);
  const telemetry = telemetryOf(e);
  const extra = { type: err?.constructor?.name && err.constructor.name !== "Object" ? err.constructor.name : (err?.name ?? "Error"), ...(telemetry && { telemetry }) };
  if (isForgeError(err)) return { kind: "user", message, data: err.data, ...extra };
  if (err?.name === "ValidationError") return { kind: "validation", message, ...extra };
  if (err?.name === "TimeoutError") return { kind: "timeout", message, stack: err?.stack, ...extra };
  return { kind: "internal", message, stack: err?.stack, ...extra };
}

export interface ExecutorOptions {
  db: Db;
  tables: TablesSpec;
  functions: Map<string, RegisteredFunction>;
  storage?: Storage;
  limits?: Pick<Limits, "functionTimeoutMs" | "actionTimeoutMs" | "maxResultBytes" | "maxDocumentBytes">;
  publish(topics: string[]): void;
  log(entry: LogEntry): void;
  /** Keep document reads in an exact read cache: only when this process is the database's only writer. */
  readCache?: ReadCache;
  /** In dev: where a query without an index to use is reported. */
  devWarn?: (message: string) => void;
}

type AfterCommit = (() => unknown)[];

/** A wrong return value is a server bug, so it's reported as internal, not as a ValidationError. */
function checkReturn<T>(fn: RegisteredFunction, value: T): T {
  if (!fn.returns) return value;
  try {
    validate(fn.returns, value ?? null, "returns");
  } catch (e) {
    throw new Error(`Invalid return value: ${(e as Error).message}`);
  }
  return value;
}

/** Rejects after `ms`. The handler may keep running; its transaction handle refuses further use once the call ends. */
/**
 * An action's `ctx`. Making its storage, scheduler and `run*` functions for every call costs more than most handlers (an HTTP route that answers from memory)
 * use of them, so they are made the first time one is read.
 */
class LazyActionCtx {
  private parts?: ReturnType<Executor["actionCtxParts"]>;
  constructor(
    private readonly exec: Executor,
    readonly auth: { getUserIdentity(): Promise<UserIdentity | null> },
    private readonly identity: UserIdentity | null,
    private readonly requestId: string | undefined,
  ) {}
  private get p() {
    return (this.parts ??= this.exec.actionCtxParts(this.identity, this.requestId));
  }
  get storage() {
    return this.p.storage;
  }
  get scheduler() {
    return this.p.scheduler;
  }
  get runQuery() {
    return this.p.runQuery;
  }
  get runMutation() {
    return this.p.runMutation;
  }
  get runAction() {
    return this.p.runAction;
  }
  get read() {
    return this.p.read;
  }
  get write() {
    return this.p.write;
  }
}

/**
 * Time limits for calls. Every call has one and almost none reaches it, so a timer made and cleared for each is most of what a limit costs: calls with the same
 * limit wait in a list in the order their deadlines fall, and one timer per list is set for its first.
 */
class Deadlines {
  private lists = new Map<number, { head?: Node; tail?: Node; timer?: Timer }>();

  add(ms: number, fire: () => void): Node {
    let list = this.lists.get(ms);
    if (!list) this.lists.set(ms, (list = {}));
    const node: Node = { at: performance.now() + ms, fire, list, ms };
    if (list.tail) (list.tail.next = node), (node.prev = list.tail);
    else list.head = node;
    list.tail = node;
    if (!list.timer) list.timer = setTimeout(() => this.tick(ms, list!), ms);
    return node;
  }

  remove(node: Node) {
    if (node.done) return;
    node.done = true;
    const list = node.list;
    if (node.prev) node.prev.next = node.next;
    else list.head = node.next;
    if (node.next) node.next.prev = node.prev;
    else list.tail = node.prev;
    if (!list.head && list.timer) (clearTimeout(list.timer), (list.timer = undefined));
  }

  private tick(ms: number, list: { head?: Node; tail?: Node; timer?: Timer }) {
    list.timer = undefined;
    const now = performance.now();
    while (list.head && list.head.at <= now) {
      const node = list.head;
      this.remove(node);
      node.fire();
    }
    if (list.head) list.timer = setTimeout(() => this.tick(ms, list), Math.max(1, list.head.at - now));
  }
}
interface Node {
  at: number;
  fire: () => void;
  list: { head?: Node; tail?: Node; timer?: Timer };
  ms: number;
  prev?: Node;
  next?: Node;
  done?: boolean;
}
const deadlines = new Deadlines();

/** The `ctx.auth` of a call with no caller. */
const ANONYMOUS = { getUserIdentity: async (): Promise<UserIdentity | null> => null };

function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const node = deadlines.add(ms, () => reject(new TimeoutError(`${name} timed out after ${ms} ms`)));
    promise.then(
      (value) => (deadlines.remove(node), resolve(value)),
      (error) => (deadlines.remove(node), reject(error)),
    );
  });
}

export interface RunOptions {
  /** Clients can't call internal functions; the dashboard and other functions can. */
  allowInternal?: boolean;
  requestId?: string;
  /** The caller, when the server already resolved it (to key the query cache). `undefined` means resolve it from the headers. */
  identity?: UserIdentity | null;
  /** Record the call's spans under this span of the server's, and hand them back with the result. */
  trace?: TraceParent;
  /**
   * For a query that declares `access`, which half the server wants: `"only"` runs the check as the caller and answers with what it read;
   * `"skip"` runs the handler alone, for a caller the server has already checked. Without it both run, as for a call from an action.
   */
  access?: "only" | "skip";
}

export class Executor {
  /** Set once Better Auth is created; resolves the caller from cookie/authorization headers. */
  resolveIdentity: (headers: CallHeaders) => Promise<UserIdentity | null> = async () => null;
  identityDetail: (headers: CallHeaders) => Promise<IdentityDetail> = async () => ({ identity: null });

  private limits: NonNullable<ExecutorOptions["limits"]>;

  /** Replaces the read cache (undefined turns it off): a transaction already running keeps the one it started with. */
  setReadCache(cache?: ReadCache) {
    this.o.readCache = cache;
  }

  constructor(private o: ExecutorOptions) {
    this.limits = o.limits ?? { functionTimeoutMs: 10_000, actionTimeoutMs: 600_000, maxResultBytes: 8 << 20, maxDocumentBytes: 1 << 20 };
  }

  private store(tx: DbTx, writes?: Set<string>, cached = true) {
    return new DocStore(tracedTx(tx, this.system), this.o.db.dialect, this.o.tables, new Set(), writes, this.limits.maxDocumentBytes, cached ? this.o.readCache : undefined, this.o.devWarn);
  }

  /** OpenTelemetry's name for the database, on db spans. */
  private get system() {
    return this.o.db.dialect.name === "postgres" ? "postgresql" : "sqlite";
  }

  /** One read-only transaction. Re-run when it would mix cached rows with a newer snapshot (see SnapshotMoved): reads are deterministic. */
  async read<T>(fn: (store: DocStore, tx: DbTx) => Promise<T>): Promise<{ value: T; reads: Set<string> }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.o.db.transaction(
          "read",
          async (tx) => {
            const store = this.store(tx, undefined, attempt < 3); // the last tries go straight to the database
            return { value: await fn(store, tx), reads: store.reads };
          },
          { rerunnable: true }, // a query is deterministic and writes nothing, so a database may run it again where that is cheaper than a transaction
        );
      } catch (e) {
        if (!(e instanceof SnapshotMoved)) throw e;
      }
    }
  }

  /**
   * One write transaction that publishes no per-document topics: restoring a backup rewrites whole tables, so it publishes RESET_TOPIC once
   * and every server drops its cache and re-runs its subscriptions. Not retried: a restore is not a deterministic mutation to re-run.
   */
  async rewrite<T>(fn: (store: DocStore, tx: DbTx) => Promise<T>): Promise<T> {
    let store: DocStore | undefined;
    try {
      return await this.o.db.transaction("write", (tx) => fn((store = this.store(tx, new Set())), tx));
    } finally {
      for (const t of store?.writing ?? []) this.o.readCache?.settled(t, []);
      this.o.readCache?.clear();
      this.o.publish([RESET_TOPIC]);
    }
  }

  private retryChain: Promise<unknown> = Promise.resolve();
  private retrying<T>(run: () => Promise<T>): Promise<T> {
    const next = this.retryChain.then(run, run);
    this.retryChain = next.catch(() => {});
    return next;
  }

  /** One write transaction; topics publish only after commit. Retries serialization conflicts (mutations are deterministic). */
  async mutate<T>(fn: (store: DocStore, tx: DbTx, afterCommit: AfterCommit) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const writes = new Set<string>();
      const after: AfterCommit = [];
      try {
        let store: DocStore | undefined;
        let value: T;
        try {
          // The function may be run again by the database (see TransactionOptions.rerunnable), so each run starts from nothing.
          const run = () =>
            this.o.db.transaction(
              "write",
              (tx) => {
                writes.clear();
                after.length = 0;
                return fn((store = this.store(tx, writes)), tx, after);
              },
              { rerunnable: true },
            );
          // On a database that asks for it (MongoDB), a mutation aborted for a conflict runs again one at a time with the others in this
          // process that are running again: a crowd of contenders (forty claims of one name) would otherwise abort each other round after
          // round and use up their ten attempts. Postgres retries in parallel and shares its commits: queueing them made the toggle
          // benchmark's 99th percentile five times longer at the same throughput.
          value = attempt > 1 && this.o.db.serializeRetries ? await this.retrying(run) : await run();
        } finally {
          // Committed or rolled back: the tables it wrote can be read and cached again.
          for (const t of store?.writing ?? []) this.o.readCache?.settled(t, writes);
        }
        if (writes.size) this.o.publish([...writes]);
        for (const f of after)
          Promise.resolve()
            .then(f)
            .catch((e) => console.error("after-commit task failed:", e));
        return value;
      } catch (e) {
        if (attempt >= 10 || !isRetryableConflict(e)) throw e;
        await Bun.sleep(Math.random() * 2 ** attempt * 5); // jittered backoff under contention
      }
    }
  }

  /** Entry point for requests: resolves identity once for the whole request. */
  async run(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders, opts: RunOptions = {}): Promise<CallResult> {
    const out = await traced(opts.trace, name, async () => {
      const fn = this.o.functions.get(name);
      // Same message as a missing function, so internal names don't leak.
      if (fn?.visibility === "internal" && !opts.allowInternal) throw new ValidationError(`Unknown function "${name}"`);
      const mode = fn?.access ? opts.access : undefined;
      const identity = mode === "skip" ? null : opts.identity !== undefined ? opts.identity : await this.identityOf(headers);
      this.ranAs(identity);
      return this.call(name, kind, args, identity, opts.requestId, mode);
    });
    // The result is this call's own object (execute builds it), so it can carry its telemetry without a copy.
    if (out.telemetry) out.value.telemetry = out.telemetry;
    return out.value;
  }

  /** Notes who a traced call runs as. */
  ranAs(identity: UserIdentity | null) {
    const trace = logContext.getStore()?.trace;
    if (trace && identity) trace.user = { id: identity.userId, ...((identity.email ?? identity.name) && { name: String(identity.email ?? identity.name) }) };
  }

  /** Who is calling: the signed-in user, or null for anonymous requests. */
  identityOf(headers: CallHeaders) {
    return headers.cookie || headers.authorization ? this.resolveIdentity(headers) : Promise.resolve(null);
  }

  /** The same with what the answer rests on, for a server that keeps it. */
  identityDetailOf(headers: CallHeaders): Promise<IdentityDetail> {
    return headers.cookie || headers.authorization ? this.identityDetail(headers) : Promise.resolve({ identity: null });
  }

  async call(name: string, kind: FunctionKind, args: unknown, identity: UserIdentity | null, requestId?: string, mode?: "only" | "skip"): Promise<CallResult> {
    const fn = this.o.functions.get(name);
    if (!fn) throw new ValidationError(`Unknown function "${name}"`);
    if (fn.kind !== kind) throw new ValidationError(`"${name}" is a ${fn.kind}, not a ${kind}`);
    return this.execute(fn, name, args, identity, requestId, undefined, mode);
  }

  /** Runs a function object directly, like the dashboard's custom functions, with the validation, limits, transaction and logging of any call. */
  async execute(fn: RegisteredFunction, name: string, args: unknown, identity: UserIdentity | null, requestId?: string, logs?: ConsoleLine[], mode?: "only" | "skip"): Promise<CallResult> {
    const kind = fn.kind;
    args ??= {};
    validateFields(fn.args, args as Record<string, unknown>, "args");
    let usedAuth = false;
    const caller = { getUserIdentity: async () => identity };
    const shared = kind === "query" && fn.access !== undefined;
    const auth = shared
      ? {
          getUserIdentity: async (): Promise<never> => {
            throw new Error(`${name} declares access, so its handler can't read ctx.auth: its result is shared by every caller that passes. Read the caller in access.`);
          },
        }
      : {
          getUserIdentity: async () => {
            usedAuth = true;
            return identity;
          },
        };
    const { functionTimeoutMs, actionTimeoutMs } = this.limits;
    if (shared && mode === "only") {
      // Only the check: what it reads is what a push to this caller must watch, besides the result's own reads.
      const { reads } = await this.logged(
        name,
        requestId,
        logs,
        () => this.read((store) => withTimeout(Promise.resolve(fn.access!({ db: store.reader(), auth: caller, storage: this.storage(store) }, args)), functionTimeoutMs, name)),
        true,
      );
      return { value: null, topics: [...reads], json: "null" };
    }
    const result = await this.logged(name, requestId, logs, async () => {
      if (kind === "query") {
        const { value, reads } = await this.read((store) =>
          withTimeout(
            (async () => {
              if (shared && mode !== "skip") await fn.access!({ db: store.reader(), auth: caller, storage: this.storage(store) }, args);
              return checkReturn(fn, await fn.handler({ db: store.reader(), auth, storage: this.storage(store) }, args));
            })(),
            functionTimeoutMs,
            name,
          ),
        );
        return { value: value ?? null, topics: [...reads], usedAuth };
      }
      if (kind === "mutation")
        return {
          value: (await this.mutate((store, tx, after) => withTimeout(this.invokeMutation(fn, args, store, tx, after, identity), functionTimeoutMs, name))) ?? null,
        };
      return { value: checkReturn(fn, await withTimeout(Promise.resolve(fn.handler(this.actionCtx(auth, identity, requestId), args)), actionTimeoutMs, name)) ?? null };
    });
    const json = JSON.stringify(result.value) ?? "null";
    if (json.length > this.limits.maxResultBytes) throw new Error(`${name} returned ${json.length} bytes; the limit is ${this.limits.maxResultBytes} (MAX_RESULT_BYTES)`);
    return { ...result, json };
  }

  /** Runs an HTTP action. The caller is resolved from the request's cookie or authorization header, and is anonymous without one. */
  async runHttp(name: string, action: HttpAction, req: Request | LightRequest, headers: CallHeaders, requestId?: string): Promise<Response | LightResponse> {
    // Anonymous (no cookie, no authorization header) is known without waiting for anything
    const identity = headers.cookie || headers.authorization ? await this.resolveIdentity(headers) : null;
    this.ranAs(identity);
    const auth = { getUserIdentity: async () => identity };
    const res: unknown = await this.logged(name, requestId, undefined, () =>
      withTimeout(Promise.resolve(action.handler(this.actionCtx(auth, identity, requestId) as unknown as HttpCtx, req as Request)), this.limits.actionTimeoutMs, name),
    );
    if (!(res instanceof Response) && !(res instanceof LightResponse)) throw new Error(`${name} must return a Response`);
    return res as Response | LightResponse;
  }

  /**
   * `runHttp` for a caller with no cookie or authorization header and no trace to record: the answer comes back without a promise when the handler's does not
   * (a handler that waits for something is given its time limit as before). Everything else `runHttp` does is done in the same order.
   */
  runHttpAnonymous<R, T>(name: string, action: HttpAction, req: Request | LightRequest, requestId: string | undefined, answer: (route: R, res: Response | LightResponse, telemetry: undefined) => T, route: R): T | Promise<T> {
    const start = performance.now();
    let res: unknown;
    try {
      res = logContext.run({ name, requestId, logs: undefined, trace: undefined, spanId: undefined }, () => action.handler(new LazyActionCtx(this, ANONYMOUS, null, requestId) as unknown as HttpCtx, req as Request));
    } catch (e) {
      this.logCall(name, requestId, start, undefined, false, (e as Error)?.message ?? String(e));
      throw e;
    }
    if (res && typeof (res as PromiseLike<unknown>).then === "function") {
      // One promise for the wait: the answer, the call's log line and the time limit are settled in the one step that sees the handler's result.
      return new Promise<T>((resolve, reject) => {
        const node = deadlines.add(this.limits.actionTimeoutMs, () => {
          this.logCall(name, requestId, start, undefined, false, `${name} timed out after ${this.limits.actionTimeoutMs} ms`);
          reject(new TimeoutError(`${name} timed out after ${this.limits.actionTimeoutMs} ms`));
        });
        (res as PromiseLike<unknown>).then(
          (value) => {
            if (node.done) return; // the time limit came first
            deadlines.remove(node);
            let out: T;
            try {
              out = answer(route, this.httpResult(name, value), undefined);
            } catch (e) {
              this.logCall(name, requestId, start, undefined, false, (e as Error)?.message ?? String(e));
              reject(e);
              return;
            }
            this.logCall(name, requestId, start, undefined, true, "ok");
            resolve(out);
          },
          (e) => {
            if (node.done) return;
            deadlines.remove(node);
            this.logCall(name, requestId, start, undefined, false, (e as Error)?.message ?? String(e));
            reject(e);
          },
        );
      });
    }
    const checked = this.httpResult(name, res);
    this.logCall(name, requestId, start, undefined, true, "ok");
    return answer(route, checked, undefined);
  }

  private httpResult(name: string, res: unknown): Response | LightResponse {
    if (!(res instanceof Response) && !(res instanceof LightResponse)) throw new Error(`${name} must return a Response`);
    return res as Response | LightResponse;
  }

  /** A function's time limit, for mutations run outside `call` (the scheduler). */
  timed<T>(promise: Promise<T>, name: string): Promise<T> {
    return withTimeout(promise, this.limits.functionTimeoutMs, name);
  }

  async invokeMutation(fn: RegisteredFunction, args: unknown, store: DocStore, tx: DbTx, after: AfterCommit, identity: UserIdentity | null) {
    const ctx = {
      db: store.writer(),
      auth: { getUserIdentity: async () => identity },
      storage: this.storage(store, after),
      scheduler: {
        runAfter: (ms: number, ref: any, a?: object) => schedule(tx, this.o.functions, Date.now() + ms, ref, a),
        runAt: (at: number, ref: any, a?: object) => schedule(tx, this.o.functions, at, ref, a),
        cancel: (id: string) => cancelScheduled(tx, id),
      },
    };
    return checkReturn(fn, await fn.handler(ctx, args)); // inside the transaction, so a bad value rolls back
  }

  /** `access`: the check of a query that declares one, which is logged only when it refuses, and is a span of its own. */
  async logged<T>(name: string, requestId: string | undefined, logs: ConsoleLine[] | undefined, fn: () => Promise<T>, access = false): Promise<T> {
    const start = performance.now();
    const outer = logContext.getStore();
    const context = { name, requestId, logs, trace: outer?.trace, spanId: outer?.spanId };
    try {
      // A traced call is a span, and what it does nests under it; the module is its namespace on the time-by-code view.
      const out = context.trace
        ? await logContext.run(context, () => inSpan(access ? `${name} (access)` : name, "function", attrsOfFunction(name), fn, 1))
        : await logContext.run(context, fn);
      if (!access) this.logCall(name, requestId, start, outer?.trace?.traceId, true, "ok");
      return out;
    } catch (e) {
      this.logCall(name, requestId, start, outer?.trace?.traceId, false, (e as Error)?.message ?? String(e));
      throw e;
    }
  }

  /** The log line for one call (its name, whether it worked and how long it took). */
  private logCall(name: string, requestId: string | undefined, start: number, traceId: string | undefined, ok: boolean, message: string) {
    this.o.log({ time: Date.now(), name, level: "call", message, ok, requestId, durationMs: Math.round((performance.now() - start) * 10) / 10, traceId });
  }

  private s3(): Storage {
    if (!this.o.storage) throw new Error("Storage is not configured: set S3_ENDPOINT and S3_BUCKET, or STORAGE=local to keep files on this server");
    return this.o.storage;
  }

  storage(store: DocStore, after?: AfterCommit) {
    // Only a file's id: another table's document with a `key` field isn't a file, and its id isn't one to delete here.
    const file = (id: string) => (typeof id === "string" && id.startsWith("_storage:") ? store.get(id) : null);
    return {
      getUrl: async (id: string) => {
        const doc = await file(id);
        return doc ? this.s3().getPresignedUrl(doc.key) : null;
      },
      generateUploadUrl: async ({ contentType }: { contentType?: string } = {}) => {
        const key = crypto.randomUUID();
        const uploadUrl = this.s3().putPresignedUrl(key, { contentType });
        const storageId = await store.insert("_storage", contentType ? { key, contentType } : { key });
        return { uploadUrl, storageId };
      },
      delete: async (id: string) => {
        const doc = await file(id);
        if (!doc) return;
        await store.delete(id);
        // Object deletion is I/O, so it waits until the metadata delete commits.
        after?.push(() => this.s3().delete(doc.key));
      },
    };
  }

  actionCtx(auth: { getUserIdentity(): Promise<UserIdentity | null> }, identity: UserIdentity | null, requestId?: string) {
    return new LazyActionCtx(this, auth, identity, requestId);
  }

  /** What an action's `ctx` is made of: `actionCtx` hands it out piece by piece (see `LazyActionCtx`), since most handlers use few of them. */
  actionCtxParts(identity: UserIdentity | null, requestId?: string) {
    const runAs = (kind: FunctionKind) => async (ref: any, args?: object) => (await this.call(getFunctionName(ref), kind, args, identity, requestId)).value;
    return {
      storage: {
        getUrl: async (id: string) => (await this.read((s) => this.storage(s).getUrl(id))).value,
        generateUploadUrl: (o?: { contentType?: string }) => this.mutate((s, _tx, after) => this.storage(s, after).generateUploadUrl(o)),
        delete: (id: string) => this.mutate((s, _tx, after) => this.storage(s, after).delete(id)),
      },
      scheduler: {
        runAfter: (ms: number, ref: any, a?: object) => this.mutate((_s, tx) => schedule(tx, this.o.functions, Date.now() + ms, ref, a)),
        runAt: (at: number, ref: any, a?: object) => this.mutate((_s, tx) => schedule(tx, this.o.functions, at, ref, a)),
        cancel: (id: string) => this.mutate((_s, tx) => cancelScheduled(tx, id)),
      },
      runQuery: runAs("query"),
      runMutation: runAs("mutation"),
      runAction: runAs("action"),
      // An HTTP route's direct access to the database (HttpCtx): the transaction of a query or a mutation around a function that is not registered by name.
      read: async (fn: (ctx: any) => unknown) => {
        const auth = { getUserIdentity: async () => identity };
        const { value } = await this.read((store) => withTimeout(Promise.resolve(fn({ db: store.reader(), auth, storage: this.storage(store) })), this.limits.functionTimeoutMs, "ctx.read"));
        return value;
      },
      write: (fn: (ctx: any) => unknown) =>
        this.mutate((store, tx, after) =>
          withTimeout(
            Promise.resolve(
              fn({
                db: store.writer(),
                auth: { getUserIdentity: async () => identity },
                storage: this.storage(store, after),
                scheduler: {
                  runAfter: (ms: number, ref: any, a?: object) => schedule(tx, this.o.functions, Date.now() + ms, ref, a),
                  runAt: (at: number, ref: any, a?: object) => schedule(tx, this.o.functions, at, ref, a),
                  cancel: (id: string) => cancelScheduled(tx, id),
                },
              }),
            ),
            this.limits.functionTimeoutMs,
            "ctx.write",
          ),
        ),
    };
  }
}
