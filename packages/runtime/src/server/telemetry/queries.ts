// The dashboard's reads, run on the telemetry worker. Totals, rates and percentiles come from rollups (every request); lists of
// individual requests, users and error occurrences come from kept traces, counted by their weight. Ranges are epoch milliseconds.
import type { Db } from "../db/types";
import { countUnder, merge, quantile, rebin, record as recordHist, total, type Histogram } from "./histogram";
import { TABLES as T } from "./store";
import { apdexT, impactReason, impactScore } from "./traceway";

export interface Range {
  from: number;
  to: number;
  service?: string;
}

const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440];
/** A bucket size giving about `target` buckets over the range, on a round number of minutes. */
export const stepFor = (from: number, to: number, target = 60) => (STEPS.find((s) => s >= (to - from) / 60_000 / target) ?? 1440) * 60_000;
const starts = (from: number, to: number, step: number) => {
  const out: number[] = [];
  for (let t = Math.floor(from / step) * step; t < to; t += step) out.push(t);
  return out;
};

type RollupRow = { minute: number; res: number; kind: string; operation: string; service: string; count: number; errors: number; client_errors: number; cached: number; sum: number; max: number; hist: string };
type SpanRollupRow = { minute: number; res: number; type: string; name: string; namespace: string; service: string; count: number; errors: number; sum: number; self: number; max: number; hist: string };

export interface Agg {
  count: number;
  errors: number;
  clientErrors: number;
  cached: number;
  sum: number;
  max: number;
  hist: Histogram;
}
const empty = (): Agg => ({ count: 0, errors: 0, clientErrors: 0, cached: 0, sum: 0, max: 0, hist: {} });
function add(a: Agg, r: RollupRow) {
  a.count += Number(r.count);
  a.errors += Number(r.errors);
  a.clientErrors += Number(r.client_errors);
  a.cached += Number(r.cached);
  a.sum += Number(r.sum);
  a.max = Math.max(a.max, Number(r.max));
  merge(a.hist, r.hist);
  return a;
}
const stats = (a: Agg, kind = "query") => ({
  count: a.count,
  errors: a.errors,
  clientErrors: a.clientErrors,
  cached: a.cached,
  avg: a.count ? a.sum / a.count : 0,
  p50: quantile(a.hist, 0.5),
  p95: quantile(a.hist, 0.95),
  p99: quantile(a.hist, 0.99),
  max: a.max,
  apdex: apdex(a, kind),
});
/** Apdex with Traceway's split (satisfied ≤ T, tolerating ≤ 2T); server errors count as frustrated. */
function apdex(a: Agg, kind: string) {
  if (!a.count) return null;
  const t = apdexT(kind);
  const okShare = 1 - a.errors / a.count;
  const satisfied = countUnder(a.hist, t) * okShare;
  const tolerating = (countUnder(a.hist, 2 * t) - countUnder(a.hist, t)) * okShare;
  return (satisfied + tolerating / 2) / a.count;
}
function impact(kind: string, operation: string, a: Agg) {
  const t = apdexT(kind);
  const okShare = a.count ? 1 - a.errors / a.count : 1;
  const satisfied = countUnder(a.hist, t) * okShare;
  const tolerating = (countUnder(a.hist, 2 * t) - countUnder(a.hist, t)) * okShare;
  const input = { operation, total: a.count, satisfied, tolerating, bad: a.count - satisfied - tolerating, clientErrors: a.clientErrors, p99Ms: quantile(a.hist, 0.99) };
  return { impact: impactScore(input), reason: impactReason(input) };
}

const svc = (service?: string, col = `"service"`) => (service ? { sql: ` AND ${col} = ?`, params: [service] } : { sql: "", params: [] as unknown[] });

/** Kinds that are jobs, shown on their own page rather than among requests. */
const JOB_KINDS = new Set(["job", "cron", "consumer"]);

export function buildQueries(db: Db) {
  async function rollupRows(r: Range, where = "", params: unknown[] = []): Promise<RollupRow[]> {
    const s = svc(r.service);
    const from = Math.floor(r.from / 60_000);
    const to = Math.ceil(r.to / 60_000);
    const rows = await db.query<RollupRow>(
      `SELECT "minute", "res", "kind", "operation", "service", "count", "errors", "client_errors", "cached", "sum", "max", "hist" FROM ${T.rollups} WHERE "minute" >= ? AND "minute" < ?${s.sql}${where}`,
      [from - 59, to, ...s.params, ...params],
    );
    return rows.filter((row) => Number(row.minute) + Number(row.res) > from);
  }

  async function spanRows(r: Range, where = "", params: unknown[] = []): Promise<SpanRollupRow[]> {
    const s = svc(r.service);
    const from = Math.floor(r.from / 60_000);
    const rows = await db.query<SpanRollupRow>(
      `SELECT "minute", "res", "type", "name", "namespace", "service", "count", "errors", "sum", "self", "max", "hist" FROM ${T.spanRollups} WHERE "minute" >= ? AND "minute" < ?${s.sql}${where}`,
      [from - 59, Math.ceil(r.to / 60_000), ...s.params, ...params],
    );
    return rows.filter((row) => Number(row.minute) + Number(row.res) > from);
  }

  /** Per bucket: counts by outcome, average and percentiles. */
  function series(rows: RollupRow[], r: Range, step = stepFor(r.from, r.to)) {
    const at = starts(r.from, r.to, step);
    const aggs = at.map(() => empty());
    for (const row of rows) {
      const i = Math.floor((Number(row.minute) * 60_000 - at[0]!) / step);
      if (i >= 0 && i < aggs.length) add(aggs[i]!, row);
    }
    return {
      step,
      points: at.map((t, i) => {
        const a = aggs[i]!;
        return { t, count: a.count, errors: a.errors, clientErrors: a.clientErrors, ok: a.count - a.errors - a.clientErrors, avg: a.count ? a.sum / a.count : null, p95: a.count ? quantile(a.hist, 0.95) : null, max: a.count ? a.max : null };
      }),
    };
  }

  const previous = (r: Range): Range => ({ ...r, from: r.from - (r.to - r.from), to: r.from });
  const totals = (rows: RollupRow[]) => rows.reduce(add, empty());

  /** Request operations in a range, with their statistics and Traceway's impact score. */
  async function operations(r: Range, jobs: boolean) {
    const rows = (await rollupRows(r, ` AND "kind" <> '*'`)).filter((x) => JOB_KINDS.has(x.kind) === jobs);
    const groups = new Map<string, { kind: string; operation: string; agg: Agg; last: number }>();
    for (const row of rows) {
      const key = `${row.kind}\u0000${row.operation}`;
      const g = groups.get(key) ?? groups.set(key, { kind: row.kind, operation: row.operation, agg: empty(), last: 0 }).get(key)!;
      add(g.agg, row);
      g.last = Math.max(g.last, Number(row.minute) * 60_000);
    }
    return [...groups.values()].map((g) => ({ kind: g.kind, operation: g.operation, ...stats(g.agg, g.kind), ...impact(g.kind, g.operation, g.agg), lastSeen: g.last, threshold: apdexT(g.kind) }));
  }

  /** Requests kept in a range (weighted), as rows. */
  const requestRows = <R>(sql: string, params: unknown[]) => db.query<R>(sql, params);

  async function errorTotals(r: Range, where = "", params: unknown[] = []) {
    const s = svc(r.service);
    return db.query<{ group: string; n: number; users: number; last: number; first: number }>(
      `SELECT "error_group" AS "group", SUM("weight") AS "n", COUNT(DISTINCT "user_id") AS "users", MAX("time") AS "last", MIN("time") AS "first" FROM ${T.requests} WHERE "error_group" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql}${where} GROUP BY "error_group"`,
      [r.from, r.to, ...s.params, ...params],
    );
  }

  async function errorGroups(fingerprints: string[]) {
    if (!fingerprints.length) return new Map<string, Record<string, any>>();
    const rows = await db.query<Record<string, any>>(`SELECT * FROM ${T.errors} WHERE "fingerprint" IN (${fingerprints.map(() => "?").join(", ")})`, fingerprints);
    return new Map(rows.map((row) => [row.fingerprint, row]));
  }

  async function releaseImpact(service: string, version: string, at: number, window = 30 * 60_000) {
    // Rollups are per minute: the minute the release started in counts as after it.
    const cut = Math.floor(at / 60_000) * 60_000;
    const before: Range = { from: cut - window, to: cut, service };
    const after: Range = { from: cut, to: cut + window, service };
    const [b, a] = await Promise.all([rollupRows(before), rollupRows(after)]);
    const all = (rows: RollupRow[]) => totals(rows.filter((x) => x.kind === "*"));
    const tb = all(b);
    const ta = all(a);
    const rate = (x: Agg) => (x.count ? x.errors / x.count : 0);
    const byOp = (rows: RollupRow[]) => {
      const m = new Map<string, Agg>();
      for (const row of rows) if (row.kind !== "*") add(m.get(`${row.kind} ${row.operation}`) ?? m.set(`${row.kind} ${row.operation}`, empty()).get(`${row.kind} ${row.operation}`)!, row);
      return m;
    };
    const ob = byOp(b);
    const oa = byOp(a);
    const ops = [...oa]
      .filter(([k, x]) => x.count >= 5 && (ob.get(k)?.count ?? 0) >= 5)
      .map(([k, x]) => {
        const y = ob.get(k)!;
        return { operation: k.slice(k.indexOf(" ") + 1), kind: k.slice(0, k.indexOf(" ")), before: { count: y.count, errorRate: rate(y), p95: quantile(y.hist, 0.95), avg: y.sum / y.count }, after: { count: x.count, errorRate: rate(x), p95: quantile(x.hist, 0.95), avg: x.sum / x.count } };
      })
      .sort((p, q) => q.after.errorRate - q.before.errorRate - (p.after.errorRate - p.before.errorRate) || q.after.p95 / (q.before.p95 || 1) - p.after.p95 / (p.before.p95 || 1));
    // What the code does differently: per request, how often each span runs and how long it takes.
    const [sb, sa] = await Promise.all([spanRows(before), spanRows(after)]);
    const perRequest = (rows: SpanRollupRow[], n: number) => {
      const m = new Map<string, { calls: number; ms: number }>();
      for (const row of rows) {
        const k = `${row.type}\u0000${row.name}`;
        const e = m.get(k) ?? m.set(k, { calls: 0, ms: 0 }).get(k)!;
        e.calls += Number(row.count) / (n || 1);
        e.ms += Number(row.sum) / (n || 1);
      }
      return m;
    };
    const pb = perRequest(sb, tb.count);
    const pa = perRequest(sa, ta.count);
    const changes = [...pa]
      .map(([k, x]) => {
        const y = pb.get(k);
        const [type, name] = k.split("\u0000") as [string, string];
        return { type, name, isNew: !y, calls: x.calls, callsBefore: y?.calls ?? 0, msPerRequest: x.ms, msPerRequestBefore: y?.ms ?? 0, delta: x.ms - (y?.ms ?? 0) };
      })
      .filter((c) => c.delta > 0.5 || c.isNew)
      .sort((p, q) => q.delta - p.delta)
      .slice(0, 8);
    const complete = Date.now() >= at + window;
    const enough = tb.count >= 20 && ta.count >= 20;
    const errUp = rate(ta) - rate(tb);
    const latUp = tb.count && ta.count ? ta.sum / ta.count / (tb.sum / tb.count) - 1 : 0;
    const p95Up = quantile(tb.hist, 0.95) ? quantile(ta.hist, 0.95) / quantile(tb.hist, 0.95) - 1 : 0;
    const verdict = !enough
      ? complete
        ? "quiet"
        : "early"
      : errUp > Math.max(0.01, rate(tb) * 0.5) || p95Up > 0.25 || latUp > 0.25
        ? "regression"
        : errUp < -Math.max(0.01, rate(tb) * 0.5) || p95Up < -0.2
          ? "improvement"
          : "stable";
    return {
      service,
      version,
      at,
      verdict,
      complete,
      before: { count: tb.count, errorRate: rate(tb), avg: tb.count ? tb.sum / tb.count : 0, p95: quantile(tb.hist, 0.95) },
      after: { count: ta.count, errorRate: rate(ta), avg: ta.count ? ta.sum / ta.count : 0, p95: quantile(ta.hist, 0.95) },
      operations: ops.slice(0, 8),
      changes,
    };
  }

  async function latestRelease(service?: string) {
    const s = svc(service);
    const [row] = await db.query<{ service: string; version: string; first_seen: number }>(`SELECT * FROM ${T.releases} WHERE 1 = 1${s.sql} ORDER BY "first_seen" DESC LIMIT 1`, s.params);
    return row ? releaseImpact(row.service, row.version, Number(row.first_seen)) : null;
  }

  return {
    async overview(r: Range) {
      const rows = await rollupRows(r);
      const all = rows.filter((x) => x.kind === "*");
      const reqRows = rows.filter((x) => x.kind !== "*" && !JOB_KINDS.has(x.kind));
      const jobRows = rows.filter((x) => JOB_KINDS.has(x.kind));
      const prev = await rollupRows(previous(r), ` AND "kind" = '*'`);
      const reqTotals = totals(reqRows);
      const prevTotals = totals(prev);
      const ops = await operations(r, false);
      const jobs = totals(jobRows);
      const [prevJobRows, spans, errs] = await Promise.all([rollupRows(previous(r), ` AND "kind" IN ('job', 'cron', 'consumer')`), spanRows(r), errorTotals(r)]);
      const prevJobs = totals(prevJobRows);
      const code = new Map<string, { namespace: string; type: string; self: number; count: number }>();
      for (const s of spans) {
        const k = `${s.type}\u0000${s.namespace}`;
        const e = code.get(k) ?? code.set(k, { namespace: s.namespace, type: s.type, self: 0, count: 0 }).get(k)!;
        e.self += Number(s.self);
        e.count += Number(s.count);
      }
      const ownTotal = [...code.values()].reduce((n, c) => n + c.self, 0);
      const groups = await errorGroups(errs.map((e) => e.group));
      const step = stepFor(r.from, r.to);
      const allTotals = totals(all);
      return {
        step,
        requests: { ...stats(reqTotals), previous: prevTotals.count - prevJobs.count, series: series(reqRows, r, step).points },
        all: { ...stats(allTotals), previous: prevTotals.count },
        outliers: ops
          .filter((o) => o.count >= 1)
          .map((o) => ({ kind: o.kind, operation: o.operation, p95: o.p95, count: o.count, threshold: o.threshold, ratio: o.p95 / o.threshold }))
          .sort((a, b) => b.ratio - a.ratio)
          .slice(0, 8),
        throughput: ops
          .map((o) => ({ kind: o.kind, operation: o.operation, count: o.count, share: reqTotals.count ? o.count / reqTotals.count : 0 }))
          .sort((a, b) => b.count - a.count)
          .slice(0, 8),
        code: { total: ownTotal, items: [...code.values()].sort((a, b) => b.self - a.self).map((c) => ({ ...c, share: ownTotal ? c.self / ownTotal : 0 })) },
        errors: {
          unhandled: reqTotals.errors,
          handled: reqTotals.clientErrors,
          rate: reqTotals.count ? reqTotals.errors / reqTotals.count : 0,
          rateWithHandled: reqTotals.count ? (reqTotals.errors + reqTotals.clientErrors) / reqTotals.count : 0,
          series: series(reqRows, r, step).points.map((p) => ({ t: p.t, unhandled: p.errors, handled: p.clientErrors })),
        },
        issues: errs
          .map((e): Record<string, any> => ({ ...e, ...groups.get(e.group) }))
          .filter((e) => e.state !== "ignored")
          .sort((a, b) => Number(b.last) - Number(a.last))
          .slice(0, 6)
          .map((e) => ({ fingerprint: e.group, type: e.type, message: e.message, count: Number(e.n), users: Number(e.users), last: Number(e.last), status: Number(e.status), handled: Boolean(e.handled), state: e.state })),
        jobs: { ...stats(jobs, "job"), previous: prevJobs.count, series: series(jobRows, r, step).points },
        release: await latestRelease(r.service),
      };
    },

    async requests(r: Range & { kind?: string }) {
      const rows = (await rollupRows(r, ` AND "kind" <> '*'`)).filter((x) => !JOB_KINDS.has(x.kind) && (!r.kind || x.kind === r.kind));
      const prev = (await rollupRows(previous(r), ` AND "kind" <> '*'`)).filter((x) => !JOB_KINDS.has(x.kind) && (!r.kind || x.kind === r.kind));
      const ops = (await operations(r, false)).filter((o) => !r.kind || o.kind === r.kind);
      const t = totals(rows);
      const p = totals(prev);
      return { ...stats(t), previous: { count: p.count, avg: p.count ? p.sum / p.count : 0, p95: quantile(p.hist, 0.95) }, inflight: null, series: series(rows, r).points, step: stepFor(r.from, r.to), operations: ops };
    },

    /** Scheduled functions, crons and consumed messages: runs and failures from rollups, time waiting in the queue from kept runs. */
    async jobs(r: Range) {
      const rows = await rollupRows(r, ` AND "kind" IN ('job', 'cron', 'consumer')`);
      const prev = await rollupRows(previous(r), ` AND "kind" IN ('job', 'cron', 'consumer')`);
      const step = stepFor(r.from, r.to);
      const s = svc(r.service);
      const waits = await db.query<{ operation: string; kind: string; queue_wait: number; time: number; weight: number; attrs: string | null }>(
        `SELECT "operation", "kind", "queue_wait", "time", "weight", "attrs" FROM ${T.requests} WHERE "kind" IN ('job', 'cron', 'consumer') AND "queue_wait" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql} ORDER BY "time" DESC LIMIT 100000`,
        [r.from, r.to, ...s.params],
      );
      const at = starts(r.from, r.to, step);
      const perBucket = at.map(() => ({} as Histogram));
      const perOp = new Map<string, { hist: Histogram; sum: number; n: number; queue?: string }>();
      const all: Histogram = {};
      let sum = 0;
      let n = 0;
      for (const w of waits) {
        const v = Number(w.queue_wait);
        const weight = Number(w.weight);
        recordHist(all, v, weight);
        sum += v * weight;
        n += weight;
        const i = Math.floor((Number(w.time) - at[0]!) / step);
        if (i >= 0 && i < at.length) recordHist(perBucket[i]!, v, weight);
        const k = `${w.kind}\u0000${w.operation}`;
        const e = perOp.get(k) ?? perOp.set(k, { hist: {}, sum: 0, n: 0 }).get(k)!;
        recordHist(e.hist, v, weight);
        e.sum += v * weight;
        e.n += weight;
        e.queue ??= (() => {
          try {
            return String(JSON.parse(w.attrs ?? "{}")["job.queue"] ?? "") || undefined;
          } catch {
            return undefined;
          }
        })();
      }
      const t = totals(rows);
      return {
        ...stats(t, "job"),
        previous: totals(prev).count,
        step,
        series: series(rows, r, step).points,
        wait: { avg: n ? sum / n : null, p95: n ? quantile(all, 0.95) : null, series: at.map((time, i) => ({ t: time, p95: total(perBucket[i]!) ? quantile(perBucket[i]!, 0.95) : null, p50: total(perBucket[i]!) ? quantile(perBucket[i]!, 0.5) : null })) },
        operations: (await operations(r, true)).map((o) => {
          const w = perOp.get(`${o.kind}\u0000${o.operation}`);
          return { ...o, queue: w?.queue ?? (o.kind === "cron" ? "cron" : o.kind === "consumer" ? "consumer" : "scheduler"), waitAvg: w?.n ? w.sum / w.n : null, waitP95: w?.n ? quantile(w.hist, 0.95) : null };
        }),
      };
    },

    /** One operation (or job): numbers, series, the shape of its latency, its weekly rhythm and its recent calls. */
    async operation(r: Range & { kind: string; operation: string; tzOffset?: number; before?: number }) {
      const rows = await rollupRows(r, ` AND "kind" = ? AND "operation" = ?`, [r.kind, r.operation]);
      const prev = await rollupRows(previous(r), ` AND "kind" = ? AND "operation" = ?`, [r.kind, r.operation]);
      const t = totals(rows);
      const edges = (() => {
        const p99 = Math.max(1, quantile(t.hist, 0.99));
        const step = p99 / 24;
        return Array.from({ length: 25 }, (_, i) => (i + 1) * step);
      })();
      const week: Range = { from: Date.now() - 7 * 86_400_000, to: Date.now(), service: r.service };
      const weekRows = await rollupRows(week, ` AND "kind" = ? AND "operation" = ?`, [r.kind, r.operation]);
      const tz = (r.tzOffset ?? 0) * 60_000;
      const cells = Array.from({ length: 7 * 12 }, () => empty());
      for (const row of weekRows) {
        const local = new Date(Number(row.minute) * 60_000 - tz);
        add(cells[local.getUTCDay() * 12 + Math.floor(local.getUTCHours() / 2)]!, row);
      }
      const s = svc(r.service);
      const calls = await requestRows<Record<string, any>>(
        `SELECT "trace_id", "span_id", "time", "duration", "status", "user_id", "user_name", "error_message", "handled", "cache", "method", "release", "weight", "queue_wait", "span_count", "instance" FROM ${T.requests} WHERE "kind" = ? AND "operation" = ? AND "time" >= ? AND "time" < ?${s.sql} ORDER BY "time" DESC LIMIT 50`,
        [r.kind, r.operation, r.from, Math.min(r.to, r.before ?? r.to), ...s.params],
      );
      const last = await db.query<{ time: number }>(`SELECT MAX("time") AS "time" FROM ${T.requests} WHERE "kind" = ? AND "operation" = ?`, [r.kind, r.operation]);
      return {
        kind: r.kind,
        operation: r.operation,
        ...stats(t, r.kind),
        ...impact(r.kind, r.operation, t),
        threshold: apdexT(r.kind),
        previous: { count: totals(prev).count, avg: totals(prev).count ? totals(prev).sum / totals(prev).count : 0, p95: quantile(totals(prev).hist, 0.95) },
        lastCall: last[0]?.time ?? null,
        series: series(rows, r).points,
        step: stepFor(r.from, r.to),
        distribution: { edges, counts: rebin(t.hist, edges), p50: quantile(t.hist, 0.5), p95: quantile(t.hist, 0.95), p99: quantile(t.hist, 0.99), total: total(t.hist) },
        week: cells.map((c, i) => ({ day: Math.floor(i / 12), slot: i % 12, count: c.count, p95: c.count ? quantile(c.hist, 0.95) : null })),
        calls,
      };
    },

    /** A trace: its requests (a trace can cross services), spans and logs, and how its operation usually does. */
    async trace({ traceId }: { traceId: string }) {
      const [requests, spans, logs] = await Promise.all([
        db.query<Record<string, any>>(`SELECT * FROM ${T.requests} WHERE "trace_id" = ? ORDER BY "time"`, [traceId]),
        db.query<Record<string, any>>(`SELECT * FROM ${T.spans} WHERE "trace_id" = ? ORDER BY "time" LIMIT 5000`, [traceId]),
        db.query<Record<string, any>>(`SELECT * FROM ${T.logs} WHERE "trace_id" = ? ORDER BY "time" LIMIT 1000`, [traceId]),
      ]);
      const root = requests[0];
      let typical = null;
      if (root) {
        const hour: Range = { from: Number(root.time) - 3600_000, to: Number(root.time) + 60_000, service: root.service };
        const t = totals(await rollupRows(hour, ` AND "kind" = ? AND "operation" = ?`, [root.kind, root.operation]));
        typical = { count: t.count, avg: t.count ? t.sum / t.count : 0, p50: quantile(t.hist, 0.5), p95: quantile(t.hist, 0.95) };
      }
      const groups = await errorGroups(requests.map((q) => q.error_group).filter(Boolean));
      return { requests: requests.map((q) => ({ ...q, error: q.error_group ? (groups.get(q.error_group) ?? null) : null })), spans, logs, typical };
    },

    async errors(r: Range & { search?: string; state?: string; by?: "issue" | "message" }) {
      const rows = (await rollupRows(r, ` AND "kind" <> '*'`)).filter((x) => !JOB_KINDS.has(x.kind));
      const prev = await rollupRows(previous(r), ` AND "kind" = '*'`);
      const t = totals(rows);
      const pt = totals(prev);
      const s = svc(r.service);
      const step = stepFor(r.from, r.to);
      let list: Record<string, any>[];
      if (r.by === "message") {
        list = (
          await db.query<Record<string, any>>(
            `SELECT "error_message" AS "message", "status", MIN("error_group") AS "group", SUM("weight") AS "n", COUNT(DISTINCT "user_id") AS "users", SUM(CASE WHEN "user_id" IS NULL THEN "weight" ELSE 0 END) AS "anonymous", MAX("time") AS "last" FROM ${T.requests} WHERE "error_message" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql} GROUP BY "error_message", "status" ORDER BY MAX("time") DESC LIMIT 500`,
            [r.from, r.to, ...s.params],
          )
        ).map((e) => ({ ...e, fingerprint: e.group }));
      } else {
        const counts = await db.query<Record<string, any>>(
          `SELECT "error_group" AS "group", SUM("weight") AS "n", COUNT(DISTINCT "user_id") AS "users", SUM(CASE WHEN "user_id" IS NULL THEN "weight" ELSE 0 END) AS "anonymous", MAX("time") AS "last" FROM ${T.requests} WHERE "error_group" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql} GROUP BY "error_group"`,
          [r.from, r.to, ...s.params],
        );
        const groups = await errorGroups(counts.map((c) => c.group));
        list = counts
          .map((c): Record<string, any> => ({ ...groups.get(c.group), ...c, fingerprint: c.group }))
          .filter((e) => (r.state ? e.state === r.state : e.state !== "ignored"))
          .sort((a, b) => Number(b.last) - Number(a.last));
      }
      const q = r.search?.toLowerCase().trim();
      if (q) list = list.filter((e) => `${e.type ?? ""} ${e.message ?? ""} ${e.operation ?? ""}`.toLowerCase().includes(q));
      return {
        total: t.errors + t.clientErrors,
        unhandled: t.errors,
        handled: t.clientErrors,
        count: t.count,
        rate: t.count ? (t.errors + t.clientErrors) / t.count : 0,
        previousRate: pt.count ? (pt.errors + pt.clientErrors) / pt.count : 0,
        step,
        series: series(rows, r, step).points.map((p) => ({ t: p.t, unhandled: p.errors, handled: p.clientErrors, count: p.count })),
        list: list.map((e) => ({
          fingerprint: e.fingerprint,
          type: e.type ?? null,
          message: e.message,
          status: Number(e.status ?? 0),
          handled: e.handled === undefined ? null : Boolean(Number(e.handled)),
          operation: e.operation ?? null,
          state: e.state ?? null,
          count: Number(e.n),
          users: Number(e.users),
          anonymous: Number(e.anonymous ?? 0),
          last: Number(e.last),
          firstSeen: e.first_seen ? Number(e.first_seen) : null,
        })),
      };
    },

    async error(r: Range & { fingerprint: string; before?: number }) {
      const [group] = await db.query<Record<string, any>>(`SELECT * FROM ${T.errors} WHERE "fingerprint" = ?`, [r.fingerprint]);
      if (!group) return null;
      const s = svc(r.service);
      const occurrences = await db.query<Record<string, any>>(
        `SELECT "trace_id", "time", "operation", "kind", "method", "status", "user_id", "user_name", "error_message", "release", "instance", "weight", "duration" FROM ${T.requests} WHERE "error_group" = ? AND "time" >= ? AND "time" < ?${s.sql} ORDER BY "time" DESC LIMIT 200`,
        [r.fingerprint, r.from, Math.min(r.to, r.before ?? r.to), ...s.params],
      );
      const users = await db.query<Record<string, any>>(
        `SELECT "user_id", MAX("user_name") AS "user_name", SUM("weight") AS "n", MIN("time") AS "first", MAX("time") AS "last" FROM ${T.requests} WHERE "error_group" = ? AND "user_id" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql} GROUP BY "user_id" ORDER BY MAX("time") DESC LIMIT 100`,
        [r.fingerprint, r.from, r.to, ...s.params],
      );
      const step = stepFor(r.from, r.to);
      const at = starts(r.from, r.to, step);
      const counts = at.map(() => 0);
      const all = await db.query<{ time: number; weight: number }>(`SELECT "time", "weight" FROM ${T.requests} WHERE "error_group" = ? AND "time" >= ? AND "time" < ?${s.sql}`, [r.fingerprint, r.from, r.to, ...s.params]);
      for (const o of all) {
        const i = Math.floor((Number(o.time) - at[0]!) / step);
        if (i >= 0 && i < counts.length) counts[i]! += Number(o.weight);
      }
      const latest = occurrences[0] ? await db.query<Record<string, any>>(`SELECT * FROM ${T.spans} WHERE "trace_id" = ? AND "status" = 2 ORDER BY "time" LIMIT 20`, [occurrences[0].trace_id]) : [];
      return {
        group: { ...group, count: Number(group.count), handled: Boolean(Number(group.handled)), first_seen: Number(group.first_seen), last_seen: Number(group.last_seen) },
        count: all.reduce((n, o) => n + Number(o.weight), 0),
        users,
        anonymous: all.length ? occurrences.filter((o) => !o.user_id).length : 0,
        step,
        series: at.map((t, i) => ({ t, count: counts[i] })),
        occurrences,
        failedSpans: latest,
      };
    },

    async setErrorState({ fingerprint, state }: { fingerprint: string; state: string }) {
      if (!["open", "resolved", "ignored"].includes(state)) throw new Error(`state must be open, resolved or ignored`);
      await db.execute(`UPDATE ${T.errors} SET "state" = ? WHERE "fingerprint" = ?`, [state, fingerprint]);
      return true;
    },

    async users(r: Range & { search?: string }) {
      const s = svc(r.service);
      const rows = await db.query<{ user_id: string; user_name: string | null; duration: number; weight: number; status: number; time: number }>(
        `SELECT "user_id", "user_name", "duration", "weight", "status", "time" FROM ${T.requests} WHERE "user_id" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql} AND "kind" NOT IN ('job', 'cron', 'live') ORDER BY "time" LIMIT 200000`,
        [r.from, r.to, ...s.params],
      );
      const users = new Map<string, { id: string; name: string | null; count: number; errors: number; sum: number; hist: Histogram; last: number }>();
      for (const row of rows) {
        const u = users.get(row.user_id) ?? users.set(row.user_id, { id: row.user_id, name: row.user_name, count: 0, errors: 0, sum: 0, hist: {}, last: 0 }).get(row.user_id)!;
        const w = Number(row.weight);
        u.count += w;
        if (Number(row.status) >= 400) u.errors += w;
        u.sum += Number(row.duration) * w;
        recordHist(u.hist, Number(row.duration), w);
        u.last = Math.max(u.last, Number(row.time));
        if (row.user_name) u.name = row.user_name;
      }
      const prev = await db.query<{ n: number }>(`SELECT COUNT(DISTINCT "user_id") AS "n" FROM ${T.requests} WHERE "user_id" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql}`, [
        r.from - (r.to - r.from),
        r.from,
        ...s.params,
      ]);
      const step = stepFor(r.from, r.to);
      const at = starts(r.from, r.to, step);
      const active = at.map(() => new Set<string>());
      for (const row of rows) {
        const i = Math.floor((Number(row.time) - at[0]!) / step);
        if (i >= 0 && i < active.length) active[i]!.add(row.user_id);
      }
      const q = r.search?.toLowerCase().trim();
      const list = [...users.values()]
        .filter((u) => !q || `${u.id} ${u.name ?? ""}`.toLowerCase().includes(q))
        .map((u) => ({ id: u.id, name: u.name, count: u.count, errors: u.errors, failureRate: u.count ? u.errors / u.count : 0, avg: u.count ? u.sum / u.count : 0, p95: quantile(u.hist, 0.95), last: u.last }))
        .sort((a, b) => b.count - a.count);
      const domains = new Map<string, { domain: string; users: number; count: number; errors: number }>();
      for (const u of list) {
        const domain = u.name?.includes("@") ? u.name.split("@")[1]!.toLowerCase() : null;
        if (!domain) continue;
        const d = domains.get(domain) ?? domains.set(domain, { domain, users: 0, count: 0, errors: 0 }).get(domain)!;
        d.users++;
        d.count += u.count;
        d.errors += u.errors;
      }
      return { total: list.length, previous: Number(prev[0]?.n ?? 0), step, series: at.map((t, i) => ({ t, count: active[i]!.size })), list, domains: [...domains.values()].sort((a, b) => b.count - a.count) };
    },

    async user(r: Range & { userId: string }) {
      const s = svc(r.service);
      const calls = await db.query<Record<string, any>>(
        `SELECT "trace_id", "time", "duration", "kind", "operation", "method", "status", "error_message", "error_group", "weight", "user_name", "cache" FROM ${T.requests} WHERE "user_id" = ? AND "time" >= ? AND "time" < ?${s.sql} ORDER BY "time" DESC LIMIT 1000`,
        [r.userId, r.from, r.to, ...s.params],
      );
      const h: Histogram = {};
      let count = 0;
      let errors = 0;
      let sum = 0;
      for (const c of calls) {
        const w = Number(c.weight);
        count += w;
        if (Number(c.status) >= 400) errors += w;
        sum += Number(c.duration) * w;
        recordHist(h, Number(c.duration), w);
      }
      const errs = await db.query<Record<string, any>>(
        `SELECT "error_group" AS "group", SUM("weight") AS "n", MAX("time") AS "last" FROM ${T.requests} WHERE "user_id" = ? AND "error_group" IS NOT NULL AND "time" >= ? AND "time" < ?${s.sql} GROUP BY "error_group"`,
        [r.userId, r.from, r.to, ...s.params],
      );
      const groups = await errorGroups(errs.map((e) => e.group));
      return {
        userId: r.userId,
        name: calls.find((c) => c.user_name)?.user_name ?? null,
        count,
        errors,
        failureRate: count ? errors / count : 0,
        avg: count ? sum / count : 0,
        p95: quantile(h, 0.95),
        lastSeen: calls[0] ? Number(calls[0].time) : null,
        calls,
        errorGroups: errs.map((e) => ({ fingerprint: e.group, count: Number(e.n), last: Number(e.last), type: groups.get(e.group)?.type, message: groups.get(e.group)?.message })),
      };
    },

    async spans(r: Range & { type?: string; search?: string }) {
      const rows = (await spanRows(r)).filter((x) => !r.type || x.type === r.type);
      const groups = new Map<string, { type: string; name: string; namespace: string; agg: Agg; self: number }>();
      for (const row of rows) {
        const k = `${row.type}\u0000${row.name}`;
        const g = groups.get(k) ?? groups.set(k, { type: row.type, name: row.name, namespace: row.namespace, agg: empty(), self: 0 }).get(k)!;
        add(g.agg, { ...row, client_errors: 0, cached: 0 } as unknown as RollupRow);
        g.self += Number(row.self);
      }
      const step = stepFor(r.from, r.to);
      const at = starts(r.from, r.to, step);
      const types = [...new Set(rows.map((x) => x.type))].sort();
      const perType = types.map((type) => ({ type, counts: at.map(() => 0) }));
      for (const row of rows) {
        const i = Math.floor((Number(row.minute) * 60_000 - at[0]!) / step);
        if (i >= 0 && i < at.length) perType.find((p) => p.type === row.type)!.counts[i]! += Number(row.count);
      }
      const prev = await spanRows(previous(r));
      const q = r.search?.toLowerCase().trim();
      return {
        total: rows.reduce((n, x) => n + Number(x.count), 0),
        previous: prev.filter((x) => !r.type || x.type === r.type).reduce((n, x) => n + Number(x.count), 0),
        step,
        series: at.map((t, i) => ({ t, ...Object.fromEntries(perType.map((p) => [p.type, p.counts[i]])) })),
        types,
        list: [...groups.values()]
          .filter((g) => !q || g.name.toLowerCase().includes(q))
          .map((g) => ({ type: g.type, name: g.name, namespace: g.namespace, count: g.agg.count, errors: g.agg.errors, failureRate: g.agg.count ? g.agg.errors / g.agg.count : 0, avg: g.agg.count ? g.agg.sum / g.agg.count : 0, p95: quantile(g.agg.hist, 0.95), max: g.agg.max, self: g.self, total: g.agg.sum }))
          .sort((a, b) => b.count - a.count),
      };
    },

    async span(r: Range & { type: string; name: string; outcome?: "ok" | "error"; before?: number }) {
      const rows = await spanRows(r, ` AND "type" = ? AND "name" = ?`, [r.type, r.name]);
      const agg = rows.reduce((a, row) => add(a, { ...row, client_errors: 0, cached: 0 } as unknown as RollupRow), empty());
      const step = stepFor(r.from, r.to);
      const at = starts(r.from, r.to, step);
      const points = at.map(() => empty());
      for (const row of rows) {
        const i = Math.floor((Number(row.minute) * 60_000 - at[0]!) / step);
        if (i >= 0 && i < at.length) add(points[i]!, { ...row, client_errors: 0, cached: 0 } as unknown as RollupRow);
      }
      const s = svc(r.service, `s."service"`);
      const outcome = r.outcome === "error" ? ` AND s."status" = 2` : r.outcome === "ok" ? ` AND (s."status" IS NULL OR s."status" <> 2)` : "";
      const found = await db.query<Record<string, any>>(
        `SELECT s."trace_id", s."span_id", s."time", s."duration", s."self", s."status", s."error", s."attrs" FROM ${T.spans} s WHERE s."type" = ? AND s."name" = ? AND s."time" >= ? AND s."time" < ?${s.sql}${outcome} ORDER BY s."time" DESC LIMIT 50`,
        [r.type, r.name, r.from, Math.min(r.to, r.before ?? r.to), ...s.params],
      );
      // Each invocation's place in its request: the trace's first request is where the offset counts from.
      const ids = [...new Set(found.map((f) => f.trace_id as string))];
      const roots = new Map<string, Record<string, any>>();
      if (ids.length)
        for (const q of await db.query<Record<string, any>>(`SELECT "trace_id", "time", "operation", "kind" FROM ${T.requests} WHERE "trace_id" IN (${ids.map(() => "?").join(", ")}) ORDER BY "time" DESC`, ids))
          roots.set(q.trace_id, q);
      const invocations = found.map((f) => ({ ...f, root_time: roots.get(f.trace_id)?.time ?? null, operation: roots.get(f.trace_id)?.operation ?? null, kind: roots.get(f.trace_id)?.kind ?? null }));
      return {
        type: r.type,
        name: r.name,
        namespace: rows[0]?.namespace ?? null,
        ...stats(agg),
        self: rows.reduce((n, x) => n + Number(x.self), 0),
        step,
        series: at.map((t, i) => ({ t, count: points[i]!.count, errors: points[i]!.errors, avg: points[i]!.count ? points[i]!.sum / points[i]!.count : null, p95: points[i]!.count ? quantile(points[i]!.hist, 0.95) : null })),
        invocations,
      };
    },

    /** Where the time goes: time spent in each module's, class's or dependency's own code, children subtracted. */
    async hotspots(r: Range) {
      const rows = await spanRows(r);
      const groups = new Map<string, { namespace: string; type: string; self: number; total: number; count: number; errors: number; methods: Map<string, { name: string; self: number; total: number; count: number; errors: number }> }>();
      for (const row of rows) {
        const k = `${row.type}\u0000${row.namespace}`;
        const g = groups.get(k) ?? groups.set(k, { namespace: row.namespace, type: row.type, self: 0, total: 0, count: 0, errors: 0, methods: new Map() }).get(k)!;
        g.self += Number(row.self);
        g.total += Number(row.sum);
        g.count += Number(row.count);
        g.errors += Number(row.errors);
        const m = g.methods.get(row.name) ?? g.methods.set(row.name, { name: row.name, self: 0, total: 0, count: 0, errors: 0 }).get(row.name)!;
        m.self += Number(row.self);
        m.total += Number(row.sum);
        m.count += Number(row.count);
        m.errors += Number(row.errors);
      }
      const all = [...groups.values()].reduce((n, g) => n + g.self, 0);
      return {
        total: all,
        list: [...groups.values()]
          .map((g) => ({ namespace: g.namespace, type: g.type, self: g.self, share: all ? g.self / all : 0, avgSelf: g.count ? g.self / g.count : 0, total: g.total, count: g.count, errors: g.errors, methods: [...g.methods.values()].sort((a, b) => b.self - a.self) }))
          .sort((a, b) => b.self - a.self),
      };
    },

    /** The service map: who calls whom, from rollups (requests into each service) and spans (what each one calls). */
    async map(r: Range) {
      const rows = await rollupRows({ ...r, service: undefined }, ` AND "kind" <> '*'`);
      const services = new Map<string, { service: string; requests: Agg; jobs: Agg }>();
      for (const row of rows) {
        const s = services.get(row.service) ?? services.set(row.service, { service: row.service, requests: empty(), jobs: empty() }).get(row.service)!;
        add(JOB_KINDS.has(row.kind) ? s.jobs : s.requests, row);
      }
      const spans = await spanRows({ ...r, service: undefined }, ` AND "type" IN ('db', 'http', 'queue')`);
      const deps = new Map<string, { from: string; to: string; type: string; label: string; agg: Agg }>();
      for (const row of spans) {
        const label = row.type === "db" ? (row.namespace === "postgresql" ? "PostgreSQL" : row.namespace === "sqlite" ? "SQLite" : row.namespace) : row.namespace;
        const k = `${row.service}\u0000${row.type}\u0000${label}`;
        const d = deps.get(k) ?? deps.set(k, { from: row.service, to: `${row.type}:${label}`, type: row.type, label, agg: empty() }).get(k)!;
        add(d.agg, { ...row, client_errors: 0, cached: 0 } as unknown as RollupRow);
      }
      // Calls between services: spans whose parent is another service's (from kept traces, so counts are estimates).
      const cross = await db.query<{ parent: string; child: string; n: number; ms: number; errors: number }>(
        `SELECT p."service" AS "parent", c."service" AS "child", COUNT(*) AS "n", AVG(c."duration") AS "ms", SUM(CASE WHEN c."status" = 2 THEN 1 ELSE 0 END) AS "errors" FROM ${T.spans} c JOIN ${T.spans} p ON p."trace_id" = c."trace_id" AND p."span_id" = c."parent_id" WHERE c."time" >= ? AND c."time" < ? AND c."service" <> p."service" GROUP BY p."service", c."service"`,
        [r.from, r.to],
      );
      const known = new Set(services.keys());
      return {
        services: [...services.values()].map((s) => ({ service: s.service, requests: stats(s.requests), jobs: stats(s.jobs, "job") })),
        dependencies: [...deps.values()]
          // An outbound call to a service that reports here too is drawn as a link between the two, not as an external host.
          .filter((d) => !(d.type === "http" && known.has(d.label)))
          .map((d) => ({ from: d.from, to: d.to, type: d.type, label: d.label, ...stats(d.agg) })),
        links: cross.map((c) => ({ from: c.parent, to: c.child, count: Number(c.n), avg: Number(c.ms), errors: Number(c.errors) })),
      };
    },

    async runtime(r: Range) {
      const s = svc(r.service);
      const rows = await db.query<Record<string, any>>(`SELECT * FROM ${T.samples} WHERE "time" >= ? AND "time" < ?${s.sql} ORDER BY "time"`, [r.from, r.to, ...s.params]);
      const latest = await db.query<Record<string, any>>(
        `SELECT * FROM ${T.samples} s WHERE "time" = (SELECT MAX("time") FROM ${T.samples} WHERE "instance" = s."instance") AND "time" >= ?${s.sql} ORDER BY "instance"`,
        [Date.now() - Math.max(r.to - r.from, 3600_000), ...s.params],
      );
      const step = stepFor(r.from, r.to);
      const at = starts(r.from, r.to, step);
      const instances = [...new Set(rows.map((x) => x.instance as string))].sort();
      const keys = ["cpu", "cpu_user", "cpu_system", "rss", "heap_used", "heap_total", "loop_mean", "loop_p99", "loop_max", "connections", "subscriptions", "inflight", "cache_entries"] as const;
      const sums = ["cache_hits", "cache_misses", "cache_shared"] as const;
      const series = instances.map((instance) => {
        const buckets = at.map(() => ({ n: 0, v: {} as Record<string, number> }));
        for (const row of rows) {
          if (row.instance !== instance) continue;
          const i = Math.floor((Number(row.time) - at[0]!) / step);
          if (i < 0 || i >= at.length) continue;
          const b = buckets[i]!;
          b.n++;
          for (const k of keys) if (row[k] !== null) b.v[k] = k === "loop_max" ? Math.max(b.v[k] ?? 0, Number(row[k])) : (b.v[k] ?? 0) + Number(row[k]);
          for (const k of sums) if (row[k] !== null) b.v[k] = (b.v[k] ?? 0) + Number(row[k]);
        }
        return {
          instance,
          role: rows.find((x) => x.instance === instance)?.role,
          points: at.map((t, i) => {
            const b = buckets[i]!;
            if (!b.n) return { t };
            return { t, ...Object.fromEntries(keys.map((k) => [k, b.v[k] === undefined ? null : k === "loop_max" ? b.v[k] : b.v[k]! / b.n])), ...Object.fromEntries(sums.map((k) => [k, b.v[k] ?? null])) };
          }),
        };
      });
      return { step, instances: latest.map((x) => ({ ...x, stale: Date.now() - Number(x.time) > 60_000 })), series };
    },

    async metrics(r: Range & { name?: string }) {
      const s = svc(r.service);
      const where = r.name ? ` AND "name" = ?` : "";
      const rows = await db.query<Record<string, any>>(
        `SELECT * FROM ${T.metrics} WHERE "minute" >= ? AND "minute" < ?${s.sql}${where} ORDER BY "minute"`,
        [Math.floor(r.from / 60_000), Math.ceil(r.to / 60_000), ...s.params, ...(r.name ? [r.name] : [])],
      );
      const lifetime = await db.query<{ name: string; total: number; last: number }>(`SELECT "name", SUM("value") AS "total", MAX("minute") AS "last" FROM ${T.metrics} WHERE "type" = 'counter'${s.sql} GROUP BY "name"`, s.params);
      const lifetimeOf = new Map(lifetime.map((l) => [l.name, l]));
      const byName = new Map<string, { name: string; type: string; unit: string | null; value: number; count: number; min: number; max: number; last: number; latest: number | null; total: number | null; series: Map<string, Map<number, number>> }>();
      const step = stepFor(r.from, r.to);
      for (const row of rows) {
        const m =
          byName.get(row.name) ??
          byName.set(row.name, { name: row.name, type: row.type, unit: row.unit, value: 0, count: 0, min: Infinity, max: -Infinity, last: 0, latest: null, total: null, series: new Map() }).get(row.name)!;
        const minute = Number(row.minute);
        if (row.type === "gauge") {
          if (minute >= m.last) m.latest = Number(row.value);
        } else m.value += Number(row.value);
        if (row.total !== null) m.total = Math.max(m.total ?? 0, Number(row.total));
        m.count += Number(row.count);
        m.min = Math.min(m.min, Number(row.min));
        m.max = Math.max(m.max, Number(row.max));
        m.last = Math.max(m.last, minute);
        const bucket = Math.floor((minute * 60_000) / step) * step;
        const per = m.series.get(row.attrs) ?? m.series.set(row.attrs, new Map()).get(row.attrs)!;
        per.set(bucket, row.type === "gauge" ? Number(row.value) : (per.get(bucket) ?? 0) + Number(row.value));
      }
      const at = starts(r.from, r.to, step);
      return {
        step,
        list: [...byName.values()].map((m) => ({
          name: m.name,
          type: m.type,
          unit: m.unit,
          value: m.type === "gauge" ? m.latest : m.value,
          count: m.count,
          min: Number.isFinite(m.min) ? m.min : null,
          max: Number.isFinite(m.max) ? m.max : null,
          lastUpdated: m.last * 60_000,
          lifetime: m.type === "counter" ? (m.total ?? Number(lifetimeOf.get(m.name)?.total ?? 0)) : null,
          series: [...m.series].slice(0, 12).map(([attrs, points]) => ({ attrs, points: at.map((t) => ({ t, value: points.get(t) ?? null })) })),
        })),
      };
    },

    async releases(r: Range) {
      const s = svc(r.service);
      const rows = await db.query<{ service: string; version: string; first_seen: number; last_seen: number }>(`SELECT * FROM ${T.releases} WHERE "last_seen" >= ?${s.sql} ORDER BY "first_seen" DESC LIMIT 30`, [
        r.from,
        ...s.params,
      ]);
      return Promise.all(rows.map(async (row) => ({ ...(await releaseImpact(row.service, row.version, Number(row.first_seen))), lastSeen: Number(row.last_seen) })));
    },

    async services(r: Range) {
      const rows = await rollupRows({ ...r, service: undefined }, ` AND "kind" = '*'`);
      const out = new Map<string, Agg & { last: number }>();
      for (const row of rows) {
        const a = out.get(row.service) ?? out.set(row.service, { ...empty(), last: 0 }).get(row.service)!;
        add(a, row);
        a.last = Math.max(a.last, Number(row.minute) * 60_000);
      }
      const extra = await db.query<{ service: string; last: number }>(`SELECT "service", MAX("time") AS "last" FROM ${T.samples} WHERE "time" >= ? GROUP BY "service"`, [r.from]);
      for (const e of extra) if (!out.has(e.service)) out.set(e.service, { ...empty(), last: Number(e.last) });
      const releases = await db.query<{ service: string; version: string; first_seen: number }>(`SELECT * FROM ${T.releases} ORDER BY "first_seen" DESC`);
      const described = new Map((await db.query<{ service: string; attrs: string | null; first_seen: number; last_seen: number }>(`SELECT * FROM ${T.services}`)).map((s) => [s.service, s]));
      for (const [service, s] of described) if (!out.has(service) && Number(s.last_seen) >= r.from) out.set(service, { ...empty(), last: Number(s.last_seen) });
      const step = stepFor(r.from, r.to, 30);
      return [...out].map(([service, a]) => ({
        attrs: described.get(service)?.attrs ? JSON.parse(described.get(service)!.attrs!) : {},
        firstSeen: described.get(service) ? Number(described.get(service)!.first_seen) : null,
        service,
        ...stats(a),
        last: a.last,
        release: releases.find((x) => x.service === service)?.version ?? null,
        activity: series(
          rows.filter((x) => x.service === service),
          r,
          step,
        ).points.map((p) => p.count),
      }));
    },

    async logs(r: Range & { level?: string; search?: string; traceId?: string; name?: string; before?: number; limit?: number }) {
      const conds = [`"time" >= ?`, `"time" < ?`];
      const params: unknown[] = [r.from, Math.min(r.to, r.before ?? r.to)];
      if (r.service) conds.push(`"service" = ?`), params.push(r.service);
      if (r.level) conds.push(`"level" IN (${r.level.split(",").map(() => "?").join(", ")})`), params.push(...r.level.split(","));
      if (r.traceId) conds.push(`"trace_id" = ?`), params.push(r.traceId);
      if (r.name) conds.push(`"name" = ?`), params.push(r.name);
      if (r.search) conds.push(`LOWER("message") LIKE ?`), params.push(`%${r.search.toLowerCase().replace(/[%_]/g, "")}%`);
      const limit = Math.min(Number(r.limit) || 200, 1000);
      return db.query(`SELECT * FROM ${T.logs} WHERE ${conds.join(" AND ")} ORDER BY "time" DESC LIMIT ${limit}`, params);
    },

    /** The dashboard's command palette: operations, error groups, users and a trace id that match. */
    async search({ q }: { q: string }) {
      const term = `%${q.toLowerCase().replace(/[%_]/g, "")}%`;
      const day = Date.now() - 7 * 86_400_000;
      const [ops, errs, users, traces] = await Promise.all([
        db.query<{ kind: string; operation: string }>(`SELECT DISTINCT "kind", "operation" FROM ${T.rollups} WHERE "minute" >= ? AND "kind" <> '*' AND LOWER("operation") LIKE ? LIMIT 10`, [Math.floor(day / 60_000), term]),
        db.query<{ fingerprint: string; type: string; message: string }>(`SELECT "fingerprint", "type", "message" FROM ${T.errors} WHERE LOWER("message") LIKE ? OR LOWER("type") LIKE ? ORDER BY "last_seen" DESC LIMIT 6`, [term, term]),
        db.query<{ user_id: string; user_name: string | null }>(`SELECT "user_id", MAX("user_name") AS "user_name" FROM ${T.requests} WHERE "time" >= ? AND (LOWER("user_id") LIKE ? OR LOWER("user_name") LIKE ?) GROUP BY "user_id" LIMIT 6`, [day, term, term]),
        // A trace id, or the request id a caller saw in an error ("Server error (request …)").
        /^[\w.-]{1,64}$/.test(q.trim()) ? db.query<{ trace_id: string; operation: string }>(`SELECT "trace_id", "operation" FROM ${T.requests} WHERE "trace_id" = ? OR "request_id" = ? LIMIT 1`, [q.trim(), q.trim()]) : Promise.resolve([]),
      ]);
      return { operations: ops, errors: errs, users, traces };
    },
  };
}

export type Queries = ReturnType<typeof buildQueries>;
