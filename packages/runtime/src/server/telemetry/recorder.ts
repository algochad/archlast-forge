// The server's side of telemetry. Every request is a root span: its outcome goes into per-minute rollups (counts, errors, a latency
// histogram) whether or not its trace is kept, so totals and percentiles are exact. Whole traces are tail-sampled once they finish:
// errors and slow requests have a budget of their own, the rest share another, and past a budget a trace is kept with the probability that
// keeps the rate near it and recorded with weight 1/probability, so per-user and per-error counts read from kept traces stay unbiased.
import type { LogEntry } from "../executor";
import { bucketOf } from "./histogram";
import { parseTraceparent, spanId as newSpanId, traceId as newTraceId } from "./ids";
import { selfTimes } from "./store";
import { apdexT } from "./traceway";
import type { CallTelemetry, TraceParent } from "./context";
import type { OtlpExporter } from "./export";
import type { Attrs, ErrorInfo, LogRecord, MetricPoint, RequestKind, RequestRecord, Rollup, RuntimeSample, Span, SpanRollup, TelemetryBatch, TraceRecord } from "./types";

/**
 * A request being handled. Its ids are made the first time something asks for them (a call into the runtime, a kept trace): a request
 * answered from the cache and not kept never needs any.
 */
export class Root {
  private ids?: { traceId: string; spanId: string };
  readonly time = Date.now();
  readonly t0 = performance.now();

  constructor(
    readonly kind: RequestKind,
    public operation: string,
    readonly method: string | undefined,
    /** The caller's trace, from an incoming `traceparent`. */
    private incoming: { traceId: string; parentId: string } | undefined,
    readonly requestId: string | undefined,
    readonly attrs: Attrs | undefined,
    /** Whether this request's spans are recorded; `weight` is how many requests it stands for in span statistics (1 / its chance). */
    readonly detail = true,
    readonly weight = 1,
  ) {}

  get traceId() {
    return (this.ids ??= { traceId: this.incoming?.traceId ?? newTraceId(), spanId: newSpanId() }).traceId;
  }
  get spanId() {
    return (this.ids ??= { traceId: this.incoming?.traceId ?? newTraceId(), spanId: newSpanId() }).spanId;
  }
  get parentId() {
    return this.incoming?.parentId;
  }
}

export interface Outcome {
  status: number;
  error?: ErrorInfo;
  telemetry?: CallTelemetry;
  /** Spans the server made itself (a page's cached loader calls). */
  spans?: Span[];
  cache?: "hit" | "miss" | "shared";
  user?: { id: string; name?: string };
  attrs?: Attrs;
  /** Not a request worth recording after all (a page's static asset). */
  discard?: boolean;
}

export interface TelemetryOptions {
  service: string;
  instance: string;
  /** Where batches go: the store's worker. */
  sink(batch: TelemetryBatch): void;
  exporter?: OtlpExporter;
  /** Kept traces per second for ordinary requests, and again for errors and slow ones. */
  tracesPerSecond: number;
  /** Requests per second recorded with every span (see Root.detail). Default 200. */
  detailPerSecond?: number;
  release(): string | undefined;
}

/** Distinct operations per minute and kind before the rest fold into "(other)", so a flood of unmatched paths can't grow memory. */
const MAX_OPERATIONS = 2000;

/** Spans' code unit on the time-by-code view: a forge module, a Nest class, the database, a remote host. */
function namespaceOf(s: Span): string {
  const a = s.attrs ?? {};
  if (a["code.namespace"]) return String(a["code.namespace"]);
  if (s.type === "db") return String(a["db.system.name"] ?? "database");
  if (s.type === "http") return String(a["server.address"] ?? "http");
  if (s.type === "custom") return s.name.split(".")[0]!;
  return s.type;
}

/** Ids and tokens in a path become `:id`, so `/reset-password/8f2c…` and `/users/41` group as one route. */
const normalized = new Map<string, string>();
let lastPath = "";
let lastNormal = "/";
export function normalizePath(path: string) {
  // the same path as the request before is the common case under load: a comparison, not a hash of a new string
  if (path === lastPath) return lastNormal;
  const found = normalizedOf(path);
  lastPath = path;
  return (lastNormal = found);
}
function normalizedOf(path: string) {
  let out = normalized.get(path);
  if (out === undefined) {
    out =
      path
        .split("/")
        .map((seg) => (/^\d+$|^[0-9a-f]{8}-[0-9a-f-]{27}$|^[0-9a-f]{16,}$|^(?=.*\d)[A-Za-z0-9_-]{20,}$/i.test(seg) ? ":id" : seg))
        .join("/") || "/";
    if (normalized.size >= 1000) normalized.clear(); // paths with ids in them are many; the ones a server sees most come back
    normalized.set(path, out);
  }
  return out;
}

/** An HTTP status for a call's outcome, as /rpc would answer it. */
export const statusOf = (kind: string | undefined) =>
  kind === "user" || kind === "validation" ? 400 : kind === "timeout" ? 408 : kind === "overloaded" ? 503 : kind ? 500 : 200;

/** Thrown on purpose: ForgeErrors, failed validation, and HTTP errors under 500. */
export const handledKind = (kind: string | undefined) => kind === "user" || kind === "validation";

function add(x: Rollup, ms: number, bucket: number, status: number, cached: boolean) {
  x.count++;
  if (status >= 500) x.errors++;
  else if (status >= 400) x.clientErrors++;
  if (cached) x.cached++;
  x.sum += ms;
  if (ms > x.max) x.max = ms;
  x.hist[bucket] = (x.hist[bucket] ?? 0) + 1;
}

type Minute = { ops: Map<string, Map<string, Rollup>>; size: number; all: Rollup; spans: Map<string, SpanRollup> };
const NO_SPANS: Span[] = [];

export class Telemetry {
  /** Rollups by minute: per operation, all requests together, and per span. Kept until their minute is over and sent. */
  private minutes = new Map<number, Minute>();
  private dirty = new Set<Rollup>();
  private dirtySpans = new Set<SpanRollup>();
  private traces: TraceRecord[] = [];
  private logs: LogRecord[] = [];
  private samples: RuntimeSample[] = [];
  private metrics: MetricPoint[] = [];
  private releases: { service: string; version: string; time: number }[] = [];
  private services: { service: string; attrs: Attrs; time: number }[] = [];
  private timer: Timer;
  /** The request rate: last second's count, and this second's so far. */
  private rate = 0;
  private rateSecond = 0;
  private rateCount = 0;
  /** Sampling: this second's counts and the keep probability each class got from the last one. */
  private second = 0;
  private seen = { normal: 0, notable: 0 };
  private kept = { normal: 0, notable: 0 };
  private chance = { normal: 1, notable: 1 };
  /** Requests begun and not yet ended, for the runtime samples. */
  inflight = 0;

  constructor(private o: TelemetryOptions) {
    this.timer = setInterval(() => this.flush(), 1000);
    this.timer.unref?.();
  }

  get service() {
    return this.o.service;
  }

  /**
   * Starts a request. Up to `detailPerSecond` requests a second are recorded with all their spans; past that a request is recorded in
   * detail with the chance that keeps to that rate (measured over the last second), and the rest are only counted: their function runs
   * untraced, which is what keeps telemetry cheap on a busy server. A caller that sent a sampled `traceparent` is always recorded, so
   * the trace it started has this side too; an unsampled one still joins the caller's trace, and is sampled like any other request.
   */
  begin(kind: RequestKind, operation: string, method?: string, incoming?: string | null, requestId?: string, attrs?: Attrs): Root {
    this.inflight++;
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.rateSecond) {
      this.rate = sec === this.rateSecond + 1 ? this.rateCount : 0;
      this.rateSecond = sec;
      this.rateCount = 0;
    }
    this.rateCount++;
    const parent = incoming ? parseTraceparent(incoming) : undefined;
    const budget = this.o.detailPerSecond ?? 200;
    const p = parent?.sampled || this.rate <= budget ? 1 : budget / this.rate;
    const detail = p >= 1 || Math.random() < p;
    return new Root(kind, operation, method, parent, requestId, attrs, detail, detail ? 1 / p : 1);
  }

  /** Where the runtime records the request's spans, under its root; nothing for a request that is only counted. */
  parent(root: Root): TraceParent | undefined {
    return root.detail ? { traceId: root.traceId, parentId: root.spanId } : undefined;
  }

  /**
   * Records a request. Most requests only count: the rollups always see them, but the request and span records are built only for a
   * trace that is kept (or exported).
   */
  end(root: Root, o: Outcome) {
    this.inflight--;
    if (o.discard) return;
    const duration = performance.now() - root.t0;
    const cached = o.cache === "hit" || o.cache === "shared";
    const minute = Math.floor(root.time / 60_000);
    this.count(minute, root.kind, root.operation, duration, o.status, cached);
    const own = o.telemetry?.spans ?? NO_SPANS;
    const spans = o.spans?.length ? [...o.spans, ...own] : own;
    if (spans.length) this.rollSpans(minute, spans, undefined, root.weight);
    const notable = Boolean(o.error) || o.status >= 500 || duration > 4 * apdexT(root.kind);
    // Errors and slow requests can be kept whatever their detail (without spans, if they weren't recorded); ordinary ones only when
    // they were, and then stand for the requests they were picked from too.
    const keep = notable ? this.decide("notable") : root.detail ? this.decide("normal") : 0;
    const weight = notable ? keep : keep * root.weight;
    if (!weight && !this.o.exporter) return;
    const attrs: Attrs = { ...(root.requestId && { "forge.request_id": root.requestId }), ...root.attrs, ...o.telemetry?.attrs, ...o.attrs };
    if (o.telemetry?.dropped) attrs["forge.dropped_spans"] = o.telemetry.dropped;
    const user = o.telemetry?.user ?? o.user;
    const request: RequestRecord = {
      traceId: root.traceId,
      spanId: root.spanId,
      time: root.time,
      duration,
      service: this.o.service,
      instance: this.o.instance,
      kind: root.kind,
      operation: root.operation,
      method: root.method,
      status: o.status,
      userId: user?.id,
      userName: user?.name,
      error: o.error,
      cache: o.cache,
      release: this.o.release(),
      weight: weight || 1,
      attrs,
    };
    const rootSpan: Span = {
      traceId: root.traceId,
      spanId: root.spanId,
      parentId: root.parentId,
      name: root.operation,
      type: "request",
      kind: 2,
      start: root.time,
      duration,
      status: o.status >= 500 ? 2 : 1,
      error: o.error?.message,
      attrs: { ...attrs, ...(root.method && { "forge.method": root.method }), "forge.kind": root.kind, ...(o.status && { "http.response.status_code": o.status }) },
    };
    const trace = { request, spans: [rootSpan, ...spans] };
    this.o.exporter?.export(trace.spans, request);
    if (weight && this.traces.length < 20_000) this.traces.push(trace);
  }

  /** A whole trace the runtime started itself (a scheduled job): counted like a request, its root being the job. */
  record(trace: TraceRecord) {
    const r = trace.request;
    r.service ||= this.o.service;
    r.instance ??= this.o.instance;
    r.release ??= this.o.release();
    const minute = Math.floor(r.time / 60_000);
    this.count(minute, r.kind, r.operation, r.duration, r.status, r.cache === "hit" || r.cache === "shared");
    if (trace.spans.length > 1) this.rollSpans(minute, trace.spans, r.spanId, trace.detailWeight ?? 1);
    this.o.exporter?.export(trace.spans, r);
    const notable = Boolean(r.error) || r.status >= 500 || r.duration > 4 * apdexT(r.kind);
    const weight = this.decide(notable ? "notable" : "normal");
    if (!weight) return;
    r.weight = weight;
    if (this.traces.length < 20_000) this.traces.push(trace);
  }

  /** 0 to drop the trace, else the weight to keep it with. */
  private decide(cls: "normal" | "notable"): number {
    const sec = Math.floor(Date.now() / 1000);
    if (sec !== this.second) {
      const budget = this.o.tracesPerSecond;
      // From the last second's volume (a second with no traffic resets to keeping everything).
      for (const c of ["normal", "notable"] as const) this.chance[c] = sec === this.second + 1 && this.seen[c] > budget ? budget / this.seen[c] : 1;
      this.second = sec;
      this.seen = { normal: 0, notable: 0 };
      this.kept = { normal: 0, notable: 0 };
    }
    this.seen[cls]++;
    if (this.kept[cls] >= this.o.tracesPerSecond * 2) return 0; // a burst inside one second
    const p = this.chance[cls];
    if (p < 1 && Math.random() >= p) return 0;
    this.kept[cls]++;
    return 1 / p;
  }

  private minute(m: number): Minute {
    let e = this.minutes.get(m);
    if (!e) this.minutes.set(m, (e = { ops: new Map(), size: 0, all: this.rollupOf(m, "*", "*"), spans: new Map() }));
    return e;
  }

  private rollupOf(minute: number, kind: string, operation: string): Rollup {
    return { minute, service: this.o.service, kind, operation, instance: this.o.instance, count: 0, errors: 0, clientErrors: 0, cached: 0, sum: 0, max: 0, hist: {} };
  }

  /** The rollup the last request went into: the next one, in the same minute and under the same name, needs no lookups. */
  private last?: { minute: number; kind: string; operation: string; rollup: Rollup; all: Rollup };

  private count(minute: number, kind: string, operation: string, ms: number, status: number, cached: boolean) {
    let hit = this.last;
    if (!hit || hit.minute !== minute || hit.kind !== kind || hit.operation !== operation) {
      const m = this.minute(minute);
      let ops = m.ops.get(kind);
      if (!ops) m.ops.set(kind, (ops = new Map()));
      let r = ops.get(operation);
      if (!r) {
        const name = m.size >= MAX_OPERATIONS ? "(other)" : operation;
        r = ops.get(name);
        if (!r) ops.set(name, (r = this.rollupOf(minute, kind, name))), m.size++;
      }
      hit = this.last = { minute, kind, operation, rollup: r, all: m.all };
    }
    const bucket = bucketOf(ms);
    add(hit.rollup, ms, bucket, status, cached);
    add(hit.all, ms, bucket, status, cached);
    this.dirty.add(hit.rollup);
    this.dirty.add(hit.all);
  }

  /** Every span but the root (`skip`), with the time it spent in its own code, counted `weight` times (a sampled request's share). */
  private rollSpans(minute: number, spans: Span[], skip: string | undefined, weight: number) {
    const m = this.minute(minute);
    const self = selfTimes(spans);
    for (const s of spans) {
      if (s.spanId === skip) continue;
      // By type and name (a span's code unit follows from them); spans from other services keep theirs apart.
      const key = s.service === undefined ? `${s.type}\u0000${s.name}` : `${s.service}\u0000${s.type}\u0000${s.name}`;
      let r = m.spans.get(key);
      if (!r) {
        if (m.spans.size >= 20_000) continue;
        m.spans.set(key, (r = { minute, service: s.service ?? this.o.service, type: s.type, name: s.name, namespace: namespaceOf(s), instance: this.o.instance, count: 0, errors: 0, sum: 0, self: 0, max: 0, hist: {} }));
      }
      r.count += weight;
      if (s.status === 2) r.errors += weight;
      r.sum += s.duration * weight;
      r.self += (self.get(s.spanId) ?? s.duration) * weight;
      if (s.duration > r.max) r.max = s.duration;
      const b = bucketOf(s.duration);
      r.hist[b] = (r.hist[b] ?? 0) + weight;
      this.dirtySpans.add(r);
    }
  }

  /** App log lines (not the per-call entries, which requests already are). */
  log(e: LogEntry) {
    if (e.level === "call") return;
    if (this.logs.length >= 50_000) return;
    this.logs.push({
      time: e.time,
      service: this.o.service,
      instance: this.o.instance,
      level: e.level,
      name: e.name,
      message: e.message,
      traceId: e.traceId,
      spanId: e.spanId,
      ...(e.requestId && { attrs: { "forge.request_id": e.requestId } }),
    });
  }

  sample(s: Omit<RuntimeSample, "service">) {
    this.samples.push({ ...s, service: this.o.service });
  }

  metricPoints(points: Omit<MetricPoint, "service" | "instance">[], instance: string) {
    for (const p of points) this.metrics.push({ ...p, service: this.o.service, instance });
  }

  release(version: string) {
    this.releases.push({ service: this.o.service, version, time: Date.now() });
  }

  /** What the engine says about itself on the Services page (OpenTelemetry resource attributes). */
  describe(attrs: Attrs) {
    this.services.push({ service: this.o.service, attrs, time: Date.now() });
  }

  flush() {
    const current = Math.floor(Date.now() / 60_000);
    const batch: TelemetryBatch = {};
    if (this.traces.length) batch.traces = this.traces.splice(0);
    if (this.logs.length) batch.logs = this.logs.splice(0);
    if (this.dirty.size) batch.rollups = [...this.dirty].map((r) => ({ ...r, hist: { ...r.hist } }));
    if (this.dirtySpans.size) batch.spanRollups = [...this.dirtySpans].map((r) => ({ ...r, hist: { ...r.hist } }));
    if (this.samples.length) batch.samples = this.samples.splice(0);
    if (this.metrics.length) batch.metrics = this.metrics.splice(0);
    if (this.releases.length) batch.releases = this.releases.splice(0);
    if (this.services.length) batch.services = this.services.splice(0);
    this.dirty.clear();
    this.dirtySpans.clear();
    // Minutes that are over were sent in full above; their rows are final.
    for (const m of this.minutes.keys()) if (m < current - 1) this.minutes.delete(m);
    if (Object.keys(batch).length) this.o.sink(batch);
  }

  async close() {
    clearInterval(this.timer);
    this.flush();
    await this.o.exporter?.close();
  }
}
