import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import protobuf from "protobufjs";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";
import { startServer, type RunningServer } from "../src/server/server";
import { loadConfig } from "../src/server/config";
import { countUnder, quantile, record, type Histogram } from "../src/server/telemetry/histogram";
import { OtlpIngest, parse } from "../src/server/telemetry/otlp";
import { buildQueries } from "../src/server/telemetry/queries";
import { Telemetry, normalizePath } from "../src/server/telemetry/recorder";
import { buildSettings } from "../src/server/telemetry/settings";
import { migrateTelemetry, selfTimes, TelemetryStore } from "../src/server/telemetry/store";
import { fingerprint, impactReason, impactScore } from "../src/server/telemetry/traceway";
import type { Span, TelemetryBatch, TraceRecord } from "../src/server/telemetry/types";
import { dbAdapters, tempDir } from "./helpers";

// A subset of opentelemetry-proto, encoded with protobufjs: an implementation independent of the engine's decoder.
const proto = protobuf.parse(`
syntax = "proto3";
message AnyValue { oneof value { string string_value = 1; bool bool_value = 2; int64 int_value = 3; double double_value = 4; ArrayValue array_value = 5; KeyValueList kvlist_value = 6; bytes bytes_value = 7; } }
message ArrayValue { repeated AnyValue values = 1; }
message KeyValueList { repeated KeyValue values = 1; }
message KeyValue { string key = 1; AnyValue value = 2; }
message Resource { repeated KeyValue attributes = 1; }
message InstrumentationScope { string name = 1; string version = 2; }
message Status { string message = 2; int32 code = 3; }
message Event { fixed64 time_unix_nano = 1; string name = 2; repeated KeyValue attributes = 3; }
message Span { bytes trace_id = 1; bytes span_id = 2; string trace_state = 3; bytes parent_span_id = 4; string name = 5; int32 kind = 6; fixed64 start_time_unix_nano = 7; fixed64 end_time_unix_nano = 8; repeated KeyValue attributes = 9; repeated Event events = 11; Status status = 15; }
message ScopeSpans { InstrumentationScope scope = 1; repeated Span spans = 2; }
message ResourceSpans { Resource resource = 1; repeated ScopeSpans scope_spans = 2; }
message ExportTraceServiceRequest { repeated ResourceSpans resource_spans = 1; }
message LogRecord { fixed64 time_unix_nano = 1; int32 severity_number = 2; string severity_text = 3; AnyValue body = 5; repeated KeyValue attributes = 6; bytes trace_id = 9; bytes span_id = 10; }
message ScopeLogs { InstrumentationScope scope = 1; repeated LogRecord log_records = 2; }
message ResourceLogs { Resource resource = 1; repeated ScopeLogs scope_logs = 2; }
message ExportLogsServiceRequest { repeated ResourceLogs resource_logs = 1; }
message NumberDataPoint { fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; double as_double = 4; sfixed64 as_int = 6; repeated KeyValue attributes = 7; }
message Sum { repeated NumberDataPoint data_points = 1; int32 aggregation_temporality = 2; bool is_monotonic = 3; }
message Gauge { repeated NumberDataPoint data_points = 1; }
message HistogramDataPoint { fixed64 start_time_unix_nano = 2; fixed64 time_unix_nano = 3; fixed64 count = 4; double sum = 5; repeated fixed64 bucket_counts = 6; repeated double explicit_bounds = 7; repeated KeyValue attributes = 9; double min = 11; double max = 12; }
message Histogram { repeated HistogramDataPoint data_points = 1; int32 aggregation_temporality = 2; }
message Metric { string name = 1; string description = 2; string unit = 3; oneof data { Gauge gauge = 5; Sum sum = 7; Histogram histogram = 9; } }
message ScopeMetrics { InstrumentationScope scope = 1; repeated Metric metrics = 2; }
message ResourceMetrics { Resource resource = 1; repeated ScopeMetrics scope_metrics = 2; }
message ExportMetricsServiceRequest { repeated ResourceMetrics resource_metrics = 1; }
`).root;

const kv = (key: string, v: string | number | boolean) => ({
  key,
  value: typeof v === "string" ? { stringValue: v } : typeof v === "boolean" ? { boolValue: v } : Number.isInteger(v) ? { intValue: v } : { doubleValue: v },
});
const hex = (s: string) => Buffer.from(s, "hex");
const nanos = (ms: number) => String(BigInt(Math.round(ms)) * 1_000_000n);
const TRACE = "4bf92f3577b34da6a3ce929d0e0e4736";

/** A NestJS service's export, as the OpenTelemetry SDK would send it: a server span, a database span under it, and a failing one. */
function nestExport(now: number, opts: { fail?: boolean } = {}) {
  return {
    resourceSpans: [
      {
        resource: { attributes: [kv("service.name", "billing-api"), kv("service.version", "3f9a2c1"), kv("telemetry.sdk.language", "nodejs")] },
        scopeSpans: [
          {
            scope: { name: "@opentelemetry/instrumentation-http" },
            spans: [
              {
                traceId: hex(TRACE),
                spanId: hex("00f067aa0ba902b7"),
                name: "GET /invoices/:id",
                kind: 2,
                startTimeUnixNano: nanos(now - 120),
                endTimeUnixNano: nanos(now),
                attributes: [
                  kv("http.request.method", "GET"),
                  kv("http.route", "/invoices/:id"),
                  kv("http.response.status_code", opts.fail ? 500 : 200),
                  kv("enduser.id", "carol@example.com"),
                ],
                status: { code: opts.fail ? 2 : 1 },
                events: opts.fail
                  ? [
                      {
                        timeUnixNano: nanos(now - 5),
                        name: "exception",
                        attributes: [
                          kv("exception.type", "TypeError"),
                          kv("exception.message", "Cannot read properties of undefined (reading 'total')"),
                          kv(
                            "exception.stacktrace",
                            "TypeError: Cannot read properties of undefined (reading 'total')\n    at InvoiceService.finalise (/app/src/billing/invoice.service.ts:193:28)\n    at InvoicesController.get (/app/src/billing/invoices.controller.ts:40:12)",
                          ),
                        ],
                      },
                    ]
                  : [],
              },
              {
                traceId: hex(TRACE),
                spanId: hex("a1a2a3a4a5a6a7a8"),
                parentSpanId: hex("00f067aa0ba902b7"),
                name: "pg.query:SELECT",
                kind: 3,
                startTimeUnixNano: nanos(now - 100),
                endTimeUnixNano: nanos(now - 60),
                attributes: [kv("db.system", "postgresql"), kv("db.operation", "SELECT"), kv("db.sql.table", "invoices"), kv("db.statement", "SELECT * FROM invoices WHERE id = $1")],
                status: { code: 1 },
              },
              {
                traceId: hex(TRACE),
                spanId: hex("b1b2b3b4b5b6b7b8"),
                parentSpanId: hex("00f067aa0ba902b7"),
                name: "POST",
                kind: 3,
                startTimeUnixNano: nanos(now - 50),
                endTimeUnixNano: nanos(now - 10),
                attributes: [kv("http.request.method", "POST"), kv("server.address", "api.stripe.com"), kv("http.response.status_code", 200)],
                status: { code: 1 },
              },
            ],
          },
        ],
      },
    ],
  };
}

const encode = (type: string, payload: object) => {
  const T = proto.lookupType(type);
  return new Uint8Array(T.encode(T.fromObject(payload)).finish());
};

describe("histograms", () => {
  test("percentiles are within a few percent at any scale", () => {
    for (const scale of [0.05, 1, 40, 3000]) {
      const h: Histogram = {};
      for (let i = 1; i <= 1000; i++) record(h, i * scale);
      expect(Math.abs(quantile(h, 0.5) / (500 * scale) - 1)).toBeLessThan(0.05);
      expect(Math.abs(quantile(h, 0.95) / (950 * scale) - 1)).toBeLessThan(0.05);
      expect(Math.abs(countUnder(h, 250 * scale) / 250 - 1)).toBeLessThan(0.05);
    }
  });

  test("an empty histogram reads zero", () => {
    expect(quantile({}, 0.95)).toBe(0);
  });
});

describe("ported from Traceway", () => {
  const stack = (id: number, dir: string, engineLine: number) =>
    `TypeError: Cannot read properties of undefined (reading 'x') for order ${id}\n    at finalise (/srv/${dir}/forge/billing.ts:193:28)\n    at handler (/srv/${dir}/forge/billing.ts:40:12)\n    at async execute (/srv/node_modules/@archlast/forge-runtime/dist/server/index.js:${engineLine}:9)`;

  test("one bug is one fingerprint: messages, paths and dependency frames don't split it", () => {
    expect(fingerprint("TypeError", "a", stack(10001, "app", 120))).toBe(fingerprint("TypeError", "b", stack(99872, "release-7", 131)));
    expect(fingerprint("TypeError", "a", stack(1, "app", 120))).not.toBe(fingerprint("TypeError", "a", stack(1, "app", 120).replace("billing.ts:193", "billing.ts:200")));
  });

  test("errors without a stack group by message, with ids taken out", () => {
    expect(fingerprint("ForgeError", "Order 123456 not found")).toBe(fingerprint("ForgeError", "Order 987654 not found"));
    expect(fingerprint("ForgeError", "Order 123456 not found")).not.toBe(fingerprint("ValidationError", "Order 123456 not found"));
  });

  test("impact: the worst factor wins, and the reason names it", () => {
    const base = { operation: "GET /x", total: 1000, satisfied: 900, tolerating: 50, bad: 50, clientErrors: 0, p99Ms: 400 };
    expect(impactScore(base)).toBeCloseTo(0.075, 3);
    expect(impactReason(base)).toBe("Healthy");
    expect(impactScore({ ...base, p99Ms: 9000 })).toBe(0.75);
    expect(impactReason({ ...base, p99Ms: 9000 })).toBe("P99 latency is 9.0s");
    // A 45% bad rate trips the error-rate floor (0.75), which outranks the volume floor's 0.5; at 500 bad requests volume reaches 0.75 and wins the tie.
    expect(impactReason({ ...base, satisfied: 500, bad: 450 })).toBe("45% of requests are slow or failing");
    expect(impactReason({ ...base, satisfied: 450, bad: 500 })).toBe("500 errors with 50.0% error rate");
    expect(impactReason({ ...base, clientErrors: 600 })).toBe("60% of requests returning 4xx errors");
  });
});

describe("OTLP", () => {
  const now = Date.now();

  test("protobuf and JSON exports decode to the same thing", () => {
    const fromProto = parse("traces", encode("ExportTraceServiceRequest", nestExport(now, { fail: true })), "application/x-protobuf");
    const json = JSON.stringify(nestExport(now, { fail: true }), (_k, v) => (v?.type === "Buffer" ? Buffer.from(v.data).toString("hex") : v));
    const fromJson = parse("traces", new TextEncoder().encode(json), "application/json");
    const a = new OtlpIngest().traces(fromProto);
    const b = new OtlpIngest().traces(fromJson);
    for (const batch of [a, b]) {
      expect(batch.traces).toHaveLength(1);
      const t = batch.traces![0]!;
      expect(t.request).toMatchObject({
        traceId: TRACE,
        spanId: "00f067aa0ba902b7",
        service: "billing-api",
        kind: "http",
        operation: "GET /invoices/:id",
        method: "GET",
        status: 500,
        userId: "carol@example.com",
        release: "3f9a2c1",
      });
      expect(t.request.duration).toBeCloseTo(120, 0);
      expect(t.request.error).toMatchObject({ type: "TypeError", handled: false });
      expect(t.request.error!.stack).toContain("invoice.service.ts:193");
      expect(t.spans.map((s) => [s.type, s.name])).toEqual([
        ["request", "GET /invoices/:id"],
        ["db", "SELECT invoices"],
        ["http", "POST api.stripe.com"],
      ]);
      expect(batch.rollups!.find((r) => r.kind === "http")).toMatchObject({ operation: "GET /invoices/:id", count: 1, errors: 1 });
      expect(batch.spanRollups!.map((r) => `${r.type}:${r.namespace}`).sort()).toEqual(["db:postgresql", "http:api.stripe.com"]);
    }
  });

  test("logs keep their level, body and trace", () => {
    const now = Date.now();
    const body = encode("ExportLogsServiceRequest", {
      resourceLogs: [
        {
          resource: { attributes: [kv("service.name", "billing-api")] },
          scopeLogs: [
            {
              scope: { name: "InvoiceService" },
              logRecords: [{ timeUnixNano: nanos(now), severityNumber: 13, body: { stringValue: "card declined" }, traceId: hex(TRACE), spanId: hex("00f067aa0ba902b7") }],
            },
          ],
        },
      ],
    });
    const batch = new OtlpIngest().logs(parse("logs", body, "application/x-protobuf"));
    expect(batch.logs![0]).toMatchObject({ service: "billing-api", level: "warn", name: "InvoiceService", message: "card declined", traceId: TRACE, spanId: "00f067aa0ba902b7" });
  });

  test("cumulative counters become per-minute increases, gauges keep their last reading", () => {
    const ingest = new OtlpIngest();
    const now = Date.now();
    const send = (total: number, gauge: number) =>
      ingest.metrics(
        parse(
          "metrics",
          encode("ExportMetricsServiceRequest", {
            resourceMetrics: [
              {
                resource: { attributes: [kv("service.name", "billing-api")] },
                scopeMetrics: [
                  {
                    metrics: [
                      {
                        name: "invoices.sent",
                        sum: { isMonotonic: true, aggregationTemporality: 2, dataPoints: [{ startTimeUnixNano: nanos(now - 600_000), timeUnixNano: nanos(now), asInt: total }] },
                      },
                      { name: "queue.depth", gauge: { dataPoints: [{ timeUnixNano: nanos(now), asDouble: gauge }] } },
                    ],
                  },
                ],
              },
            ],
          }),
          "application/x-protobuf",
        ),
      );
    send(100, 4);
    send(130, 7);
    const last = send(145, 2).metrics!;
    expect(last.find((m) => m.name === "invoices.sent")).toMatchObject({ type: "counter", value: 45, total: 145 });
    expect(last.find((m) => m.name === "queue.depth")).toMatchObject({ type: "gauge", value: 2 });
  });
});

describe("recorder", () => {
  test("every request is counted; past the budgets, detail and kept traces are sampled with weights that keep counts unbiased", () => {
    // A seeded random source, so the sample is the same every run; the estimate is what is checked, not luck.
    const random = Math.random;
    let seed = 42;
    Math.random = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
    try {
      const batches: TelemetryBatch[] = [];
      const t = new Telemetry({ service: "svc", instance: "i1", sink: (b) => batches.push(b), tracesPerSecond: 20, detailPerSecond: 200, release: () => "r1" });
      const spans = (root: ReturnType<typeof t.begin>) => [
        { traceId: root.traceId, spanId: `${root.spanId}-db`, parentId: root.spanId, name: "SELECT todos", type: "db" as const, start: root.time, duration: 2 },
      ];
      let detailed = 0;
      // A second at 4,000 requests sets the rates for the next, which records ~200 of its 4,000 in detail and keeps ~20 of those.
      const run = (n: number) => {
        for (let i = 0; i < n; i++) {
          const root = t.begin("query", "todos:list", "GET");
          if (root.detail) detailed++;
          t.end(root, { status: 200, ...(root.detail && { telemetry: { spans: spans(root) } }) });
        }
      };
      Bun.sleepSync(1000 - (Date.now() % 1000) + 5);
      run(4000);
      detailed = 0;
      Bun.sleepSync(1000 - (Date.now() % 1000) + 5);
      run(4000);
      // A caller that recorded its side of the trace gets this side too; one that didn't joins its trace, sampled like the rest.
      const callers = Array.from({ length: 200 }, (_, i) => t.begin("query", "todos:list", "GET", `00-${"a".repeat(32)}-${"b".repeat(16)}-0${i % 2}`));
      expect(callers.every((r) => r.traceId === "a".repeat(32))).toBe(true);
      expect(callers.filter((_, i) => i % 2 === 1).every((r) => r.detail)).toBe(true);
      expect(callers.filter((r, i) => i % 2 === 0 && r.detail).length).toBeLessThan(30);
      void t.close();
      expect(detailed).toBeGreaterThan(120);
      expect(detailed).toBeLessThan(300);
      // Requests: exact. Spans: weighted by 1 / the chance of detail, so close to one per request.
      const last = <T extends { minute: number }>(rows: T[], key: (r: T) => string) => [...new Map(rows.map((r) => [key(r), r])).values()];
      const rollups = last(
        batches.flatMap((b) => b.rollups ?? []).filter((r) => r.kind === "query"),
        (r) => `${r.minute}`,
      );
      expect(rollups.reduce((n, r) => n + r.count, 0)).toBe(8000);
      const spanCount = last(
        batches.flatMap((b) => b.spanRollups ?? []),
        (r) => `${r.minute}`,
      ).reduce((n, r) => n + r.count, 0);
      expect(spanCount).toBeGreaterThan(8000 * 0.75);
      expect(spanCount).toBeLessThan(8000 * 1.25);
      // Kept traces: few, each standing for the ones it was picked from.
      const kept = batches.flatMap((b) => b.traces ?? []);
      expect(kept.length).toBeLessThanOrEqual(20 * 2 * 2);
      const weighted = kept.reduce((n, k) => n + k.request.weight, 0);
      expect(weighted).toBeGreaterThan(8000 * 0.5);
      expect(weighted).toBeLessThan(8000 * 1.5);
    } finally {
      Math.random = random;
    }
  });

  test("self time subtracts children once, even when they overlap", () => {
    const s = (id: string, start: number, duration: number, parentId?: string): Span => ({ traceId: "t", spanId: id, parentId, name: id, type: "custom", start, duration });
    const self = selfTimes([s("root", 0, 100), s("a", 10, 30, "root"), s("b", 20, 30, "root"), s("c", 80, 40, "root")]);
    expect(self.get("root")).toBe(100 - 40 - 20);
  });

  test("paths group by route: ids and tokens become :id", () => {
    expect(normalizePath("/api/auth/reset-password/8f2c9a1b7d3e4f5a6b7c8d9e")).toBe("/api/auth/reset-password/:id");
    expect(normalizePath("/users/41/posts")).toBe("/users/:id/posts");
    expect(normalizePath("/api/auth/get-session")).toBe("/api/auth/get-session");
  });
});

// The telemetry store is SQL (MongoDB keeps documents only; telemetry stays in SQLite beside it).
describe.each(dbAdapters.filter(([name]) => name !== "sqlite (:memory:)" && name !== "mongodb"))("store on %s", (_name, make) => {
  let db: Db;
  let store: TelemetryStore;
  let q: ReturnType<typeof buildQueries>;
  const now = Date.now();
  const minute = Math.floor(now / 60_000);
  const trace = (i: number, extra: Partial<TraceRecord["request"]> = {}): TraceRecord => {
    const traceId = i.toString(16).padStart(32, "0");
    const spanId = (i + 1).toString(16).padStart(16, "0");
    return {
      request: {
        traceId,
        spanId,
        time: now - 1000 * i,
        duration: 10 + i,
        service: "svc",
        kind: "query",
        operation: "todos:list",
        method: "GET",
        status: 200,
        weight: 1,
        userId: `u${i % 3}`,
        userName: `user${i % 3}@example.com`,
        ...extra,
      },
      spans: [
        { traceId, spanId, name: "todos:list", type: "request", kind: 2, start: now - 1000 * i, duration: 10 + i },
        {
          traceId,
          spanId: `f${spanId.slice(1)}`,
          parentId: spanId,
          name: "SELECT todos",
          type: "db",
          kind: 3,
          start: now - 1000 * i + 1,
          duration: 5,
          attrs: { "db.system.name": "sqlite" },
        },
      ],
    };
  };

  beforeAll(async () => {
    db = await make();
    await migrateTelemetry(db);
    store = new TelemetryStore(db);
    q = buildQueries(db);
    const hist: Histogram = {};
    for (let i = 0; i < 20; i++) record(hist, 10 + i);
    await store.write({
      traces: [
        ...Array.from({ length: 20 }, (_, i) => trace(i)),
        trace(100, { status: 500, error: { type: "TypeError", message: "boom 1", stack: "TypeError: boom 1\n    at h (/srv/forge/todos.ts:3:9)", handled: false } }),
        trace(101, { status: 500, error: { type: "TypeError", message: "boom 2", stack: "TypeError: boom 2\n    at h (/srv/forge/todos.ts:3:9)", handled: false } }),
      ],
      rollups: [
        { minute, service: "svc", kind: "query", operation: "todos:list", instance: "i1", count: 22, errors: 2, clientErrors: 0, cached: 5, sum: 400, max: 101, hist },
        { minute, service: "svc", kind: "*", operation: "*", instance: "i1", count: 22, errors: 2, clientErrors: 0, cached: 5, sum: 400, max: 101, hist },
      ],
      spanRollups: [{ minute, service: "svc", type: "db", name: "SELECT todos", namespace: "sqlite", instance: "i1", count: 22, errors: 0, sum: 110, self: 110, max: 5, hist: { 100: 22 } }],
      logs: [{ time: now, service: "svc", level: "warn", name: "todos:list", message: "slow page", traceId: trace(1).request.traceId }],
      releases: [{ service: "svc", version: "abc1234", time: now - 120_000 }],
    });
  });
  afterAll(() => db.close());

  const range = { from: now - 3600_000, to: now + 60_000 };

  test("requests and operations come from rollups", async () => {
    const r = await q.requests(range);
    expect(r.count).toBe(22);
    expect(r.errors).toBe(2);
    const op = r.operations.find((o) => o.operation === "todos:list")!;
    expect(op.p95).toBeGreaterThan(25);
    expect(op.p95).toBeLessThan(32);
    expect(op.impact).toBeGreaterThanOrEqual(0);
  });

  test("one error group for the same bug, counted from kept traces; its state can change", async () => {
    const e = await q.errors(range);
    expect(e.list).toHaveLength(1);
    expect(e.list[0]).toMatchObject({ type: "TypeError", count: 2, users: 2, state: "open" });
    await q.setErrorState({ fingerprint: e.list[0]!.fingerprint, state: "ignored" });
    expect((await q.errors(range)).list).toHaveLength(0);
    expect((await q.errors({ ...range, state: "ignored" })).list).toHaveLength(1);
    const detail = await q.error({ ...range, fingerprint: e.list[0]!.fingerprint });
    expect(detail!.occurrences).toHaveLength(2);
  });

  test("a trace has its spans and logs; users and spans aggregate", async () => {
    const t = await q.trace({ traceId: trace(1).request.traceId });
    expect(t.spans.map((s) => s.name)).toEqual(["todos:list", "SELECT todos"]);
    expect(t.logs[0]).toMatchObject({ message: "slow page" });
    expect(t.typical!.count).toBe(22);
    const users = await q.users(range);
    expect(users.list.map((u) => u.id).sort()).toEqual(["u0", "u1", "u2"]);
    const spans = await q.spans(range);
    expect(spans.list[0]).toMatchObject({ type: "db", name: "SELECT todos", count: 22 });
    const hot = await q.hotspots(range);
    expect(hot.list[0]).toMatchObject({ type: "db", namespace: "sqlite", share: 1 });
  });

  test("compaction folds minutes older than two days into hours and expires what's past retention", async () => {
    const old = Math.floor((now - 3 * 86_400_000) / 3_600_000) * 60;
    await store.write({
      rollups: [0, 1, 59].map((m) => ({
        minute: old + m,
        service: "svc",
        kind: "query",
        operation: "old:fn",
        instance: "i1",
        count: 2,
        errors: 1,
        clientErrors: 0,
        cached: 0,
        sum: 20,
        max: 12,
        hist: { 50: 2 },
      })),
      traces: [trace(500, { time: now - 40 * 86_400_000 })],
    });
    await store.compact(7, now);
    const rows = await db.query<Record<string, any>>(`SELECT * FROM "_otel_rollups" WHERE "operation" = 'old:fn'`);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ minute: old, res: 60, instance: "*" });
    expect(Number(rows[0]!.count)).toBe(6);
    expect(JSON.parse(rows[0]!.hist)).toEqual({ 50: 6 });
    expect(await db.query(`SELECT * FROM "_otel_requests" WHERE "trace_id" = ?`, [trace(500).request.traceId])).toHaveLength(0);
  });

  test("SLOs measure their objective, budget and burn; alert rules fire and resolve through a webhook", async () => {
    const hooks: any[] = [];
    const settings = buildSettings(db, { deliver: async (_url, body) => (hooks.push(body), "delivered") });
    const id = await settings.saveSlo({ name: "List latency", objective: "latency", target: 0.9, thresholdMs: 25, windowDays: 7, operation: "todos:list" }, "admin@example.com");
    const [slo] = await settings.slos();
    expect(slo).toMatchObject({ id, objective: "latency", requests: 22 });
    expect(slo!.sli!).toBeGreaterThan(0.6);
    expect(slo!.sli!).toBeLessThan(0.85);
    expect(slo!.status).toBe("breached");
    const rule = await settings.saveAlertRule(
      { name: "List errors", metric: "error_rate", comparator: ">", threshold: 5, windowMin: 60, operation: "todos:list", webhook: "https://hooks.example.com/x" },
      "admin@example.com",
    );
    await settings.evaluate(now);
    expect((await settings.alertRules())[0]).toMatchObject({ id: rule, state: "firing" });
    expect(hooks[0].text).toContain("List errors");
    expect((await settings.notifications()).unseen).toBe(1);
    // An hour with no requests says nothing either way; one without errors resolves it.
    const later = now + 3 * 3600_000;
    await settings.evaluate(later);
    expect((await settings.alertRules())[0]).toMatchObject({ state: "firing" });
    expect(hooks).toHaveLength(1);
    await store.write({
      rollups: [
        {
          minute: Math.floor(later / 60_000) - 1,
          service: "svc",
          kind: "query",
          operation: "todos:list",
          instance: "i1",
          count: 10,
          errors: 0,
          clientErrors: 0,
          cached: 0,
          sum: 50,
          max: 9,
          hist: { 50: 10 },
        },
      ],
    });
    await settings.evaluate(later);
    expect((await settings.alertRules())[0]).toMatchObject({ state: "ok" });
    expect(hooks[1]).toMatchObject({ state: "resolved", value: 0 });
    await settings.saveAlertRule(
      { id: rule, name: "List errors", metric: "error_rate", comparator: ">", threshold: 50, windowMin: 60, operation: "todos:list", webhook: "https://hooks.example.com/x" },
      "admin@example.com",
    );
    expect((await settings.alertRules())[0]).toMatchObject({ state: "ok" });
    // A burn-rate rule goes with its SLO.
    await settings.saveAlertRule({ name: "List budget", metric: "slo_burn", comparator: ">", threshold: 2, windowMin: 60, operation: id }, "admin@example.com");
    await settings.deleteSlo({ id });
    expect((await settings.alertRules()).map((r: any) => r.name)).toEqual(["List errors"]);
  });

  test("runtime and nodes read thousands of samples at once: each process's latest, per service, without a lookup per row", async () => {
    // Two services with three nodes, the server and a worker on each, a sample every 10 s for half a day: 26k rows. The latest-sample query
    // used to look up each row's instance again (quadratic), which took 89 s on a dev machine's 19k rows and held up every dashboard call.
    const sample = (service: string, instance: string, role: "server" | "runtime", time: number) => ({ time, service, instance, role, cpu: 10, cpuUser: 8, cpuSystem: 2, rss: 100, heapUsed: 50, heapTotal: 80, loopMean: 1, loopP99: 2, loopMax: 3 });
    const samples = [];
    for (const service of ["api", "orders"])
      for (const node of service === "api" ? ["a:1", "b:2", "c:3"] : ["a:1", "b:2"]) // "a:1" in both: the same host:pid can be two services' (one process in tests)
        for (let t = now - 12 * 3600_000; t < now - (node === "b:2" ? 600_000 : 0); t += 10_000) samples.push(sample(service, node, "server", t), sample(service, `${node}/w0`, "runtime", t + 1));
    for (let i = 0; i < samples.length; i += 2000) await store.write({ samples: samples.slice(i, i + 2000) });
    const range = { from: now - 86_400_000, to: now + 60_000 };
    const started = performance.now();
    const [rt, nodes] = await Promise.all([q.runtime(range), q.nodes(range)]);
    expect(performance.now() - started).toBeLessThan(3000);
    expect(rt.instances).toHaveLength(10);
    const api = nodes.filter((n) => n.service === "api");
    expect(api.map((n) => [n.node, n.live, n.processes.map((p) => p.role)])).toEqual([
      ["a:1", true, ["server", "runtime"]],
      ["c:3", true, ["server", "runtime"]],
      ["b:2", false, ["server", "runtime"]], // stopped ten minutes ago: scaled down
    ]);
    expect(nodes.filter((n) => n.service === "orders").map((n) => n.node)).toEqual(["a:1", "b:2"]);
    expect(api[0]!.first).toBeLessThan(now - 11 * 3600_000);
    // An alert on live nodes: a service's servers that reported in the window, every service's when none is named.
    const settings = buildSettings(db);
    const nodesRule = (service: string | null) => ({ metric: "nodes", window_min: 1, service });
    expect(await settings.measure(nodesRule("api"), now)).toBe(2);
    expect(await settings.measure(nodesRule("orders"), now)).toBe(1);
    expect(await settings.measure(nodesRule(null), now)).toBe(3); // "a:1" is a node of each service
    expect(await settings.measure(nodesRule("api"), now + 3600_000)).toBe(0); // gone silent
  }, 60_000);

  test("ingest keys are shown once, stored hashed, and stop working when revoked", async () => {
    const settings = buildSettings(db);
    const { key } = await settings.createKey({ name: "billing", service: "billing-api" }, "admin@example.com");
    expect(key).toStartWith("afk_");
    expect(JSON.stringify(await settings.keys())).not.toContain(key);
    expect(await settings.verifyKey({ key })).toMatchObject({ service: "billing-api" });
    const [row] = (await settings.keys()) as { id: string }[];
    await settings.revokeKey({ id: row!.id });
    expect(await settings.verifyKey({ key })).toBeNull();
  });
});

describe("the engine", () => {
  let srv: RunningServer;
  const ADMIN = "k".repeat(32);
  const get = async (op: string, input: object = {}) => {
    const r = await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": ADMIN } });
    const body = (await r.json()) as any;
    if (!r.ok) throw new Error(`${op}: ${JSON.stringify(body)}`);
    return body;
  };
  const rpc = (name: string, args: object = {}) => fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  /** Telemetry is written a second after it happens; wait for it to show. */
  const eventually = async <T>(read: () => Promise<T>, ok: (v: T) => boolean, tries = 40) => {
    let v = await read();
    for (let i = 0; i < tries && !ok(v); i++) v = (await Bun.sleep(150), await read());
    return v;
  };
  const range = () => ({ from: Date.now() - 3600_000, to: Date.now() + 60_000 });

  beforeAll(async () => {
    srv = await startServer({ forgeDir: join(import.meta.dir, "fixture"), dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: ADMIN, LOG_FORMAT: "json" } });
  });
  afterAll(() => srv.stop({ graceful: false }));

  test("calls become requests with traces: function, database and nested-call spans, the caller's trace continued", async () => {
    const list = (await (await rpc("todos:createList", { name: "work" })).json()) as { result: string };
    await rpc("todos:add", { listId: list.result, title: "ship it" });
    await rpc("todos:callsInternal");
    await rpc("todos:crash");
    await fetch(`${srv.url}/rpc/todos:listCounts`, { method: "POST", headers: { "content-type": "application/json", traceparent: `00-${TRACE}-00f067aa0ba902b7-01` }, body: "{}" });
    const ops = await eventually(
      () => get("obs.requests", range()),
      (r) => r.operations.length >= 5,
    );
    expect(ops.operations.map((o: any) => `${o.kind} ${o.operation}`)).toEqual(
      expect.arrayContaining(["mutation todos:createList", "mutation todos:add", "action todos:callsInternal", "query todos:crash", "query todos:listCounts"]),
    );
    const continued = await get("obs.trace", { traceId: TRACE });
    expect(continued.requests[0]).toMatchObject({ operation: "todos:listCounts", kind: "query" });
    expect(continued.spans.find((s: any) => s.type === "request").parent_id).toBe("00f067aa0ba902b7");
    const action = await get("obs.operation", { ...range(), kind: "action", operation: "todos:callsInternal" });
    const t = await get("obs.trace", { traceId: action.calls[0].trace_id });
    const names = t.spans.map((s: any) => `${s.type}:${s.name}`);
    expect(names).toEqual(expect.arrayContaining(["request:todos:callsInternal", "function:todos:callsInternal", "function:todos:secretCount", "db:SELECT lists"]));
    const inner = t.spans.find((s: any) => s.name === "todos:secretCount");
    expect(t.spans.find((s: any) => s.span_id === inner.parent_id).name).toBe("todos:callsInternal");
  });

  test("errors group by fingerprint, with their stack and the source around it", async () => {
    const errors = await eventually(
      () => get("obs.errors", range()),
      (e) => e.list.some((x: any) => x.message === "secret internal detail"),
    );
    const crash = errors.list.find((x: any) => x.message === "secret internal detail");
    expect(crash).toMatchObject({ type: "Error", status: 500, handled: false });
    const detail = await get("obs.error", { ...range(), fingerprint: crash.fingerprint });
    expect(detail.group.stack).toContain("fixture/todos.ts");
    const frame = /\((\/[^)]+fixture\/todos\.ts):(\d+):\d+\)/.exec(detail.group.stack)!;
    const source = await get("obs.source", { file: frame[1], line: Number(frame[2]) });
    expect(source.lines.join("\n")).toContain("secret internal detail");
    expect(await get("obs.source", { file: "/etc/passwd", line: 1 })).toBeNull();
    // Only forge/ (here the fixture) and app/: another file of the project, such as a script, isn't shown.
    expect(await get("obs.source", { file: frame[1].replace(/fixture\/todos\.ts$/, "helpers.ts"), line: 1 })).toBeNull();
    // The request id a caller sees in "Server error (request …)" finds its trace.
    await fetch(`${srv.url}/rpc/todos:crash`, { method: "POST", headers: { "content-type": "application/json", "x-request-id": "find-me-123" }, body: "{}" });
    const found = await eventually(
      () => get("obs.search", { q: "find-me-123" }),
      (s) => s.traces.length > 0,
    );
    expect(found.traces[0]).toMatchObject({ operation: "todos:crash" });
  });

  test("subscriptions are requests, and the re-runs writes cause are live requests", async () => {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
    await new Promise((r) => (ws.onopen = r));
    const updates: unknown[] = [];
    ws.onmessage = (m) => updates.push(JSON.parse(String(m.data)));
    ws.send(JSON.stringify({ type: "subscribe", id: "1", name: "todos:listCounts", args: {} }));
    while (!updates.length) await Bun.sleep(20);
    await rpc("todos:createList", { name: "another" });
    while (updates.length < 2) await Bun.sleep(20);
    ws.close();
    const r = await eventually(
      () => get("obs.requests", range()),
      (x) => x.operations.some((o: any) => o.kind === "live"),
    );
    expect(r.operations.find((o: any) => o.kind === "live" && o.operation === "todos:listCounts").count).toBeGreaterThanOrEqual(1);
  });

  test("crons are jobs with their queue wait; HTTP routes are named by pattern", async () => {
    await fetch(`${srv.url}/http/files/a/b`);
    await fetch(`${srv.url}/http/hello`);
    const ov = await eventually(
      () => get("obs.overview", range()),
      (o) => o.jobs.count > 0,
    );
    expect(ov.jobs.count).toBeGreaterThan(0);
    const jobs = await get("obs.operation", { ...range(), kind: "cron", operation: "todos:logEvent" });
    expect(jobs.calls[0].queue_wait).toBeGreaterThanOrEqual(0);
    const r = await eventually(
      () => get("obs.requests", range()),
      (x) => x.operations.some((o: any) => o.operation === "GET /files/*"),
    );
    expect(r.operations.map((o: any) => o.operation)).toEqual(expect.arrayContaining(["GET /files/*", "GET /hello"]));
  });

  test("custom spans and metrics from forge/ code", async () => {
    await rpc("todos:exportRows");
    const op = await eventually(
      () => get("obs.operation", { ...range(), kind: "action", operation: "todos:exportRows" }),
      (o) => o.calls.length > 0,
    );
    const t = await get("obs.trace", { traceId: op.calls[0].trace_id });
    const span = t.spans.find((s: any) => s.name === "export.render");
    expect(span).toMatchObject({ type: "custom" });
    expect(JSON.parse(span.attrs)).toEqual({ rows: 3 });
    // Metrics leave the function runtime every few seconds.
    const m = await eventually(
      () => get("obs.metrics", range()),
      (x) => x.list.length >= 2,
      80,
    );
    expect(m.list.find((x: any) => x.name === "todos.exported")).toMatchObject({ type: "counter", value: 3 });
    expect(m.list.find((x: any) => x.name === "queue.depth")).toMatchObject({ type: "gauge", value: 7 });
  });

  test("runtime health is sampled per process; OTLP from other services lands next to the engine's own", async () => {
    // The engine's own export pointed back at it isn't ingested: it has these requests already.
    const span = {
      traceId: "e".repeat(32),
      spanId: "e".repeat(16),
      name: "GET /echo",
      kind: 2,
      startTimeUnixNano: nanos(Date.now()),
      endTimeUnixNano: nanos(Date.now() + 5),
      attributes: [kv("http.request.method", "GET"), kv("http.route", "/echo")],
    };
    const echo = await fetch(`${srv.url}/otlp/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-forge-service": "archlast-forge" },
      body: JSON.stringify({ resourceSpans: [{ resource: { attributes: [kv("service.name", "echo-api")] }, scopeSpans: [{ spans: [span] }] }] }),
    });
    expect(echo.status).toBe(200);
    const res = await fetch(`${srv.url}/otlp/v1/traces`, {
      method: "POST",
      headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" },
      body: Bun.gzipSync(encode("ExportTraceServiceRequest", nestExport(Date.now(), { fail: true }))),
    });
    expect(res.status).toBe(200);
    // 50 KB of gzip that would inflate to 64 MB is refused, past the cap, instead of being expanded.
    const bomb = await fetch(`${srv.url}/otlp/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip" }, body: Bun.gzipSync(new Uint8Array(64 * 1024 * 1024)) });
    expect(bomb.status).toBe(400);
    const map = await eventually(
      () => get("obs.map", range()),
      (m) => m.services.some((s: any) => s.service === "billing-api"),
    );
    expect(map.services.map((s: any) => s.service)).toEqual(expect.arrayContaining(["archlast-forge", "billing-api"]));
    expect(map.services.map((s: any) => s.service)).not.toContain("echo-api");
    expect(map.dependencies.map((d: any) => d.to)).toEqual(expect.arrayContaining(["db:SQLite", "db:PostgreSQL", "http:api.stripe.com"]));
    const services = await get("obs.services", range());
    expect(services.find((s: any) => s.service === "billing-api")).toMatchObject({ release: "3f9a2c1" });
    const json = await fetch(`${srv.url}/otlp/v1/logs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        resourceLogs: [
          {
            resource: { attributes: [kv("service.name", "billing-api")] },
            scopeLogs: [{ logRecords: [{ timeUnixNano: nanos(Date.now()), severityText: "ERROR", body: { stringValue: "payment provider timed out" } }] }],
          },
        ],
      }),
    });
    expect(json.status).toBe(200);
    const logs = await eventually(
      () => get("obs.logs", { ...range(), service: "billing-api" }),
      (l) => l.length > 0,
    );
    expect(logs[0]).toMatchObject({ level: "error", message: "payment provider timed out" });
  });
});

describe("the engine in production", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({
      forgeDir: join(import.meta.dir, "fixture"),
      env: {
        ...process.env,
        PORT: "0",
        DATA_DIR: tempDir(),
        ADMIN_KEY: "p".repeat(32),
        BETTER_AUTH_SECRET: "s".repeat(32),
        ALLOW_INSECURE_HTTP: "1",
        DASHBOARD: "on",
        LOG_FORMAT: "json",
        TELEMETRY_TRACES_PER_SECOND: "5",
      },
    });
  });
  afterAll(() => srv.stop({ graceful: false }));

  test("OTLP needs an ingest key, and the dashboard's telemetry needs a signed-in admin", async () => {
    const payload = encode("ExportTraceServiceRequest", nestExport(Date.now()));
    expect((await fetch(`${srv.url}/otlp/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf" }, body: payload })).status).toBe(401);
    expect((await fetch(`${srv.url}/_admin/obs.overview?input={}`)).status).toBe(401);
    const created = await fetch(`${srv.url}/_admin/obs.createKey`, {
      method: "POST",
      headers: { "x-admin-key": "p".repeat(32), "x-forge-admin": "1", "content-type": "application/json" },
      body: JSON.stringify({ name: "billing" }),
    });
    const { key } = (await created.json()) as { key: string };
    expect((await fetch(`${srv.url}/otlp/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf", authorization: `Bearer ${key}` }, body: payload })).status).toBe(
      200,
    );
    expect(
      (await fetch(`${srv.url}/otlp/v1/traces`, { method: "POST", headers: { "content-type": "application/x-protobuf", authorization: `Bearer afk_wrong` }, body: payload })).status,
    ).toBe(401);
  });

  test("inline, the runtime's spans are recorded the same way", async () => {
    await fetch(`${srv.url}/rpc/todos:callsInternal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const get = async (op: string, input: object) =>
      (await (await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": "p".repeat(32) } })).json()) as any;
    let op: any;
    for (let i = 0; i < 40; i++) {
      op = await get("obs.operation", { from: Date.now() - 600_000, to: Date.now() + 60_000, kind: "action", operation: "todos:callsInternal" });
      if (op.calls?.length) break;
      await Bun.sleep(150);
    }
    const t = await get("obs.trace", { traceId: op.calls[0].trace_id });
    expect(t.spans.map((s: any) => s.name)).toEqual(expect.arrayContaining(["todos:callsInternal", "todos:secretCount", "SELECT lists"]));
  });
});

// The dashboard reads what the store kept, so stopping the engine and starting it again on the same data directory must not empty it.
describe.each([
  ["in production", false, { BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", DASHBOARD: "on" }],
  ["in dev, with the runtime in a child process", true, {}],
] as const)("a restart %s", (_name, dev, extra) => {
  test("keeps the requests, and a version's first appearance", async () => {
    const dir = tempDir();
    const ADMIN = "r".repeat(32);
    const boot = () => startServer({ forgeDir: join(import.meta.dir, "fixture"), dev, env: { ...process.env, ...extra, PORT: "0", DATA_DIR: dir, ADMIN_KEY: ADMIN, LOG_FORMAT: "json" } });
    const get = async (srv: RunningServer, op: string) => {
      const input = { from: Date.now() - 3600_000, to: Date.now() + 60_000 };
      return (await (await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": ADMIN } })).json()) as any;
    };
    const call = (srv: RunningServer, name: string, args: object = {}) => fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });

    const first = await boot();
    for (let i = 0; i < 5; i++) await call(first, "todos:createList", { name: `l${i}` });
    let before = await get(first, "obs.requests");
    for (let i = 0; i < 40 && before.count < 5; i++) before = (await Bun.sleep(150), await get(first, "obs.requests"));
    expect(before.count).toBe(5);
    const [release] = (await get(first, "obs.releases")) as { version: string; at: number }[];
    await first.stop();

    await Bun.sleep(1100); // so a release stamped again at the restart would differ
    const second = await boot();
    try {
      expect((await get(second, "obs.requests")).count).toBe(5);
      const [again] = (await get(second, "obs.releases")) as { version: string; at: number }[];
      expect(again).toMatchObject({ version: release!.version, at: release!.at });
    } finally {
      await second.stop({ graceful: false });
    }
  });
});

describe("a main app and its microservice: one dashboard", () => {
  let main: RunningServer;
  let orders: RunningServer;
  const ADMIN = "m".repeat(32);
  const TOKEN = "d".repeat(32);
  const range = () => ({ from: Date.now() - 3600_000, to: Date.now() + 60_000 });
  const admin = (base: string, op: string, input: object = {}, target?: string) =>
    fetch(`${base}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}${target ? `&target=${target}` : ""}`, { headers: { "x-admin-key": ADMIN } });

  beforeAll(async () => {
    const probe = Bun.serve({ port: 0, fetch: () => new Response() });
    const port = probe.port!;
    await probe.stop(true);
    const env = { ...process.env, LOG_FORMAT: "json", DASHBOARD_TOKEN: TOKEN };
    main = await startServer({ forgeDir: join(import.meta.dir, "fixture"), dev: true, env: { ...env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: ADMIN, OTEL_SERVICE_NAME: "shop", MICROSERVICES: `orders=http://127.0.0.1:${port}` } });
    orders = await startServer({ forgeDir: join(import.meta.dir, "fixture"), dev: true, env: { ...env, PORT: String(port), DATA_DIR: tempDir(), OTEL_SERVICE_NAME: "orders", DASHBOARD_URL: main.url } });
  });
  afterAll(async () => {
    await orders?.stop({ graceful: false }).catch(() => {}); // a test below stops it already
    await main?.stop({ graceful: false });
  });

  test("the microservice's requests and nodes are on the main app's dashboard, under its own name", async () => {
    await fetch(`${orders.url}/rpc/todos:createList`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "from orders" }) });
    let services: { service: string; count: number }[] = [];
    let nodes: { service: string; live: boolean; processes: { role: string }[] }[] = [];
    for (let i = 0; i < 40; i++) {
      services = (await (await admin(main.url, "obs.services", range())).json()) as typeof services;
      nodes = (await (await admin(main.url, "obs.nodes", range())).json()) as typeof nodes;
      if (services.find((x) => x.service === "orders")?.count && nodes.some((n) => n.service === "orders") && nodes.some((n) => n.service === "shop")) break;
      await Bun.sleep(150);
    }
    expect(services.find((x) => x.service === "orders")!.count).toBeGreaterThan(0);
    const node = nodes.find((n) => n.service === "orders")!;
    expect(node.live).toBe(true);
    expect(node.processes[0]!.role).toBe("server");
    // Both servers run in this one process, so they share host:pid: a node is a service's, not just a process id.
    expect(nodes.find((n) => n.service === "shop")!.live).toBe(true);
    // The microservice keeps no store of its own.
    expect((await admin(orders.url, "obs.services", range())).status).toBe(401); // and no one but the main app may ask it anything
  }, 20_000);

  test("the main app's dashboard shows the microservice's data and schema, through the main app, with the user's role", async () => {
    const list = (await (await admin(main.url, "microservices")).json()) as { self: string; services: { name: string; url: string }[] };
    expect(list).toEqual({ self: "shop", services: [{ name: "orders", url: expect.stringContaining("http://127.0.0.1:") }] });
    const manifest = (await (await admin(main.url, "manifest", {}, "orders")).json()) as { functions: { name: string }[] };
    expect(manifest.functions.map((f) => f.name)).toContain("todos:createList");
    const page = (await (await admin(main.url, "docs", { table: "lists" }, "orders")).json()) as { page: { name: string }[] };
    expect(page.page.map((d) => d.name)).toEqual(["from orders"]); // the microservice's table, not this app's
    expect(((await (await admin(main.url, "docs", { table: "lists" })).json()) as { page: unknown[] }).page).toEqual([]);
    // Telemetry stays the main app's, target or not.
    expect((await admin(main.url, "obs.services", range(), "orders")).status).toBe(200);
    expect((await admin(main.url, "manifest", {}, "nope")).status).toBe(404);
    // Without a dashboard user nothing is forwarded; the microservice takes the token alone, and serves no dashboard of its own.
    expect((await fetch(`${main.url}/_admin/manifest?target=orders`)).status).toBe(401);
    const direct = await fetch(`${orders.url}/_admin/manifest`, { headers: { authorization: `Bearer ${TOKEN}`, "x-forge-role": "viewer" } });
    expect(direct.status).toBe(200);
    const write = await fetch(`${orders.url}/_admin/insertDoc`, { method: "POST", headers: { authorization: `Bearer ${TOKEN}`, "x-forge-role": "viewer", "x-forge-admin": "1", "content-type": "application/json" }, body: JSON.stringify({ table: "lists", value: { name: "x" } }) });
    expect(write.status).toBe(403);
    const page2 = await fetch(`${orders.url}/_dashboard`, { redirect: "manual" });
    expect(page2.status).toBe(302);
    expect(page2.headers.get("location")).toBe(`${main.url}/_dashboard#/microservices`);
  });

  test("the microservice's live log stream comes through the main app, and ends quietly when the service goes away", async () => {
    const res = await fetch(`${main.url}/_admin/logs/stream?target=orders`, { headers: { "x-admin-key": ADMIN } });
    expect(res.headers.get("content-type")).toBe("text/event-stream");
    const reader = res.body!.getReader();
    // The stream also carries the log lines of earlier calls that arrive late, so read until the one looked for (or the stream ends).
    let seen = "";
    const until = async (part: string) => {
      const deadline = Date.now() + 5_000;
      while (!seen.includes(part) && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        seen += new TextDecoder().decode(value);
      }
      return seen;
    };
    expect(await until(": connected")).toStartWith(": connected\n\n");
    await fetch(`${orders.url}/rpc/todos:createList`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "streamed" }) });
    expect(await until('"name":"todos:createList"')).toContain('"name":"todos:createList"');
    await reader.cancel();
  });

  test("the main app takes telemetry only with its token, and never under its own name", async () => {
    const send = (token: string, batch: object) => fetch(`${main.url}/_telemetry`, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(batch) });
    expect((await send("w".repeat(32), {})).status).toBe(401);
    expect((await send(TOKEN, { services: [{ service: "shop", attrs: {}, time: Date.now() }] })).status).toBe(409);
    expect((await send(TOKEN, { services: [{ service: "billing", attrs: {}, time: Date.now() }] })).status).toBe(200);
  });

  test("a microservice that is down: its pages answer 502 with why, and the main app carries on", async () => {
    await orders.stop({ graceful: false });
    const res = await admin(main.url, "manifest", {}, "orders");
    expect(res.status).toBe(502);
    expect(((await res.json()) as { message: string }).message).toContain("orders (http://127.0.0.1:");
    expect((await fetch(`${main.url}/health`)).status).toBe(200);
  });

  test("the settings that join them are checked when the server starts", () => {
    expect(() => loadConfig({ DASHBOARD_URL: "http://main:3000", OTEL_SERVICE_NAME: "orders" }, true)).toThrow("DASHBOARD_TOKEN");
    expect(() => loadConfig({ DASHBOARD_URL: "http://main:3000", DASHBOARD_TOKEN: TOKEN }, true)).toThrow("OTEL_SERVICE_NAME");
    expect(() => loadConfig({ MICROSERVICES: "orders", DASHBOARD_TOKEN: TOKEN }, true)).toThrow("name=url");
    expect(loadConfig({ MICROSERVICES: "orders=http://orders:3000/, billing=https://billing.internal", DASHBOARD_TOKEN: TOKEN }, true).microservices).toEqual({ orders: "http://orders:3000", billing: "https://billing.internal" });
  });
});

describe.if(Boolean(process.env.TEST_POSTGRES_URL))("the engine on Postgres", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    const db = (await dbAdapters.find(([name]) => name === "postgres")![1]()) as Db; // drops what earlier suites left
    await db.close();
    srv = await startServer({
      forgeDir: join(import.meta.dir, "fixture"),
      dev: true,
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), DATABASE_URL: process.env.TEST_POSTGRES_URL, ADMIN_KEY: "q".repeat(32), LOG_FORMAT: "json" },
    });
  });
  afterAll(() => srv?.stop({ graceful: false }));

  test("the telemetry store is _otel_ tables in the app's database, and reads back like on SQLite", async () => {
    await fetch(`${srv.url}/rpc/todos:callsInternal`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await fetch(`${srv.url}/rpc/todos:crash`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    const get = async (op: string, input: object) =>
      (await (await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": "q".repeat(32) } })).json()) as any;
    const range = { from: Date.now() - 600_000, to: Date.now() + 60_000 };
    let op: any;
    for (let i = 0; i < 60 && !op?.calls?.length; i++) {
      await Bun.sleep(150);
      op = await get("obs.operation", { ...range, kind: "action", operation: "todos:callsInternal" });
    }
    const t = await get("obs.trace", { traceId: op.calls[0].trace_id });
    expect(t.spans.map((s: any) => s.name)).toEqual(expect.arrayContaining(["todos:callsInternal", "todos:secretCount", "SELECT lists"]));
    expect(t.spans.find((s: any) => s.name === "SELECT lists").attrs).toContain("postgresql");
    const errors = await get("obs.errors", range);
    expect(errors.list.some((e: any) => e.message === "secret internal detail")).toBe(true);
    const ov = await get("obs.overview", range);
    expect(ov.requests.count).toBeGreaterThanOrEqual(2);
  });
});
