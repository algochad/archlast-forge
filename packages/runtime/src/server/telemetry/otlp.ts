// OTLP ingest: other services (a NestJS app with the OpenTelemetry SDK, a worker, a frontend's server) send traces, logs and metrics to
// /otlp/v1/{traces,logs,metrics} as protobuf or JSON, and they land in the same store as the engine's own. OpenTelemetry's semantic
// conventions say what a span is: SERVER and CONSUMER spans are requests and jobs, `db.*` client spans are queries, `http.*` client spans
// are outbound calls, and `exception` events are errors. Rollups for ingested requests are kept here like the server keeps its own.
import { record as recordHist } from "./histogram";
import { decode, LogsRequest, MetricsRequest, TracesRequest } from "./protobuf";
import { normalizePath } from "./recorder";
import { selfTimes } from "./store";
import type { Attrs, ErrorInfo, LogRecord, MetricPoint, RequestKind, Rollup, Span, SpanRollup, TelemetryBatch, TraceRecord } from "./types";

export type Signal = "traces" | "logs" | "metrics";

const camel = (k: string) => k.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
/** protojson accepts snake_case field names too; the converter reads camelCase. */
function camelKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(camelKeys);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [camel(k), camelKeys(x)]));
  return v;
}

export function parse(signal: Signal, body: Uint8Array, contentType: string): any {
  if (contentType.includes("json")) return camelKeys(JSON.parse(new TextDecoder().decode(body)));
  return decode(body, signal === "traces" ? TracesRequest : signal === "logs" ? LogsRequest : MetricsRequest);
}

type AnyValue = { stringValue?: string; boolValue?: boolean; intValue?: string | number; doubleValue?: number; arrayValue?: { values?: AnyValue[] }; kvlistValue?: { values?: KV[] }; bytesValue?: string };
type KV = { key: string; value?: AnyValue };

function valueOf(v: AnyValue | undefined): string | number | boolean | undefined {
  if (!v) return undefined;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.boolValue !== undefined) return v.boolValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return Number(v.doubleValue);
  if (v.arrayValue) return JSON.stringify((v.arrayValue.values ?? []).map(valueOf));
  if (v.kvlistValue) return JSON.stringify(Object.fromEntries((v.kvlistValue.values ?? []).map((kv) => [kv.key, valueOf(kv.value)])));
  if (v.bytesValue !== undefined) return v.bytesValue;
  return undefined;
}

export function attrsOf(kvs: KV[] | undefined): Attrs {
  const out: Attrs = {};
  for (const kv of kvs ?? []) {
    const v = valueOf(kv.value);
    if (v !== undefined) out[kv.key] = typeof v === "string" && v.length > 4000 ? v.slice(0, 4000) : v;
  }
  return out;
}

const KINDS: Record<string, number> = { SPAN_KIND_UNSPECIFIED: 0, SPAN_KIND_INTERNAL: 1, SPAN_KIND_SERVER: 2, SPAN_KIND_CLIENT: 3, SPAN_KIND_PRODUCER: 4, SPAN_KIND_CONSUMER: 5 };
const kindOf = (k: unknown) => (typeof k === "string" ? (KINDS[k] ?? 1) : Number(k ?? 1)) || 1;
const statusCode = (s: unknown) => (s === "STATUS_CODE_ERROR" ? 2 : s === "STATUS_CODE_OK" ? 1 : Number(s ?? 0));
const ms = (nanos: unknown) => (nanos === undefined || nanos === null || nanos === "" ? 0 : Number(nanos) / 1e6);
const hexId = (id: unknown) => {
  if (typeof id !== "string" || !id) return undefined;
  // Some exporters send ids base64-encoded (protobuf's bytes in JSON) instead of hex.
  if (/^[0-9a-f]+$/i.test(id) && (id.length === 32 || id.length === 16)) return id.toLowerCase();
  const b = Buffer.from(id, "base64");
  return b.length === 16 || b.length === 8 ? b.toString("hex") : undefined;
};

const SEVERITY = ["", "trace", "trace", "trace", "trace", "debug", "debug", "debug", "debug", "info", "info", "info", "info", "warn", "warn", "warn", "warn", "error", "error", "error", "error", "fatal", "fatal", "fatal", "fatal"];

function classify(name: string, kind: number, a: Attrs): { type: Span["type"]; name: string; namespace?: string } {
  const db = a["db.system.name"] ?? a["db.system"];
  if (db) {
    const op = a["db.operation.name"] ?? a["db.operation"];
    const coll = a["db.collection.name"] ?? a["db.sql.table"] ?? a["db.mongodb.collection"];
    return { type: "db", name: String(a["db.query.summary"] ?? (op ? `${op}${coll ? ` ${coll}` : ""}` : name)), namespace: String(db) };
  }
  const method = a["http.request.method"] ?? a["http.method"];
  if (kind === 3 && method) {
    const url = String(a["url.full"] ?? a["http.url"] ?? "");
    let host = String(a["server.address"] ?? a["net.peer.name"] ?? a["peer.service"] ?? "");
    if (!host && url) host = URL.canParse(url) ? new URL(url).hostname : "";
    return { type: "http", name: `${method} ${host || name}`, namespace: host || "http" };
  }
  if (a["messaging.system"] && (kind === 4 || kind === 3)) return { type: "queue", name, namespace: String(a["messaging.system"]) };
  if (kind === 2 || kind === 5) return { type: "request", name };
  // @opentelemetry/instrumentation-nestjs-core marks controllers and handlers; `code.namespace` is the general convention.
  const ns = a["code.namespace"] ?? a["nestjs.controller"] ?? a["code.function.name"]?.toString().split(".").slice(0, -1).join(".");
  return { type: "custom", name, namespace: ns ? String(ns) : undefined };
}

function exceptionOf(span: any, status: number): ErrorInfo | undefined {
  const ev = (span.events ?? []).find((e: any) => e.name === "exception");
  const a = ev ? attrsOf(ev.attributes) : {};
  const failed = statusCode(span.status?.code) === 2 || status >= 500;
  if (!ev && !failed) return undefined;
  return {
    type: String(a["exception.type"] ?? (status >= 500 ? `HTTP ${status}` : "Error")),
    message: String(a["exception.message"] ?? span.status?.message ?? (status ? `HTTP ${status}` : span.name)),
    stack: a["exception.stacktrace"] ? String(a["exception.stacktrace"]) : undefined,
    handled: status > 0 && status < 500 && !failed,
  };
}

const namespaceOf = (s: Span, ns?: string) => ns ?? (s.type === "custom" ? s.name.split(".")[0]! : s.type);

/** Turns OTLP payloads into store batches, keeping rollups for the requests it sees (as instance `otlp:<this worker>`). */
export class OtlpIngest {
  private instance = `otlp:${crypto.randomUUID().slice(0, 8)}`;
  private rollups = new Map<string, Rollup>();
  private spanRollups = new Map<string, SpanRollup>();
  private dirty = new Set<string>();
  private dirtySpans = new Set<string>();
  /** Last value of each cumulative series, to turn running totals into per-minute increases. */
  private cumulative = new Map<string, { start: string; time: number; value: number; count: number }>();
  private points = new Map<string, MetricPoint>();
  private dirtyPoints = new Set<string>();

  traces(payload: any, override?: string | null): TelemetryBatch {
    const traces: TraceRecord[] = [];
    const loose: Span[] = [];
    const services: NonNullable<TelemetryBatch["services"]> = [];
    const releases: NonNullable<TelemetryBatch["releases"]> = [];
    for (const rs of payload?.resourceSpans ?? []) {
      const res = attrsOf(rs.resource?.attributes);
      const service = override || String(res["service.name"] ?? "unknown_service");
      services.push({ service, attrs: res, time: Date.now() });
      const version = res["service.version"] === undefined ? undefined : String(res["service.version"]).slice(0, 64);
      const raw = (rs.scopeSpans ?? []).flatMap((ss: any) => (ss.spans ?? []).map((s: any) => ({ s, scope: ss.scope?.name as string | undefined })));
      const spans: { span: Span; raw: any; namespace?: string }[] = [];
      for (const { s, scope } of raw) {
        const traceId = hexId(s.traceId);
        const spanId = hexId(s.spanId);
        if (!traceId || !spanId) continue;
        const kind = kindOf(s.kind);
        const attrs = attrsOf(s.attributes);
        if (scope) attrs["otel.scope.name"] = scope;
        const start = ms(s.startTimeUnixNano);
        const c = classify(String(s.name ?? ""), kind, attrs);
        const status = statusCode(s.status?.code);
        const span: Span = {
          traceId,
          spanId,
          parentId: hexId(s.parentSpanId),
          name: c.name.slice(0, 300),
          type: c.type,
          kind,
          start,
          duration: Math.max(0, ms(s.endTimeUnixNano) - start),
          status: status === 2 ? 2 : 1,
          error: status === 2 ? s.status?.message || exceptionOf(s, 0)?.message : undefined,
          attrs,
          service,
        };
        spans.push({ span, raw: s, namespace: c.namespace });
      }
      // A service's version (OpenTelemetry's service.version) is its release, compared like the engine's own: from its earliest span.
      if (version && spans.length) releases.push({ service, version, time: Math.min(...spans.map((s) => s.span.start)) });
      const byTrace = new Map<string, typeof spans>();
      for (const x of spans) (byTrace.get(x.span.traceId) ?? byTrace.set(x.span.traceId, []).get(x.span.traceId)!).push(x);
      for (const group of byTrace.values()) {
        const self = selfTimes(group.map((g) => g.span));
        const entries = group.filter((g) => g.span.kind === 2 || g.span.kind === 5);
        for (const g of group) if (g.span.type !== "request") this.spanRollup(g.span, self.get(g.span.spanId) ?? g.span.duration, namespaceOf(g.span, g.namespace));
        if (!entries.length) {
          loose.push(...group.map((g) => g.span));
          continue;
        }
        entries.forEach((e, i) => {
          const a = e.span.attrs ?? {};
          const method = a["http.request.method"] ?? a["http.method"];
          const route = a["http.route"] ?? (a["url.path"] ? normalizePath(String(a["url.path"])) : a["http.target"] ? normalizePath(String(a["http.target"]).split("?")[0]!) : undefined);
          const httpStatus = Number(a["http.response.status_code"] ?? a["http.status_code"] ?? 0);
          const failed = e.span.status === 2;
          const status = httpStatus || (failed ? 500 : 200);
          const kind: RequestKind = e.span.kind === 5 ? "consumer" : method ? "http" : "server";
          const operation = method && route ? `${method} ${route}` : e.span.name;
          // The trace's exception: on the entry span itself, else the first span that recorded one.
          const error = exceptionOf(e.raw, status) ?? (failed || status >= 500 ? group.map((g) => exceptionOf(g.raw, 0)).find(Boolean) : undefined);
          const user = a["enduser.id"] ?? a["user.id"] ?? a["user.email"];
          const record: TraceRecord = {
            request: {
              traceId: e.span.traceId,
              spanId: e.span.spanId,
              time: e.span.start,
              duration: e.span.duration,
              service,
              instance: String(res["service.instance.id"] ?? res["host.name"] ?? ""),
              kind,
              operation: operation.slice(0, 300),
              method: method ? String(method) : kind === "consumer" ? "CONSUMER" : undefined,
              status,
              userId: user === undefined ? undefined : String(user),
              userName: a["user.email"] !== undefined ? String(a["user.email"]) : a["user.name"] !== undefined ? String(a["user.name"]) : undefined,
              error,
              release: res["service.version"] === undefined ? undefined : String(res["service.version"]),
              weight: 1,
              attrs: a,
            },
            // The first entry carries the trace's other spans; any further one only itself.
            spans: i === 0 ? group.map((g) => g.span) : [e.span],
          };
          traces.push(record);
          this.rollup(e.span.start, service, kind, record.request.operation, e.span.duration, status >= 500 || (failed && !httpStatus), status >= 400 && status < 500);
        });
      }
    }
    return { traces, ...(loose.length && { spans: loose }), services, ...(releases.length && { releases }), ...this.drain() };
  }

  logs(payload: any, override?: string | null): TelemetryBatch {
    const logs: LogRecord[] = [];
    const services: NonNullable<TelemetryBatch["services"]> = [];
    for (const rl of payload?.resourceLogs ?? []) {
      const res = attrsOf(rl.resource?.attributes);
      const service = override || String(res["service.name"] ?? "unknown_service");
      services.push({ service, attrs: res, time: Date.now() });
      for (const sl of rl.scopeLogs ?? [])
        for (const l of sl.logRecords ?? []) {
          const attrs = attrsOf(l.attributes);
          const body = valueOf(l.body);
          const sev = Number(l.severityNumber ?? 0);
          logs.push({
            time: ms(l.timeUnixNano) || ms(l.observedTimeUnixNano) || Date.now(),
            service,
            instance: res["service.instance.id"] === undefined ? undefined : String(res["service.instance.id"]),
            level: (l.severityText ? String(l.severityText).toLowerCase() : SEVERITY[sev]) || "info",
            name: String(attrs["logger.name"] ?? attrs["context"] ?? sl.scope?.name ?? l.eventName ?? service),
            message: body === undefined ? String(l.eventName ?? "") : String(body),
            traceId: hexId(l.traceId),
            spanId: hexId(l.spanId),
            attrs,
          });
        }
    }
    return { logs, services };
  }

  metrics(payload: any, override?: string | null): TelemetryBatch {
    const services: NonNullable<TelemetryBatch["services"]> = [];
    for (const rm of payload?.resourceMetrics ?? []) {
      const res = attrsOf(rm.resource?.attributes);
      const service = override || String(res["service.name"] ?? "unknown_service");
      services.push({ service, attrs: res, time: Date.now() });
      for (const sm of rm.scopeMetrics ?? [])
        for (const m of sm.metrics ?? []) {
          const name = String(m.name ?? "");
          if (!name) continue;
          const unit = m.unit ? String(m.unit) : undefined;
          if (m.gauge || (m.sum && !m.sum.isMonotonic))
            for (const p of (m.gauge ?? m.sum).dataPoints ?? []) this.point(service, name, "gauge", unit, p, Number(p.asDouble ?? p.asInt ?? 0), 1, false);
          else if (m.sum)
            for (const p of m.sum.dataPoints ?? []) this.point(service, name, "counter", unit, p, Number(p.asDouble ?? p.asInt ?? 0), 1, Number(m.sum.aggregationTemporality) === 2 || m.sum.aggregationTemporality === "AGGREGATION_TEMPORALITY_CUMULATIVE");
          else
            for (const kind of ["histogram", "exponentialHistogram", "summary"] as const)
              for (const p of m[kind]?.dataPoints ?? [])
                this.point(service, name, "histogram", unit, p, Number(p.sum ?? 0), Number(p.count ?? 0), kind !== "summary" && (Number(m[kind].aggregationTemporality) === 2 || m[kind].aggregationTemporality === "AGGREGATION_TEMPORALITY_CUMULATIVE") || kind === "summary");
        }
    }
    return { services, ...this.drain() };
  }

  /** One data point into its minute; running totals become increases against the last value seen for the series. */
  private point(service: string, name: string, type: MetricPoint["type"], unit: string | undefined, p: any, value: number, count: number, cumulative: boolean) {
    const attrs = attrsOf(p.attributes);
    const key = JSON.stringify(Object.fromEntries(Object.keys(attrs).sort().map((k) => [k, attrs[k]])));
    const time = ms(p.timeUnixNano) || Date.now();
    const minute = Math.floor(time / 60_000);
    let delta = value;
    let deltaCount = count;
    let total: number | undefined;
    if (cumulative && type !== "gauge") {
      const series = `${service}\u0000${name}\u0000${key}`;
      const last = this.cumulative.get(series);
      const start = String(p.startTimeUnixNano ?? "");
      // A running total starts over when it goes down, or when its start time moves past the previous reading (OpenTelemetry's sign
      // of a reset). An exporter that restates the start time with every export, still counting up, is not starting over.
      const restarted = !last || value < last.value || (start !== last.start && ms(start) > last.time);
      delta = restarted ? (last ? value : 0) : value - last.value;
      deltaCount = restarted ? (last ? count : 0) : count - last.count;
      this.cumulative.set(series, { start, time, value, count });
      if (this.cumulative.size > 50_000) this.cumulative.clear();
      total = value;
    }
    const k = `${minute}\u0000${service}\u0000${name}\u0000${key}`;
    let point = this.points.get(k);
    if (!point) this.points.set(k, (point = { minute, service, name, type, unit, attrs: key, instance: this.instance, value: 0, count: 0, min: Infinity, max: -Infinity }));
    point.value = type === "gauge" ? value : point.value + delta;
    point.count += type === "gauge" ? 1 : deltaCount;
    const lo = p.min ?? (type === "histogram" ? undefined : value);
    const hi = p.max ?? (type === "histogram" ? undefined : value);
    if (lo !== undefined) point.min = Math.min(point.min, Number(lo));
    if (hi !== undefined) point.max = Math.max(point.max, Number(hi));
    if (total !== undefined) point.total = total;
    this.dirtyPoints.add(k);
  }

  private rollup(time: number, service: string, kind: string, operation: string, duration: number, error: boolean, clientError: boolean) {
    const minute = Math.floor(time / 60_000);
    for (const [k, op] of [
      [kind, operation],
      ["*", "*"],
    ] as const) {
      const key = `${minute}\u0000${service}\u0000${k}\u0000${op}`;
      let r = this.rollups.get(key);
      if (!r) this.rollups.set(key, (r = { minute, service, kind: k, operation: op, instance: this.instance, count: 0, errors: 0, clientErrors: 0, cached: 0, sum: 0, max: 0, hist: {} }));
      r.count++;
      if (error) r.errors++;
      if (clientError) r.clientErrors++;
      r.sum += duration;
      r.max = Math.max(r.max, duration);
      recordHist(r.hist, duration);
      this.dirty.add(key);
    }
  }

  private spanRollup(s: Span, self: number, namespace: string) {
    const minute = Math.floor(s.start / 60_000);
    const key = `${minute}\u0000${s.service}\u0000${s.type}\u0000${s.name}\u0000${namespace}`;
    let r = this.spanRollups.get(key);
    if (!r) this.spanRollups.set(key, (r = { minute, service: s.service!, type: s.type, name: s.name, namespace, instance: this.instance, count: 0, errors: 0, sum: 0, self: 0, max: 0, hist: {} }));
    r.count++;
    if (s.status === 2) r.errors++;
    r.sum += s.duration;
    r.self += self;
    r.max = Math.max(r.max, s.duration);
    recordHist(r.hist, s.duration);
    this.dirtySpans.add(key);
  }

  /** Changed rollups and metric points, as they stand; old minutes are forgotten once sent. */
  drain(): TelemetryBatch {
    const now = Math.floor(Date.now() / 60_000);
    const out: TelemetryBatch = {};
    if (this.dirty.size) out.rollups = [...this.dirty].map((k) => ({ ...this.rollups.get(k)!, hist: { ...this.rollups.get(k)!.hist } }));
    if (this.dirtySpans.size) out.spanRollups = [...this.dirtySpans].map((k) => ({ ...this.spanRollups.get(k)!, hist: { ...this.spanRollups.get(k)!.hist } }));
    if (this.dirtyPoints.size)
      out.metrics = [...this.dirtyPoints].map((k) => {
        const p = this.points.get(k)!;
        return { ...p, min: Number.isFinite(p.min) ? p.min : p.value, max: Number.isFinite(p.max) ? p.max : p.value };
      });
    this.dirty.clear();
    this.dirtySpans.clear();
    this.dirtyPoints.clear();
    // Late spans can still land in a minute an hour old; past that, a minute's row is final.
    for (const [k, r] of this.rollups) if (r.minute < now - 60) this.rollups.delete(k);
    for (const [k, r] of this.spanRollups) if (r.minute < now - 60) this.spanRollups.delete(k);
    for (const [k, p] of this.points) if (p.minute < now - 60) this.points.delete(k);
    return out;
  }
}
