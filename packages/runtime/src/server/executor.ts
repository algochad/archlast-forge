import { AsyncLocalStorage } from "node:async_hooks";
import { SnapshotMoved, type ReadCache } from "./read-cache";
import { isForgeError, TimeoutError } from "../errors";
import { getFunctionName, type ActionCtx, type FunctionKind, type HttpAction, type RegisteredFunction, type UserIdentity } from "../functions";
import { validate, validateFields, ValidationError } from "../values";
import type { Limits } from "./config";
import { isRetryableConflict, type Db, type DbTx } from "./db/types";
import { DocStore, type TablesSpec } from "./docstore";
import { cancelScheduled, schedule } from "./scheduler";
import type { Storage } from "./storage";

export type CallHeaders = Record<string, string>;

export interface CallResult {
  value: unknown;
  /** Read topics, for queries. */
  topics?: string[];
  /** The query called ctx.auth, so its result belongs to that caller and mustn't be shared. */
  usedAuth?: boolean;
  /** `JSON.stringify(value)`, made for the size check and reused for the response instead of serializing again. */
  json?: string;
}

export interface LogEntry {
  time: number;
  name: string;
  level: "log" | "info" | "warn" | "error" | "debug" | "call";
  message: string;
  durationMs?: number;
  ok?: boolean;
  requestId?: string;
}

/** One console line from a function, as shown next to a custom function's result. */
export interface ConsoleLine {
  time: number;
  level: LogEntry["level"];
  message: string;
}

/** `logs`, when set, also collects the function's console output for the caller. */
export const logContext = new AsyncLocalStorage<{ name: string; requestId?: string; logs?: ConsoleLine[] }>();

/** `overloaded`: the function runtime has more calls waiting than `MAX_PENDING_CALLS`, so this one was refused without running. */
export type ErrorKind = "user" | "validation" | "timeout" | "internal" | "overloaded";

export interface SerializedError {
  kind: ErrorKind;
  message: string;
  /** ForgeError data. */
  data?: unknown;
  stack?: string;
}

/** How an error crosses the process boundary; only "user" and "validation" messages are meant for callers. */
export function serializeError(e: unknown): SerializedError {
  const err = e as Error;
  const message = err?.message ?? String(e);
  if (isForgeError(err)) return { kind: "user", message, data: err.data };
  if (err?.name === "ValidationError") return { kind: "validation", message };
  if (err?.name === "TimeoutError") return { kind: "timeout", message };
  return { kind: "internal", message, stack: err?.stack };
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
function withTimeout<T>(promise: Promise<T>, ms: number, name: string): Promise<T> {
  let timer: Timer;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new TimeoutError(`${name} timed out after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

export interface RunOptions {
  /** Clients can't call internal functions; the dashboard and other functions can. */
  allowInternal?: boolean;
  requestId?: string;
  /** The caller, when the server already resolved it (to key the query cache). `undefined` means resolve it from the headers. */
  identity?: UserIdentity | null;
}

export class Executor {
  /** Set once Better Auth is created; resolves the caller from cookie/authorization headers. */
  resolveIdentity: (headers: CallHeaders) => Promise<UserIdentity | null> = async () => null;

  private limits: NonNullable<ExecutorOptions["limits"]>;

  constructor(private o: ExecutorOptions) {
    this.limits = o.limits ?? { functionTimeoutMs: 10_000, actionTimeoutMs: 600_000, maxResultBytes: 8 << 20, maxDocumentBytes: 1 << 20 };
  }

  private store(tx: DbTx, writes?: Set<string>, cached = true) {
    return new DocStore(tx, this.o.db.dialect, this.o.tables, new Set(), writes, this.limits.maxDocumentBytes, cached ? this.o.readCache : undefined);
  }

  /** One read-only transaction. Re-run when it would mix cached rows with a newer snapshot (see SnapshotMoved): reads are deterministic. */
  async read<T>(fn: (store: DocStore, tx: DbTx) => Promise<T>): Promise<{ value: T; reads: Set<string> }> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.o.db.transaction("read", async (tx) => {
          const store = this.store(tx, undefined, attempt < 3); // the last tries go straight to the database
          return { value: await fn(store, tx), reads: store.reads };
        });
      } catch (e) {
        if (!(e instanceof SnapshotMoved)) throw e;
      }
    }
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
          value = await this.o.db.transaction("write", (tx) => fn((store = this.store(tx, writes)), tx, after));
        } finally {
          // Committed or rolled back: the tables it wrote can be read and cached again.
          for (const t of store?.writing ?? []) this.o.readCache?.settled(t, writes);
        }
        if (writes.size) this.o.publish([...writes]);
        for (const f of after) Promise.resolve().then(f).catch((e) => console.error("after-commit task failed:", e));
        return value;
      } catch (e) {
        if (attempt >= 10 || !isRetryableConflict(e)) throw e;
        await Bun.sleep(Math.random() * 2 ** attempt * 5); // jittered backoff under contention
      }
    }
  }

  /** Entry point for requests: resolves identity once for the whole request. */
  async run(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders, opts: RunOptions = {}): Promise<CallResult> {
    const fn = this.o.functions.get(name);
    // Same message as a missing function, so internal names don't leak.
    if (fn?.visibility === "internal" && !opts.allowInternal) throw new ValidationError(`Unknown function "${name}"`);
    const identity = opts.identity !== undefined ? opts.identity : await this.identityOf(headers);
    return this.call(name, kind, args, identity, opts.requestId);
  }

  /** Who is calling: the signed-in user, or null for anonymous requests. */
  identityOf(headers: CallHeaders) {
    return headers.cookie || headers.authorization ? this.resolveIdentity(headers) : Promise.resolve(null);
  }

  async call(name: string, kind: FunctionKind, args: unknown, identity: UserIdentity | null, requestId?: string): Promise<CallResult> {
    const fn = this.o.functions.get(name);
    if (!fn) throw new ValidationError(`Unknown function "${name}"`);
    if (fn.kind !== kind) throw new ValidationError(`"${name}" is a ${fn.kind}, not a ${kind}`);
    return this.execute(fn, name, args, identity, requestId);
  }

  /** Runs a function object directly, like the dashboard's custom functions, with the validation, limits, transaction and logging of any call. */
  async execute(fn: RegisteredFunction, name: string, args: unknown, identity: UserIdentity | null, requestId?: string, logs?: ConsoleLine[]): Promise<CallResult> {
    const kind = fn.kind;
    args ??= {};
    validateFields(fn.args, args as Record<string, unknown>, "args");
    let usedAuth = false;
    const auth = {
      getUserIdentity: async () => {
        usedAuth = true;
        return identity;
      },
    };
    const { functionTimeoutMs, actionTimeoutMs } = this.limits;
    const result = await this.logged(name, requestId, logs, async () => {
      if (kind === "query") {
        const { value, reads } = await this.read((store) =>
          withTimeout(
            (async () => checkReturn(fn, await fn.handler({ db: store.reader(), auth, storage: this.storage(store) }, args)))(),
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
  async runHttp(name: string, action: HttpAction, req: Request, headers: CallHeaders, requestId?: string): Promise<Response> {
    const identity = await this.identityOf(headers);
    const auth = { getUserIdentity: async () => identity };
    const res = await this.logged(name, requestId, undefined, () =>
      withTimeout(Promise.resolve(action.handler(this.actionCtx(auth, identity, requestId) as unknown as ActionCtx, req)), this.limits.actionTimeoutMs, name),
    );
    if (!(res instanceof Response)) throw new Error(`${name} must return a Response`);
    return res;
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

  async logged<T>(name: string, requestId: string | undefined, logs: ConsoleLine[] | undefined, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const entry = (ok: boolean, message: string) =>
      this.o.log({ time: Date.now(), name, level: "call", message, ok, requestId, durationMs: Math.round((performance.now() - start) * 10) / 10 });
    try {
      const out = await logContext.run({ name, requestId, logs }, fn);
      entry(true, "ok");
      return out;
    } catch (e) {
      entry(false, (e as Error)?.message ?? String(e));
      throw e;
    }
  }

  private s3(): Storage {
    if (!this.o.storage) throw new Error("Storage is not configured: set S3_ENDPOINT and S3_BUCKET");
    return this.o.storage;
  }

  storage(store: DocStore, after?: AfterCommit) {
    return {
      getUrl: async (id: string) => {
        const doc = await store.get(id);
        return doc ? this.s3().getPresignedUrl(doc.key) : null;
      },
      generateUploadUrl: async ({ contentType }: { contentType?: string } = {}) => {
        const key = crypto.randomUUID();
        const uploadUrl = this.s3().putPresignedUrl(key, { contentType });
        const storageId = await store.insert("_storage", contentType ? { key, contentType } : { key });
        return { uploadUrl, storageId };
      },
      delete: async (id: string) => {
        const doc = await store.get(id);
        if (!doc) return;
        await store.delete(id);
        // Object deletion is I/O, so it waits until the metadata delete commits.
        after?.push(() => this.s3().delete(doc.key));
      },
    };
  }

  actionCtx(auth: { getUserIdentity(): Promise<UserIdentity | null> }, identity: UserIdentity | null, requestId?: string) {
    const runAs = (kind: FunctionKind) => async (ref: any, args?: object) => (await this.call(getFunctionName(ref), kind, args, identity, requestId)).value;
    return {
      auth,
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
    };
  }
}
