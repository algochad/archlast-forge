// The telemetry store: requests, spans, logs, rollups, runtime samples, custom metrics and releases, plus the observability settings
// (SLOs, alert rules, ingest keys). On SQLite it is its own file next to the app's database, so telemetry never waits for, or holds up,
// the app's single writer; on Postgres it is `_otel_*` tables in the app's database, shared by every server. It runs on a worker thread
// (worker.ts): writes and the dashboard's analytical reads stay off the thread that serves requests.
import type { Db } from "../db/types";
import { merge } from "./histogram";
import { fingerprint } from "./traceway";
import type { LogRecord, MetricPoint, Rollup, RuntimeSample, Span, SpanRollup, TelemetryBatch, TraceRecord } from "./types";

export const TABLES = {
  requests: `"_otel_requests"`,
  spans: `"_otel_spans"`,
  logs: `"_otel_logs"`,
  rollups: `"_otel_rollups"`,
  spanRollups: `"_otel_span_rollups"`,
  errors: `"_otel_errors"`,
  samples: `"_otel_runtime"`,
  metrics: `"_otel_metrics"`,
  releases: `"_otel_releases"`,
  slos: `"_otel_slos"`,
  rules: `"_otel_alert_rules"`,
  events: `"_otel_alert_events"`,
  keys: `"_otel_keys"`,
  services: `"_otel_services"`,
};

export async function migrateTelemetry(db: Db) {
  const R = db.dialect.realType;
  const pg = db.dialect.name === "postgres";
  const serial = pg ? `BIGSERIAL PRIMARY KEY` : `INTEGER PRIMARY KEY`;
  const T = TABLES;
  const statements = [
    `CREATE TABLE IF NOT EXISTS ${T.requests} ("trace_id" TEXT NOT NULL, "span_id" TEXT NOT NULL, "time" ${R} NOT NULL, "duration" ${R} NOT NULL, "service" TEXT NOT NULL, "instance" TEXT, "kind" TEXT NOT NULL, "operation" TEXT NOT NULL, "method" TEXT, "status" INTEGER NOT NULL, "user_id" TEXT, "user_name" TEXT, "error_group" TEXT, "error_message" TEXT, "handled" INTEGER, "cache" TEXT, "release" TEXT, "weight" ${R} NOT NULL, "queue_wait" ${R}, "span_count" INTEGER NOT NULL, "attrs" TEXT, "request_id" TEXT, PRIMARY KEY ("trace_id", "span_id"))`,
    `CREATE INDEX IF NOT EXISTS "_otel_requests_time" ON ${T.requests} ("time")`,
    `CREATE INDEX IF NOT EXISTS "_otel_requests_rid" ON ${T.requests} ("request_id")`,
    `CREATE INDEX IF NOT EXISTS "_otel_requests_op" ON ${T.requests} ("operation", "time")`,
    `CREATE INDEX IF NOT EXISTS "_otel_requests_user" ON ${T.requests} ("user_id", "time")`,
    `CREATE INDEX IF NOT EXISTS "_otel_requests_error" ON ${T.requests} ("error_group", "time")`,
    `CREATE TABLE IF NOT EXISTS ${T.spans} ("trace_id" TEXT NOT NULL, "span_id" TEXT NOT NULL, "parent_id" TEXT, "time" ${R} NOT NULL, "duration" ${R} NOT NULL, "self" ${R}, "service" TEXT NOT NULL, "name" TEXT NOT NULL, "type" TEXT NOT NULL, "kind" INTEGER, "status" INTEGER, "error" TEXT, "attrs" TEXT, PRIMARY KEY ("trace_id", "span_id"))`,
    `CREATE INDEX IF NOT EXISTS "_otel_spans_time" ON ${T.spans} ("time")`,
    `CREATE INDEX IF NOT EXISTS "_otel_spans_name" ON ${T.spans} ("name", "time")`,
    `CREATE TABLE IF NOT EXISTS ${T.logs} ("id" ${serial}, "time" ${R} NOT NULL, "service" TEXT NOT NULL, "instance" TEXT, "level" TEXT NOT NULL, "name" TEXT NOT NULL, "message" TEXT NOT NULL, "trace_id" TEXT, "span_id" TEXT, "attrs" TEXT)`,
    `CREATE INDEX IF NOT EXISTS "_otel_logs_time" ON ${T.logs} ("time")`,
    `CREATE INDEX IF NOT EXISTS "_otel_logs_trace" ON ${T.logs} ("trace_id")`,
    `CREATE TABLE IF NOT EXISTS ${T.rollups} ("minute" INTEGER NOT NULL, "res" INTEGER NOT NULL, "service" TEXT NOT NULL, "kind" TEXT NOT NULL, "operation" TEXT NOT NULL, "instance" TEXT NOT NULL, "count" ${R} NOT NULL, "errors" ${R} NOT NULL, "client_errors" ${R} NOT NULL, "cached" ${R} NOT NULL, "sum" ${R} NOT NULL, "max" ${R} NOT NULL, "hist" TEXT NOT NULL, PRIMARY KEY ("minute", "service", "kind", "operation", "instance"))`,
    `CREATE INDEX IF NOT EXISTS "_otel_rollups_op" ON ${T.rollups} ("operation", "minute")`,
    `CREATE TABLE IF NOT EXISTS ${T.spanRollups} ("minute" INTEGER NOT NULL, "res" INTEGER NOT NULL, "service" TEXT NOT NULL, "type" TEXT NOT NULL, "name" TEXT NOT NULL, "namespace" TEXT NOT NULL, "instance" TEXT NOT NULL, "count" ${R} NOT NULL, "errors" ${R} NOT NULL, "sum" ${R} NOT NULL, "self" ${R} NOT NULL, "max" ${R} NOT NULL, "hist" TEXT NOT NULL, PRIMARY KEY ("minute", "service", "type", "name", "namespace", "instance"))`,
    `CREATE INDEX IF NOT EXISTS "_otel_span_rollups_name" ON ${T.spanRollups} ("name", "minute")`,
    `CREATE TABLE IF NOT EXISTS ${T.errors} ("fingerprint" TEXT PRIMARY KEY, "service" TEXT NOT NULL, "type" TEXT NOT NULL, "message" TEXT NOT NULL, "handled" INTEGER NOT NULL, "status" INTEGER NOT NULL, "operation" TEXT NOT NULL, "first_seen" ${R} NOT NULL, "last_seen" ${R} NOT NULL, "count" ${R} NOT NULL, "state" TEXT NOT NULL, "stack" TEXT, "sample_trace" TEXT)`,
    `CREATE TABLE IF NOT EXISTS ${T.samples} ("time" ${R} NOT NULL, "res" INTEGER NOT NULL, "service" TEXT NOT NULL, "instance" TEXT NOT NULL, "role" TEXT NOT NULL, "cpu" ${R}, "cpu_user" ${R}, "cpu_system" ${R}, "rss" ${R}, "heap_used" ${R}, "heap_total" ${R}, "loop_mean" ${R}, "loop_p99" ${R}, "loop_max" ${R}, "connections" ${R}, "subscriptions" ${R}, "cache_hits" ${R}, "cache_misses" ${R}, "cache_shared" ${R}, "cache_entries" ${R}, "inflight" ${R})`,
    `CREATE INDEX IF NOT EXISTS "_otel_runtime_time" ON ${T.samples} ("time")`,
    `CREATE TABLE IF NOT EXISTS ${T.metrics} ("minute" INTEGER NOT NULL, "service" TEXT NOT NULL, "name" TEXT NOT NULL, "type" TEXT NOT NULL, "unit" TEXT, "attrs" TEXT NOT NULL, "instance" TEXT NOT NULL, "value" ${R} NOT NULL, "count" ${R} NOT NULL, "min" ${R} NOT NULL, "max" ${R} NOT NULL, "total" ${R}, PRIMARY KEY ("minute", "service", "name", "attrs", "instance"))`,
    `CREATE INDEX IF NOT EXISTS "_otel_metrics_name" ON ${T.metrics} ("name", "minute")`,
    `CREATE TABLE IF NOT EXISTS ${T.releases} ("service" TEXT NOT NULL, "version" TEXT NOT NULL, "first_seen" ${R} NOT NULL, "last_seen" ${R} NOT NULL, PRIMARY KEY ("service", "version"))`,
    `CREATE TABLE IF NOT EXISTS ${T.slos} ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "service" TEXT, "operation" TEXT, "objective" TEXT NOT NULL, "target" ${R} NOT NULL, "threshold_ms" ${R}, "window_days" INTEGER NOT NULL, "created_at" ${R} NOT NULL, "created_by" TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${T.rules} ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "metric" TEXT NOT NULL, "service" TEXT, "operation" TEXT, "comparator" TEXT NOT NULL, "threshold" ${R} NOT NULL, "window_min" INTEGER NOT NULL, "webhook" TEXT, "enabled" INTEGER NOT NULL, "state" TEXT NOT NULL, "since" ${R}, "value" ${R}, "evaluated_at" ${R}, "created_at" ${R} NOT NULL, "created_by" TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${T.events} ("id" TEXT PRIMARY KEY, "rule_id" TEXT NOT NULL, "rule_name" TEXT NOT NULL, "time" ${R} NOT NULL, "state" TEXT NOT NULL, "value" ${R}, "message" TEXT NOT NULL, "delivery" TEXT, "seen" INTEGER NOT NULL)`,
    `CREATE INDEX IF NOT EXISTS "_otel_alert_events_time" ON ${T.events} ("time")`,
    `CREATE TABLE IF NOT EXISTS ${T.services} ("service" TEXT PRIMARY KEY, "attrs" TEXT, "first_seen" ${R} NOT NULL, "last_seen" ${R} NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS ${T.keys} ("id" TEXT PRIMARY KEY, "name" TEXT NOT NULL, "hash" TEXT NOT NULL UNIQUE, "prefix" TEXT NOT NULL, "service" TEXT, "created_at" ${R} NOT NULL, "created_by" TEXT NOT NULL, "last_used" ${R})`,
  ];
  await db.transaction("write", async (tx) => {
    if (pg) await tx.execute("SELECT pg_advisory_xact_lock(727277)");
    for (const sql of statements) await tx.execute(sql);
  });
}

const json = (v: unknown) => (v === undefined || v === null || (typeof v === "object" && !Object.keys(v as object).length) ? null : JSON.stringify(v));
const bool = (v: boolean | undefined) => (v === undefined ? null : v ? 1 : 0);

/** Rows in multi-row INSERTs of at most `per` rows each, so a big batch is a few statements and never passes a parameter limit. */
async function insertMany<T>(tx: { execute(sql: string, params?: unknown[]): Promise<void> }, head: string, cols: number, rows: T[], values: (r: T) => unknown[], tail = "", per = 200) {
  const tuple = `(${Array(cols).fill("?").join(", ")})`;
  for (let i = 0; i < rows.length; i += per) {
    const chunk = rows.slice(i, i + per);
    await tx.execute(`${head} VALUES ${Array(chunk.length).fill(tuple).join(", ")}${tail}`, chunk.flatMap(values));
  }
}

/** Self time: a span's duration minus the parts of it its children cover (overlapping children count once). Spans without children are absent: theirs is their duration. */
export function selfTimes(spans: Span[]): Map<string, number> {
  const children = new Map<string, Span[]>();
  for (const s of spans) if (s.parentId) (children.get(s.parentId) ?? children.set(s.parentId, []).get(s.parentId)!).push(s);
  const out = new Map<string, number>();
  for (const s of spans) {
    const own = children.get(s.spanId);
    if (!own) continue;
    const kids = own.map((c) => [Math.max(c.start, s.start), Math.min(c.start + c.duration, s.start + s.duration)] as const).filter(([a, b]) => b > a);
    kids.sort((a, b) => a[0] - b[0]);
    let covered = 0;
    let end = -Infinity;
    for (const [a, b] of kids) {
      if (b <= end) continue;
      covered += b - Math.max(a, end);
      end = b;
    }
    out.set(s.spanId, Math.max(0, s.duration - covered));
  }
  return out;
}

export class TelemetryStore {
  constructor(readonly db: Db) {}

  async write(batch: TelemetryBatch) {
    const T = TABLES;
    await this.db.transaction("write", async (tx) => {
      if (batch.traces?.length || batch.spans?.length) await this.writeTraces(tx, batch.traces ?? [], batch.spans ?? []);
      if (batch.logs?.length)
        await insertMany(tx, `INSERT INTO ${T.logs} ("time", "service", "instance", "level", "name", "message", "trace_id", "span_id", "attrs")`, 9, batch.logs, (l: LogRecord) => [
          l.time,
          l.service,
          l.instance ?? null,
          l.level,
          l.name.slice(0, 200),
          l.message.slice(0, 8000),
          l.traceId ?? null,
          l.spanId ?? null,
          json(l.attrs),
        ]);
      if (batch.rollups?.length)
        await insertMany(
          tx,
          `INSERT INTO ${T.rollups} ("minute", "res", "service", "kind", "operation", "instance", "count", "errors", "client_errors", "cached", "sum", "max", "hist")`,
          13,
          batch.rollups,
          (r: Rollup) => [r.minute, 1, r.service, r.kind, r.operation.slice(0, 300), r.instance, r.count, r.errors, r.clientErrors, r.cached, r.sum, r.max, JSON.stringify(r.hist)],
          ` ON CONFLICT ("minute", "service", "kind", "operation", "instance") DO UPDATE SET "count" = excluded."count", "errors" = excluded."errors", "client_errors" = excluded."client_errors", "cached" = excluded."cached", "sum" = excluded."sum", "max" = excluded."max", "hist" = excluded."hist"`,
        );
      if (batch.spanRollups?.length)
        await insertMany(
          tx,
          `INSERT INTO ${T.spanRollups} ("minute", "res", "service", "type", "name", "namespace", "instance", "count", "errors", "sum", "self", "max", "hist")`,
          13,
          batch.spanRollups,
          (r: SpanRollup) => [r.minute, 1, r.service, r.type, r.name.slice(0, 300), r.namespace.slice(0, 200), r.instance, r.count, r.errors, r.sum, r.self, r.max, JSON.stringify(r.hist)],
          ` ON CONFLICT ("minute", "service", "type", "name", "namespace", "instance") DO UPDATE SET "count" = excluded."count", "errors" = excluded."errors", "sum" = excluded."sum", "self" = excluded."self", "max" = excluded."max", "hist" = excluded."hist"`,
        );
      if (batch.samples?.length)
        await insertMany(
          tx,
          `INSERT INTO ${T.samples} ("time", "res", "service", "instance", "role", "cpu", "cpu_user", "cpu_system", "rss", "heap_used", "heap_total", "loop_mean", "loop_p99", "loop_max", "connections", "subscriptions", "cache_hits", "cache_misses", "cache_shared", "cache_entries", "inflight")`,
          21,
          batch.samples,
          (s: RuntimeSample) => [
            s.time,
            10,
            s.service,
            s.instance,
            s.role,
            s.cpu,
            s.cpuUser,
            s.cpuSystem,
            s.rss,
            s.heapUsed,
            s.heapTotal,
            s.loopMean,
            s.loopP99,
            s.loopMax,
            s.connections ?? null,
            s.subscriptions ?? null,
            s.cacheHits ?? null,
            s.cacheMisses ?? null,
            s.cacheShared ?? null,
            s.cacheEntries ?? null,
            s.inflight ?? null,
          ],
        );
      if (batch.metrics?.length)
        await insertMany(
          tx,
          `INSERT INTO ${T.metrics} ("minute", "service", "name", "type", "unit", "attrs", "instance", "value", "count", "min", "max", "total")`,
          12,
          batch.metrics,
          (m: MetricPoint) => [m.minute, m.service, m.name, m.type, m.unit ?? null, m.attrs, m.instance, m.value, m.count, m.min, m.max, m.total ?? null],
          ` ON CONFLICT ("minute", "service", "name", "attrs", "instance") DO UPDATE SET "type" = excluded."type", "unit" = excluded."unit", "value" = excluded."value", "count" = excluded."count", "min" = excluded."min", "max" = excluded."max", "total" = excluded."total"`,
        );
      // One row per service: the attributes of its latest report.
      const seen = new Map((batch.services ?? []).map((s) => [s.service, s]));
      for (const s of seen.values())
        await tx.execute(
          `INSERT INTO ${T.services} ("service", "attrs", "first_seen", "last_seen") VALUES (?, ?, ?, ?) ON CONFLICT ("service") DO UPDATE SET "attrs" = excluded."attrs", "last_seen" = excluded."last_seen"`,
          [s.service, json(s.attrs), s.time, s.time],
        );
      for (const r of batch.releases ?? [])
        await tx.execute(
          `INSERT INTO ${T.releases} ("service", "version", "first_seen", "last_seen") VALUES (?, ?, ?, ?) ON CONFLICT ("service", "version") DO UPDATE SET "last_seen" = CASE WHEN excluded."last_seen" > ${T.releases}."last_seen" THEN excluded."last_seen" ELSE ${T.releases}."last_seen" END, "first_seen" = CASE WHEN excluded."first_seen" < ${T.releases}."first_seen" THEN excluded."first_seen" ELSE ${T.releases}."first_seen" END`,
          [r.service, r.version, r.time, r.time],
        );
    });
  }

  private async writeTraces(tx: { execute(sql: string, params?: unknown[]): Promise<void> }, traces: TraceRecord[], loose: Span[]) {
    const T = TABLES;
    const errors = new Map<string, { fp: string; t: TraceRecord; count: number }>();
    for (const t of traces) {
      const e = t.request.error;
      if (!e) continue;
      const fp = fingerprint(e.type, e.message, e.stack);
      (t.request as { errorGroup?: string }).errorGroup = fp;
      const prev = errors.get(fp);
      errors.set(fp, { fp, t: prev && prev.t.request.time > t.request.time ? prev.t : t, count: (prev?.count ?? 0) + t.request.weight });
    }
    await insertMany(
      tx,
      `INSERT INTO ${T.requests} ("trace_id", "span_id", "time", "duration", "service", "instance", "kind", "operation", "method", "status", "user_id", "user_name", "error_group", "error_message", "handled", "cache", "release", "weight", "queue_wait", "span_count", "attrs", "request_id")`,
      22,
      traces,
      ({ request: r, spans }) => [
        r.traceId,
        r.spanId,
        r.time,
        r.duration,
        r.service,
        r.instance ?? null,
        r.kind,
        r.operation.slice(0, 300),
        r.method ?? null,
        r.status,
        r.userId ?? null,
        r.userName ?? null,
        (r as { errorGroup?: string }).errorGroup ?? null,
        r.error?.message.slice(0, 2000) ?? null,
        bool(r.error?.handled),
        r.cache ?? null,
        r.release ?? null,
        r.weight,
        r.queueWait ?? null,
        spans.length,
        json(r.attrs),
        r.attrs?.["forge.request_id"] ?? null,
      ],
      ` ON CONFLICT ("trace_id", "span_id") DO NOTHING`,
    );
    const spans = traces.flatMap((t) => {
      const self = selfTimes(t.spans);
      return t.spans.map((s) => ({ s, self: self.get(s.spanId) ?? s.duration, service: s.service ?? t.request.service }));
    });
    if (loose.length) {
      const self = selfTimes(loose);
      for (const s of loose) spans.push({ s, self: self.get(s.spanId) ?? s.duration, service: s.service ?? "unknown_service" });
    }
    await insertMany(
      tx,
      `INSERT INTO ${T.spans} ("trace_id", "span_id", "parent_id", "time", "duration", "self", "service", "name", "type", "kind", "status", "error", "attrs")`,
      13,
      spans,
      ({ s, self, service }) => [
        s.traceId,
        s.spanId,
        s.parentId ?? null,
        s.start,
        s.duration,
        self,
        service,
        s.name.slice(0, 300),
        s.type,
        s.kind ?? null,
        s.status ?? null,
        s.error?.slice(0, 2000) ?? null,
        json(s.rows === undefined ? s.attrs : { ...s.attrs, "db.response.returned_rows": s.rows }),
      ],
      ` ON CONFLICT ("trace_id", "span_id") DO NOTHING`,
    );
    for (const { fp, t, count } of errors.values()) {
      const r = t.request;
      const e = r.error!;
      await tx.execute(
        `INSERT INTO ${T.errors} ("fingerprint", "service", "type", "message", "handled", "status", "operation", "first_seen", "last_seen", "count", "state", "stack", "sample_trace") VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)
         ON CONFLICT ("fingerprint") DO UPDATE SET "count" = ${T.errors}."count" + excluded."count", "last_seen" = excluded."last_seen", "message" = excluded."message", "status" = excluded."status", "operation" = excluded."operation", "stack" = COALESCE(excluded."stack", ${T.errors}."stack"), "sample_trace" = excluded."sample_trace",
         "state" = CASE WHEN ${T.errors}."state" = 'resolved' THEN 'open' ELSE ${T.errors}."state" END`,
        [fp, r.service, e.type, e.message.slice(0, 2000), e.handled ? 1 : 0, r.status, r.operation, r.time, r.time, count, e.stack?.slice(0, 16_000) ?? null, r.traceId],
      );
    }
  }

  /**
   * Deletes what is older than the retention, and folds minute rollups older than two days into hourly ones (and runtime samples into
   * five-minute averages), so long ranges read a few hundred rows per series instead of tens of thousands.
   */
  async compact(retentionDays: number, now = Date.now()) {
    const T = TABLES;
    const cutoff = now - retentionDays * 86_400_000;
    const longCutoff = now - Math.max(30, retentionDays) * 86_400_000;
    const foldBefore = Math.floor((now - 2 * 86_400_000) / 3_600_000) * 60; // a whole hour, in minutes
    await this.db.transaction("write", async (tx) => {
      await tx.execute(`DELETE FROM ${T.requests} WHERE "time" < ?`, [cutoff]);
      await tx.execute(`DELETE FROM ${T.spans} WHERE "time" < ?`, [cutoff]);
      await tx.execute(`DELETE FROM ${T.logs} WHERE "time" < ?`, [cutoff]);
      await tx.execute(`DELETE FROM ${T.errors} WHERE "last_seen" < ?`, [longCutoff]);
      await tx.execute(`DELETE FROM ${T.rollups} WHERE "minute" < ?`, [Math.floor(longCutoff / 60_000)]);
      await tx.execute(`DELETE FROM ${T.spanRollups} WHERE "minute" < ?`, [Math.floor(longCutoff / 60_000)]);
      await tx.execute(`DELETE FROM ${T.metrics} WHERE "minute" < ?`, [Math.floor(longCutoff / 60_000)]);
      await tx.execute(`DELETE FROM ${T.samples} WHERE "time" < ?`, [longCutoff]);
      await tx.execute(`DELETE FROM ${T.events} WHERE "time" < ?`, [longCutoff]);
    });
    await this.fold(T.rollups, ["service", "kind", "operation"], ["count", "errors", "client_errors", "cached", "sum"], foldBefore);
    await this.fold(T.spanRollups, ["service", "type", "name", "namespace"], ["count", "errors", "sum", "self"], foldBefore);
    await this.foldSamples(foldBefore * 60_000);
  }

  /** Merges a rollup table's minute rows before `before` into one row per hour (res 60), summing counts and histograms. */
  private async fold(table: string, keys: string[], sums: string[], before: number) {
    const LIMIT = 50_000;
    let rows = await this.db.query<Record<string, any>>(`SELECT * FROM ${table} WHERE "res" = 1 AND "minute" < ? ORDER BY "minute" LIMIT ${LIMIT}`, [before]);
    if (!rows.length) return;
    // A full page may have cut the last minute's rows short: leave that minute for the next pass.
    const full = rows.length === LIMIT;
    const upTo = full ? Number(rows.at(-1)!.minute) : before;
    if (full) rows = rows.filter((r) => Number(r.minute) < upTo);
    const groups = new Map<string, Record<string, any>>();
    for (const r of rows) {
      const hour = Math.floor(Number(r.minute) / 60) * 60;
      const key = `${hour}\u0000${keys.map((k) => r[k]).join("\u0000")}`;
      const g = groups.get(key);
      if (!g) groups.set(key, { ...r, minute: hour, res: 60, instance: "*", hist: merge({}, r.hist) });
      else {
        for (const s of sums) g[s] = Number(g[s]) + Number(r[s]);
        g.max = Math.max(Number(g.max), Number(r.max));
        merge(g.hist, r.hist);
      }
    }
    const all = ["minute", "res", ...keys, "instance", ...sums, "max", "hist"];
    await this.db.transaction("write", async (tx) => {
      await tx.execute(`DELETE FROM ${table} WHERE "res" = 1 AND "minute" < ?`, [upTo]);
      // An hour folded in an earlier pass (its rows split across two passes) gets this pass's rows added to it.
      for (const g of groups.values()) {
        g.hist = JSON.stringify(g.hist);
        const existing = await tx.query<Record<string, any>>(`SELECT * FROM ${table} WHERE "minute" = ? AND "res" = 60 AND ${keys.map((k) => `"${k}" = ?`).join(" AND ")} AND "instance" = '*'`, [
          g.minute,
          ...keys.map((k) => g[k]),
        ]);
        if (existing[0]) {
          for (const s of sums) g[s] = Number(g[s]) + Number(existing[0][s]);
          g.max = Math.max(Number(g.max), Number(existing[0].max));
          g.hist = JSON.stringify(merge(JSON.parse(g.hist), existing[0].hist));
          await tx.execute(`DELETE FROM ${table} WHERE "minute" = ? AND "res" = 60 AND ${keys.map((k) => `"${k}" = ?`).join(" AND ")} AND "instance" = '*'`, [g.minute, ...keys.map((k) => g[k])]);
        }
        await tx.execute(`INSERT INTO ${table} (${all.map((c) => `"${c}"`).join(", ")}) VALUES (${all.map(() => "?").join(", ")})`, all.map((c) => g[c]));
      }
    });
    if (full && rows.length) await this.fold(table, keys, sums, before);
  }

  /** Runtime samples older than two days become one averaged row per instance and five minutes. */
  private async foldSamples(before: number) {
    const T = TABLES;
    const LIMIT = 50_000;
    let rows = await this.db.query<Record<string, any>>(`SELECT * FROM ${T.samples} WHERE "time" < ? AND "res" = 10 ORDER BY "time" LIMIT ${LIMIT}`, [before]);
    if (!rows.length) return;
    const full = rows.length === LIMIT;
    // Whole five-minute slots only: a slot the page cut short waits for the next pass.
    const upTo = full ? Math.floor(Number(rows.at(-1)!.time) / 300_000) * 300_000 : before;
    if (full) rows = rows.filter((r) => Number(r.time) < upTo);
    const nums = ["cpu", "cpu_user", "cpu_system", "rss", "heap_used", "heap_total", "loop_mean", "loop_p99", "connections", "subscriptions", "cache_entries", "inflight"];
    const sums = ["cache_hits", "cache_misses", "cache_shared"];
    const groups = new Map<string, { row: Record<string, any>; n: number }>();
    for (const r of rows) {
      const slot = Math.floor(Number(r.time) / 300_000) * 300_000;
      const key = `${slot}\u0000${r.instance}`;
      const g = groups.get(key);
      if (!g) groups.set(key, { row: { ...r, time: slot, res: 300 }, n: 1 });
      else {
        g.n++;
        for (const k of nums) g.row[k] = r[k] === null ? g.row[k] : Number(g.row[k] ?? 0) + Number(r[k]);
        for (const k of sums) g.row[k] = r[k] === null ? g.row[k] : Number(g.row[k] ?? 0) + Number(r[k]);
        g.row.loop_max = Math.max(Number(g.row.loop_max ?? 0), Number(r.loop_max ?? 0));
      }
    }
    const cols = ["time", "res", "service", "instance", "role", ...nums, ...sums, "loop_max"];
    await this.db.transaction("write", async (tx) => {
      await tx.execute(`DELETE FROM ${T.samples} WHERE "time" < ? AND "res" = 10`, [upTo]);
      for (const { row, n } of groups.values()) {
        for (const k of nums) if (row[k] !== null && row[k] !== undefined) row[k] = Number(row[k]) / n;
        await tx.execute(`INSERT INTO ${T.samples} (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`, cols.map((c) => row[c] ?? null));
      }
    });
    if (full && rows.length) await this.foldSamples(before);
  }
}
