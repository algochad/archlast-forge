import { AsyncLocalStorage } from "node:async_hooks";
import { getFunctionName, type FunctionKind, type RegisteredFunction, type UserIdentity } from "../functions";
import { validateFields, ValidationError } from "../values";
import { isRetryableConflict, type Db, type DbTx } from "./db/types";
import { DocStore, type TablesSpec } from "./docstore";
import { cancelScheduled, schedule } from "./scheduler";
import type { Storage } from "./storage";

export type CallHeaders = Record<string, string>;

export interface CallResult {
  value: unknown;
  /** Read topics, for queries. */
  topics?: string[];
  /** The query called ctx.auth, so its result is per-user and must not be shared. */
  usedAuth?: boolean;
}

export interface LogEntry {
  time: number;
  name: string;
  level: "log" | "info" | "warn" | "error" | "debug" | "call";
  message: string;
  durationMs?: number;
  ok?: boolean;
}

export const logContext = new AsyncLocalStorage<{ name: string }>();

export interface ExecutorOptions {
  db: Db;
  tables: TablesSpec;
  functions: Map<string, RegisteredFunction>;
  storage?: Storage;
  publish(topics: string[]): void;
  log(entry: LogEntry): void;
}

type AfterCommit = (() => unknown)[];

export class Executor {
  /** Set once Better Auth is created; resolves the caller from cookie/authorization headers. */
  resolveIdentity: (headers: CallHeaders) => Promise<UserIdentity | null> = async () => null;

  constructor(private o: ExecutorOptions) {}

  read<T>(fn: (store: DocStore, tx: DbTx) => Promise<T>) {
    return this.o.db.transaction("read", async (tx) => {
      const store = new DocStore(tx, this.o.db.dialect, this.o.tables);
      return { value: await fn(store, tx), reads: store.reads };
    });
  }

  /** One write transaction; topics publish only after commit. Retries serialization conflicts (mutations are deterministic). */
  async mutate<T>(fn: (store: DocStore, tx: DbTx, afterCommit: AfterCommit) => Promise<T>): Promise<T> {
    for (let attempt = 1; ; attempt++) {
      const writes = new Set<string>();
      const after: AfterCommit = [];
      try {
        const value = await this.o.db.transaction("write", (tx) => fn(new DocStore(tx, this.o.db.dialect, this.o.tables, new Set(), writes), tx, after));
        if (writes.size) this.o.publish([...writes]);
        for (const f of after) Promise.resolve().then(f).catch((e) => console.error("after-commit task failed:", e));
        return value;
      } catch (e) {
        if (attempt >= 10 || !isRetryableConflict(e)) throw e;
        await Bun.sleep(Math.random() * 2 ** attempt * 5); // jittered backoff under contention
      }
    }
  }

  /** Entry point for clients: resolves identity once for the whole request. */
  async run(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders): Promise<CallResult> {
    const identity = headers.cookie || headers.authorization ? await this.resolveIdentity(headers) : null;
    return this.call(name, kind, args, identity);
  }

  async call(name: string, kind: FunctionKind, args: unknown, identity: UserIdentity | null): Promise<CallResult> {
    const fn = this.o.functions.get(name);
    if (!fn) throw new ValidationError(`Unknown function "${name}"`);
    if (fn.kind !== kind) throw new ValidationError(`"${name}" is a ${fn.kind}, not a ${kind}`);
    args ??= {};
    validateFields(fn.args, args as Record<string, unknown>, "args");
    let usedAuth = false;
    const auth = {
      getUserIdentity: async () => {
        usedAuth = true;
        return identity;
      },
    };
    return this.logged(name, async () => {
      if (kind === "query") {
        const { value, reads } = await this.read((store) =>
          Promise.resolve(fn.handler({ db: store.reader(), auth, storage: this.storage(store) }, args)),
        );
        return { value: value ?? null, topics: [...reads], usedAuth };
      }
      if (kind === "mutation") return { value: (await this.mutate((store, tx, after) => this.invokeMutation(fn, args, store, tx, after, identity))) ?? null };
      return { value: (await fn.handler(this.actionCtx(auth, identity), args)) ?? null };
    });
  }

  invokeMutation(fn: RegisteredFunction, args: unknown, store: DocStore, tx: DbTx, after: AfterCommit, identity: UserIdentity | null) {
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
    return Promise.resolve(fn.handler(ctx, args));
  }

  async logged<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const start = performance.now();
    const entry = (ok: boolean, message: string) =>
      this.o.log({ time: Date.now(), name, level: "call", message, ok, durationMs: Math.round((performance.now() - start) * 10) / 10 });
    try {
      const out = await logContext.run({ name }, fn);
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

  private storage(store: DocStore, after?: AfterCommit) {
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

  private actionCtx(auth: { getUserIdentity(): Promise<UserIdentity | null> }, identity: UserIdentity | null) {
    const runAs = (kind: FunctionKind) => async (ref: any, args?: object) => (await this.call(getFunctionName(ref), kind, args, identity)).value;
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
