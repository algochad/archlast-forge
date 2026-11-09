// Spans inside the function runtime. A traced call carries a buffer in its async context; database statements, nested calls, outbound
// fetches and the app's own spans are pushed to it as they finish, each under whatever span was current, and the buffer goes back to the
// server with the call's result (or its error). Outside a traced call everything here is a no-op.
import { AsyncLocalStorage } from "node:async_hooks";
import type { ConsoleLine } from "../executor";
import type { DbTx } from "../db/types";
import type { NativeHandle } from "../db/native";
import { spanId, traceparent } from "./ids";
import type { Attrs, Span, SpanType } from "./types";

/** At most this many spans per trace; a loop that queries a million times keeps the first ones and counts the rest. */
export const MAX_SPANS = 2000;

export interface TraceBuffer {
  traceId: string;
  spans: Span[];
  dropped: number;
  /** Attributes for the request this trace is about (a Nest route's pattern, say), which the server records on its root. */
  request?: Attrs;
  /** Who the call ran as, once it is known. */
  user?: { id: string; name?: string };
}

export interface CallContext {
  name: string;
  requestId?: string;
  /** When set, also collects the function's console output for the caller (the dashboard's custom functions). */
  logs?: ConsoleLine[];
  trace?: TraceBuffer;
  /** The span new spans nest under, and while it runs, the span itself (so attributes can be added to it). */
  spanId?: string;
  span?: Span;
}

/** The call a piece of code runs in: console output is attributed to it, and spans recorded under it. */
export const logContext = new AsyncLocalStorage<CallContext>();

const ORIGIN = performance.timeOrigin;
/** Epoch milliseconds with a fraction, on a clock that never steps back. */
export const now = () => ORIGIN + performance.now();

/** What a traced call hands back: its spans, and who it ran as. */
export interface CallTelemetry {
  spans: Span[];
  dropped?: number;
  user?: { id: string; name?: string };
  /** For the request's root span. */
  attrs?: Attrs;
}

/** Where a trace continues: the server's root span for the request. */
export interface TraceParent {
  traceId: string;
  parentId: string;
}

const TELEMETRY = Symbol.for("archlast-forge.telemetry-result");

/** The spans of a call that failed travel on its error, to the server, which records the failure with them. */
export const attachTelemetry = (e: unknown, t: CallTelemetry) => {
  if (e && typeof e === "object") (e as Record<symbol, unknown>)[TELEMETRY] = t;
  return e;
};
export const telemetryOf = (e: unknown): CallTelemetry | undefined => (e && typeof e === "object" ? ((e as Record<symbol, unknown>)[TELEMETRY] as CallTelemetry) : undefined);

function push(ctx: CallContext, span: Span) {
  const t = ctx.trace!;
  if (t.spans.length >= MAX_SPANS) t.dropped++;
  else t.spans.push(span);
}

/** Runs `fn` with a fresh trace buffer under `parent`, and returns what it recorded with the value; on failure the error carries it. */
export async function traced<T>(parent: TraceParent | undefined, name: string, fn: () => Promise<T>): Promise<{ value: T; telemetry?: CallTelemetry }> {
  if (!parent) return { value: await fn() };
  const trace: TraceBuffer = { traceId: parent.traceId, spans: [], dropped: 0 };
  const telemetry = (): CallTelemetry => ({
    spans: trace.spans,
    ...(trace.dropped && { dropped: trace.dropped }),
    ...(trace.request && { attrs: trace.request }),
    ...(trace.user && { user: trace.user }),
  });
  try {
    const value = await logContext.run({ name, trace, spanId: parent.parentId }, fn);
    return { value, telemetry: telemetry() };
  } catch (e) {
    throw attachTelemetry(e, telemetry());
  }
}

/** Runs `fn` as a span: spans recorded inside it nest under it. Outside a traced call, just runs it. */
export async function inSpan<T>(name: string, type: SpanType, attrs: Attrs | undefined, fn: () => Promise<T> | T, kind = 1, rename?: Partial<CallContext>): Promise<T> {
  const ctx = logContext.getStore();
  if (!ctx?.trace) return fn();
  const id = spanId();
  const start = now();
  const span: Span = { traceId: ctx.trace.traceId, spanId: id, parentId: ctx.spanId, name, type, kind, start, duration: 0, attrs };
  try {
    const out = await logContext.run({ ...ctx, ...rename, spanId: id, span }, fn);
    span.status = 1;
    return out;
  } catch (e) {
    span.status = 2;
    span.error = (e as Error)?.message ?? String(e);
    throw e;
  } finally {
    span.duration = now() - start;
    push(ctx, span);
  }
}

/**
 * `fn` timed as a span on every call made inside a traced call (and called straight through outside one). Unlike `inSpan` it keeps
 * `fn`'s own calling convention: a method that returns a value synchronously still does, and one that returns a promise is timed until it
 * settles. For methods of the app's own classes (Nest controllers and services).
 */
export function spanned<T extends (...args: any[]) => any>(fn: T, name: string, type: SpanType, attrs?: Attrs): T {
  return function (this: unknown, ...args: unknown[]) {
    const ctx = logContext.getStore();
    if (!ctx?.trace) return fn.apply(this, args);
    const id = spanId();
    const start = now();
    const span: Span = { traceId: ctx.trace.traceId, spanId: id, parentId: ctx.spanId, name, type, kind: 1, start, duration: 0, attrs };
    const done = (error?: unknown) => {
      span.duration = now() - start;
      span.status = error === undefined ? 1 : 2;
      if (error !== undefined) span.error = (error as Error)?.message ?? String(error);
      push(ctx, span);
    };
    let out: unknown;
    try {
      out = logContext.run({ ...ctx, spanId: id, span }, () => fn.apply(this, args));
    } catch (e) {
      done(e);
      throw e;
    }
    if (out && typeof (out as PromiseLike<unknown>).then === "function") (out as PromiseLike<unknown>).then(() => done(), (e: unknown) => done(e ?? new Error("rejected")));
    else done();
    return out;
  } as T;
}

/** Adds attributes to the span that is running; `request` adds them to the request the trace is about instead. */
export function annotate(attrs: Attrs, request = false) {
  const ctx = logContext.getStore();
  if (!ctx?.trace) return;
  if (request || !ctx.span) ctx.trace.request = { ...ctx.trace.request, ...attrs };
  else ctx.span.attrs = { ...ctx.span.attrs, ...attrs };
}

// ---- database statements ----

type Summary = { name: string; op: string; table?: string };
const summaries = new Map<string, Summary>();
/** A statement's span attributes, built once per statement and shared by every span of it (spans never change their attributes in place). */
const statementAttrs = new Map<string, Attrs>();
const VERB = /^\s*(SELECT|INSERT|UPDATE|DELETE|WITH|CREATE|DROP|ALTER|PRAGMA|BEGIN|COMMIT|ROLLBACK|SAVEPOINT|RELEASE)\b/i;
const TABLE = /\b(?:FROM|INTO|UPDATE|JOIN)\s+"([^"]+)"/gi;

/** "SELECT todos", "INSERT _storage", "SEARCH messages": the statement's verb and the table it is about. */
export function summarizeSql(sql: string): Summary {
  const key = sql.length > 400 ? sql.slice(0, 400) : sql;
  const hit = summaries.get(key);
  if (hit) return hit;
  const op = (VERB.exec(sql)?.[1] ?? "SQL").toUpperCase();
  const tables = [...sql.matchAll(TABLE)].map((m) => m[1]!);
  const search = tables.some((t) => t.startsWith("afx_fts_"));
  const table = tables.find((t) => !t.startsWith("afx_fts_"));
  const s: Summary = { name: `${search ? "SEARCH" : op}${table ? ` ${table}` : ""}`, op: search ? "SEARCH" : op, table };
  if (summaries.size > 2000) summaries.clear();
  summaries.set(key, s);
  return s;
}

const nativeAttrs = new Map<string, Attrs>();

/**
 * A `db` span for an operation the native engine ran: it plans and runs its statements itself, so there is no statement here to summarize, only the verb and the
 * table ("SELECT todos", "INSERT todos").
 */
export function nativeOp<T>(system: string, op: string, table: string | undefined, go: () => T): T {
  const ctx = logContext.getStore();
  if (!ctx?.trace) return go();
  const start = now();
  const name = table ? `${op} ${table}` : op;
  let attrs = nativeAttrs.get(name);
  if (!attrs) {
    attrs = { "db.system.name": system, "db.operation.name": op, "db.query.text": name };
    if (table) attrs["db.collection.name"] = table;
    if (nativeAttrs.size > 2000) nativeAttrs.clear();
    nativeAttrs.set(name, attrs);
  }
  const span: Span = { traceId: ctx.trace.traceId, spanId: spanId(), parentId: ctx.spanId, name, type: "db", kind: 3, start, duration: 0, attrs };
  try {
    const out = go();
    span.status = 1;
    return out;
  } catch (e) {
    span.status = 2;
    span.error = (e as Error)?.message ?? String(e);
    throw e;
  } finally {
    span.duration = now() - start;
    push(ctx, span);
  }
}

const statementSpan = async <T>(system: string, ctx: CallContext, sql: string, go: () => Promise<T>, rows: (out: T) => number | undefined): Promise<T> => {
  const start = now();
  const s = summarizeSql(sql);
  let attrs = statementAttrs.get(sql);
  if (!attrs) {
    attrs = { "db.system.name": system, "db.operation.name": s.op, "db.query.text": sql.length > 1000 ? `${sql.slice(0, 1000)}…` : sql };
    if (s.table) attrs["db.collection.name"] = s.table;
    if (statementAttrs.size > 2000) statementAttrs.clear();
    statementAttrs.set(sql, attrs);
  }
  const span: Span = { traceId: ctx.trace!.traceId, spanId: spanId(), parentId: ctx.spanId, name: s.name, type: "db", kind: 3, start, duration: 0, attrs };
  try {
    const out = await go();
    const n = rows(out);
    if (n !== undefined) span.rows = n;
    span.status = 1;
    return out;
  } catch (e) {
    span.status = 2;
    span.error = (e as Error)?.message ?? String(e);
    throw e;
  } finally {
    span.duration = now() - start;
    push(ctx, span);
  }
};

// MongoDB has no statements: an operation on a collection is the span.
const operationSpan = async <T>(system: string, op: string, table: string, go: () => Promise<T>): Promise<T> => {
  const ctx = logContext.getStore();
  if (!ctx?.trace) return go();
  const start = now();
  const attrs: Attrs = { "db.system.name": system, "db.operation.name": op, "db.collection.name": table };
  const span: Span = { traceId: ctx.trace.traceId, spanId: spanId(), parentId: ctx.spanId, name: `${op} ${table}`, type: "db", kind: 3, start, duration: 0, attrs };
  try {
    const out = await go();
    if (Array.isArray(out)) span.rows = out.length;
    span.status = 1;
    return out;
  } catch (e) {
    span.status = 2;
    span.error = (e as Error)?.message ?? String(e);
    throw e;
  } finally {
    span.duration = now() - start;
    push(ctx, span);
  }
};

const rowCount = (rows: unknown[]) => rows.length;
const noRows = () => undefined;

/** A transaction handle whose statements become `db` spans when they run inside a traced call (a class: a transaction is made per call, and closures were most of its cost). */
class TracedTx implements DbTx {
  native?: NativeHandle;
  mongo?: DbTx["mongo"];
  constructor(
    private readonly tx: DbTx,
    private readonly system: string,
  ) {
    // The native engine answers the DocStore's operations itself (no statement of this wrapper's is made for them).
    if (tx.native) this.native = tx.native;
    if (tx.mongo) this.mongo = Object.fromEntries(Object.entries(tx.mongo).map(([op, f]) => [op, (table: string, ...rest: unknown[]) => operationSpan(system, op, table, () => (f as (...a: unknown[]) => Promise<unknown>)(table, ...rest))])) as unknown as DbTx["mongo"];
  }
  query<T = Record<string, any>>(sql: string, params?: unknown[]): Promise<T[]> {
    const ctx = logContext.getStore();
    return ctx?.trace ? statementSpan(this.system, ctx, sql, () => this.tx.query<T>(sql, params), rowCount) : this.tx.query<T>(sql, params);
  }
  execute(sql: string, params?: unknown[]): Promise<void> {
    const ctx = logContext.getStore();
    return ctx?.trace ? statementSpan(this.system, ctx, sql, () => this.tx.execute(sql, params), noRows) : this.tx.execute(sql, params);
  }
}

export function tracedTx(tx: DbTx, system: string): DbTx {
  return new TracedTx(tx, system);
}

// ---- outbound HTTP ----

let fetchPatched = false;

/**
 * An outbound call that is not a `fetch` (Forge RPC's WebSocket) made from inside a traced call: an `http` client span, and the
 * `traceparent` for the service to continue the trace with. Undefined when the call isn't traced, which is nearly always.
 */
export function outboundSpan(name: string, attrs: Attrs): { traceparent: string; end(error?: string): void } | undefined {
  const ctx = logContext.getStore();
  if (!ctx?.trace) return undefined;
  const id = spanId();
  const start = now();
  const span: Span = { traceId: ctx.trace.traceId, spanId: id, parentId: ctx.spanId, name, type: "http", kind: 3, start, duration: 0, attrs };
  return {
    traceparent: traceparent(ctx.trace.traceId, id),
    end(error) {
      span.duration = now() - start;
      span.status = error ? 2 : 1;
      if (error) span.error = error;
      push(ctx, span);
    },
  };
}

/**
 * Outbound fetches from inside a call become `http` client spans, and carry a `traceparent` header (unless they set one), so a service
 * that is traced too continues the same trace. The URL is recorded without its query string, which often holds credentials.
 */
export function instrumentFetch() {
  if (fetchPatched) return;
  fetchPatched = true;
  const original = globalThis.fetch;
  const traced = (async (input: string | URL | Request, init?: RequestInit) => {
    const ctx = logContext.getStore();
    if (!ctx?.trace) return original(input, init);
    const req = input instanceof Request ? input : undefined;
    const url = new URL(req ? req.url : String(input));
    const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
    const id = spanId();
    const headers = new Headers(init?.headers ?? req?.headers);
    if (!headers.has("traceparent")) headers.set("traceparent", traceparent(ctx.trace.traceId, id));
    const start = now();
    const attrs: Attrs = { "http.request.method": method, "server.address": url.hostname, "url.full": `${url.origin}${url.pathname}` };
    if (url.port) attrs["server.port"] = Number(url.port);
    const span: Span = { traceId: ctx.trace.traceId, spanId: id, parentId: ctx.spanId, name: `${method} ${url.host}`, type: "http", kind: 3, start, duration: 0, attrs };
    try {
      const res = await original(req ? new Request(req, { ...init, headers }) : input, { ...init, headers });
      attrs["http.response.status_code"] = res.status;
      span.status = res.status >= 500 ? 2 : 1;
      if (res.status >= 500) span.error = `${res.status} ${res.statusText}`;
      return res;
    } catch (e) {
      span.status = 2;
      span.error = (e as Error)?.message ?? String(e);
      throw e;
    } finally {
      span.duration = now() - start;
      push(ctx, span);
    }
  }) as typeof fetch;
  globalThis.fetch = Object.assign(traced, original);
}
