import { useState } from "react";
import { Distribution, Heatmap, Legend, RangeBar, RateBar, TimeChart } from "../charts";
import { ago, count, fullTime, ms, pct, perMinute } from "../format";
import { BackLink, Card, Chips, Delta, Facts, Headline, KindTag, OpName, opHref, Refreshing, SearchBox, StatusTag, TraceLink, userHref, usePages, useSort } from "../kit";
import { useObs, useRange, type Operation, type Point, type RequestRow, type Stats } from "../obs";
import { href, navigate } from "../router";
import { Empty, ErrorNote, Segmented, Skeleton } from "../ui";
import { STATUS_STACK } from "./Overview";

type RequestsData = Stats & { previous: { count: number; avg: number; p95: number }; series: Point[]; step: number; operations: Operation[] };

const KINDS = ["query", "mutation", "action", "live", "http", "rpc", "ws", "auth", "page", "server"];

export function Requests({ params }: { params: URLSearchParams }) {
  const op = params.get("op");
  if (op) return <OperationView kind={params.get("kind") ?? "query"} operation={op} />;
  return <RequestList initialKind={params.get("kind") ?? ""} />;
}

function RequestList({ initialKind }: { initialKind: string }) {
  const [kind, setKind] = useState(initialKind);
  const [search, setSearch] = useState("");
  const r = useObs<RequestsData>("requests");
  const range = useRange();
  const { th, apply } = useSort<"operation" | "kind" | "avg" | "p95" | "failure" | "apdex" | "impact" | "count">("count");
  if (r.loading && !r.data) return <Skeleton rows={8} />;
  if (!r.data) return <ErrorNote error={r.error} />;
  const d = r.data;
  const width = range.resolve().to - range.resolve().from;
  const present = KINDS.filter((k) => d.operations.some((o) => o.kind === k));
  const q = search.trim().toLowerCase();
  const rows = apply(
    d.operations.filter((o) => (!kind || o.kind === kind) && (!q || o.operation.toLowerCase().includes(q))),
    (o, key) => (key === "operation" ? o.operation : key === "kind" ? o.kind : key === "failure" ? (o.errors + o.clientErrors) / Math.max(1, o.count) : key === "apdex" ? (o.apdex ?? 1) : (o[key] as number)),
  );
  const maxP95 = Math.max(1, ...rows.map((o) => o.p95));
  return (
    <div className="obs-page">
      <ErrorNote error={r.error} />
      <div className="grid-2">
        <Card title={<>Requests <span className="badge">{count(d.count)}</span> <Refreshing on={r.refreshing} /></>} extra={<Legend items={STATUS_STACK.map((s) => ({ label: s.label, color: s.color }))} />}>
          <Headline value={d.count} sub={<><span>{perMinute(d.count, width).toFixed(1)}/min</span><Delta now={d.count} before={d.previous.count} upIsGood /></>} />
          <TimeChart points={d.series} step={d.step} marks={[{ kind: "bars", stack: STATUS_STACK }]} />
        </Card>
        <Card title="Duration" extra={<Legend items={[{ label: "avg", color: "var(--viz-1)", kind: "line", value: ms(d.avg) }, { label: "p95", color: "var(--viz-1)", kind: "dashed", value: ms(d.p95) }]} />}>
          <Headline value={d.avg} format={(v) => ms(v)} sub={<><span>p95 {ms(d.p95)}</span><Delta now={d.p95} before={d.previous.p95} label="p95 vs previous period" /></>} />
          <TimeChart
            points={d.series}
            step={d.step}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "avg", label: "avg", color: "var(--viz-1)", area: true },
              { kind: "line", key: "p95", label: "p95", color: "var(--viz-1)", dashed: true },
            ]}
          />
        </Card>
      </div>
      <div className="toolbar-row">
        <Chips label="Kind" value={kind} onChange={setKind} options={[{ value: "", label: "All", count: d.operations.length }, ...present.map((k) => ({ value: k, label: k, count: d.operations.filter((o) => o.kind === k).length }))]} />
        <span className="push" />
        <SearchBox value={search} onChange={setSearch} placeholder="Find an operation…" />
      </div>
      <Card className="flush">
        <OperationTable rows={rows} th={th} maxP95={maxP95} />
      </Card>
    </div>
  );
}

function OperationTable({ rows, th, maxP95 }: { rows: Operation[]; th: ReturnType<typeof useSort<any>>["th"]; maxP95: number }) {
  const { rows: page, pager } = usePages(rows, 20);
  if (!rows.length) return <Empty icon="requests">No requests in this range. Calls to functions, HTTP routes, auth and pages show up here.</Empty>;
  return (
    <>
      <div className="table-scroll">
        <table className="obs-table">
          <thead>
            <tr>
              {th("operation", "Operation")}
              {th("p95", "Duration")}
              {th("failure", "Failure rate")}
              {th("apdex", "Apdex", "num")}
              {th("impact", "Impact")}
              {th("count", "Count", "num")}
            </tr>
          </thead>
          <tbody>
            {page.map((o) => (
              <tr key={`${o.kind}${o.operation}`} className="clickable" tabIndex={0} onClick={() => (location.hash = opHref(o.kind, o.operation))} onKeyDown={(e) => e.key === "Enter" && (location.hash = opHref(o.kind, o.operation))}>
                <td>
                  <a className="op-link" href={opHref(o.kind, o.operation)} onClick={(e) => e.stopPropagation()}>
                    <OpName operation={o.operation} kind={o.kind} />
                  </a>
                </td>
                <td>
                  <RangeBar avg={o.avg} p95={o.p95} max={maxP95} budget={o.threshold * 4} />
                </td>
                <td>
                  <RateBar rate={(o.errors + o.clientErrors) / Math.max(1, o.count)} />
                </td>
                <td className="num mono">{o.apdex === null ? "—" : o.apdex.toFixed(2)}</td>
                <td title={o.reason}>
                  <span className={`impact ${o.impact >= 0.5 ? "bad" : o.impact >= 0.25 ? "warn" : "ok"}`}>
                    <i style={{ width: `${Math.max(4, o.impact * 100)}%` }} />
                  </span>
                  <span className="impact-reason">{o.reason}</span>
                </td>
                <td className="num mono">{count(o.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

type OperationData = Operation & {
  previous: { count: number; avg: number; p95: number };
  lastCall: number | null;
  series: Point[];
  step: number;
  distribution: { edges: number[]; counts: number[]; p50: number; p95: number; p99: number; total: number };
  week: { day: number; slot: number; count: number; p95: number | null }[];
  calls: RequestRow[];
};

/** Two clusters in a latency distribution (a cache, a fast path) with a clear dip between them. */
export function twoSpeeds(edges: number[], counts: number[]) {
  const total = counts.reduce((a, b) => a + b, 0);
  if (total < 30) return null;
  const smooth = counts.map((_, i) => (counts[i - 1] ?? counts[i]!) * 0.25 + counts[i]! * 0.5 + (counts[i + 1] ?? counts[i]!) * 0.25);
  const peaks = smooth.map((v, i) => [v, i] as const).filter(([v, i]) => v > 0 && v >= (smooth[i - 1] ?? 0) && v > (smooth[i + 1] ?? 0) && v / total > 0.05);
  if (peaks.length < 2) return null;
  const [a, b] = [...peaks].sort((x, y) => y[0] - x[0]).slice(0, 2).sort((x, y) => x[1] - y[1]) as [readonly [number, number], readonly [number, number]];
  const valley = Math.min(...smooth.slice(a[1], b[1] + 1));
  if (valley > Math.min(a[0], b[0]) * 0.5 || b[1] - a[1] < 3) return null;
  const cut = smooth.indexOf(valley, a[1]);
  const left = counts.slice(0, cut + 1).reduce((s, c) => s + c, 0);
  const mid = (i: number) => (i ? (edges[i - 1]! + edges[i]!) / 2 : edges[0]! / 2);
  return { fast: mid(a[1]), slow: mid(b[1]), fastShare: left / total, ratio: mid(b[1]) / Math.max(0.001, mid(a[1])) };
}

function OperationView({ kind, operation }: { kind: string; operation: string }) {
  const [before, setBefore] = useState<number | undefined>();
  const [heat, setHeat] = useState<"count" | "p95">("count");
  const o = useObs<OperationData>("operation", { kind, operation, tzOffset: new Date().getTimezoneOffset(), before });
  const range = useRange();
  if (o.loading && !o.data) return <Skeleton rows={8} />;
  if (!o.data) return <ErrorNote error={o.error} />;
  const d = o.data;
  const width = range.resolve().to - range.resolve().from;
  const failure = (d.errors + d.clientErrors) / Math.max(1, d.count);
  const speeds = twoSpeeds(d.distribution.edges, d.distribution.counts);
  const jobs = kind === "job" || kind === "cron" || kind === "consumer";
  return (
    <div className="obs-page">
      <BackLink to={href(jobs ? "jobs" : "requests")}>All {jobs ? "jobs" : "requests"}</BackLink>
      <Card
        title={
          <>
            <OpName operation={operation} kind={kind} /> <Refreshing on={o.refreshing} />
          </>
        }
        extra={<span className={`impact-pill ${d.impact >= 0.5 ? "bad" : d.impact >= 0.25 ? "warn" : "ok"}`}>{d.reason}</span>}
        className="flush"
      >
        <Facts
          items={[
            { label: "Kind", value: <KindTag kind={kind} /> },
            { label: "Count", value: `${count(d.count)} · ${perMinute(d.count, width).toFixed(1)}/min` },
            { label: "Avg duration", value: ms(d.avg) },
            { label: "p95 · p99", value: `${ms(d.p95)} · ${ms(d.p99)}`, tone: d.p95 > d.threshold * 4 ? "bad" : undefined },
            { label: "Errors", value: `${count(d.clientErrors)} (4xx) / ${count(d.errors)} (5xx)`, tone: d.errors ? "bad" : undefined },
            { label: "Failure rate", value: pct(failure), tone: failure >= 0.05 ? "bad" : failure >= 0.01 ? "warn" : undefined },
            { label: "Apdex", value: d.apdex === null ? "—" : `${d.apdex.toFixed(2)} (T ${ms(d.threshold)})` },
            { label: "Last call", value: ago(d.lastCall) },
          ]}
        />
      </Card>
      <div className="grid-2">
        <Card title="Requests" extra={<Legend items={STATUS_STACK.map((s) => ({ label: s.label, color: s.color }))} />}>
          <Headline value={d.count} sub={<Delta now={d.count} before={d.previous.count} upIsGood />} />
          <TimeChart points={d.series} step={d.step} marks={[{ kind: "bars", stack: STATUS_STACK }]} />
        </Card>
        <Card title="Duration" extra={<Legend items={[{ label: "avg", color: "var(--viz-1)", kind: "line" }, { label: "p95", color: "var(--viz-1)", kind: "dashed" }]} />}>
          <Headline value={d.avg} format={(v) => ms(v)} sub={<><span>p95 {ms(d.p95)}</span><Delta now={d.p95} before={d.previous.p95} label="p95 vs previous period" /></>} />
          <TimeChart
            points={d.series}
            step={d.step}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "avg", label: "avg", color: "var(--viz-1)", area: true },
              { kind: "line", key: "p95", label: "p95", color: "var(--viz-1)", dashed: true },
            ]}
          />
        </Card>
      </div>
      <div className="grid-2">
        <Card title={<>Latency distribution <span className="badge">{count(d.distribution.total)} calls</span></>}>
          {d.distribution.total ? (
            <>
              <Distribution edges={d.distribution.edges} counts={d.distribution.counts} marks={[{ label: "p50", value: d.distribution.p50 }, { label: "p95", value: d.distribution.p95 }]} />
              {speeds ? (
                <p className="note-line">
                  <b>Two speeds</b>: {ms(speeds.fast)} ({pct(speeds.fastShare)}) and {ms(speeds.slow)} ({pct(1 - speeds.fastShare)}), {speeds.ratio.toFixed(0)}× apart. A cache, a fast path or a lock is often why.
                </p>
              ) : (
                <p className="note-line">
                  median <b>{ms(d.distribution.p50)}</b> · p95 <b>{ms(d.distribution.p95)}</b> · p99 <b>{ms(d.distribution.p99)}</b>
                </p>
              )}
            </>
          ) : (
            <Empty icon="metrics">No calls in this range.</Empty>
          )}
        </Card>
        <Card title="Weekly rhythm" extra={<Segmented label="Show" value={heat} onChange={setHeat} options={[{ value: "count", label: "Traffic" }, { value: "p95", label: "p95" }]} />}>
          <Heatmap cells={d.week} metric={heat} />
          <WeekSummary week={d.week} />
        </Card>
      </div>
      <Card title={jobs ? "Runs" : "Recent calls"} className="flush" footer={<span>Kept traces: every error and slow call, and a share of the rest when traffic is high. Counts above include every call.</span>}>
        <CallTable calls={d.calls} jobs={jobs} />
        {d.calls.length === 50 && (
          <div className="pager-row">
            <span className="muted small">Showing the latest 50</span>
            <button className="btn ghost" onClick={() => setBefore(Number(d.calls.at(-1)!.time))}>
              Older calls
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}

function WeekSummary({ week }: { week: OperationData["week"] }) {
  const busy = [...week].sort((a, b) => b.count - a.count)[0];
  const slow = [...week].filter((c) => c.p95 !== null).sort((a, b) => b.p95! - a.p95!)[0];
  const days = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
  const slot = (c: { day: number; slot: number }) => `${days[c.day]} ${String(c.slot * 2).padStart(2, "0")}–${String(c.slot * 2 + 2).padStart(2, "0")}`;
  if (!busy?.count) return <p className="note-line">Last 7 days · no traffic yet</p>;
  return (
    <p className="note-line">
      Peak <b>{slot(busy)}</b>
      {slow && (
        <>
          {" "}
          · slowest <b>{slot(slow)}</b> at {ms(slow.p95)}
        </>
      )}
    </p>
  );
}

export function CallTable({ calls, jobs }: { calls: RequestRow[]; jobs?: boolean }) {
  const { rows, pager } = usePages(calls, 15);
  if (!calls.length) return <Empty icon="trace">No kept calls in this range.</Empty>;
  return (
    <>
    <div className="table-scroll">
      <table className="obs-table">
        <thead>
          <tr>
            <th scope="col">Trace</th>
            <th scope="col">Status</th>
            <th scope="col" className="num">
              Duration
            </th>
            {jobs && (
              <th scope="col" className="num">
                Queue wait
              </th>
            )}
            <th scope="col">User</th>
            <th scope="col">Detail</th>
            <th scope="col" className="num">
              When
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c) => (
            <tr key={c.trace_id + c.span_id} className="clickable" onClick={() => navigate("trace", { id: c.trace_id })}>
              <td>
                <TraceLink id={c.trace_id} />
              </td>
              <td>
                <StatusTag status={Number(c.status)} />
              </td>
              <td className="num mono">{ms(Number(c.duration))}</td>
              {jobs && <td className="num mono">{c.queue_wait === null ? "—" : ms(Number(c.queue_wait))}</td>}
              <td>
                {c.user_id ? (
                  <a className="plain-link" href={userHref(c.user_id)} onClick={(e) => e.stopPropagation()}>
                    {c.user_name ?? c.user_id}
                  </a>
                ) : c.cache === "hit" || c.cache === "shared" ? (
                  <span className="faint" title="Answered from the query cache, without looking the caller up">not resolved</span>
                ) : (
                  <span className="faint">anonymous</span>
                )}
              </td>
              <td className="msg">
                {c.error_message ? <span className={Number(c.status) >= 500 ? "bad" : "warn-text"}>{c.error_message}</span> : <span className="faint">{[c.cache && `cache ${c.cache}`, c.method, c.release && `release ${c.release}`, Number(c.weight) > 1 && `sampled ×${Number(c.weight).toFixed(0)}`].filter(Boolean).join(" · ")}</span>}
              </td>
              <td className="num muted small" title={fullTime(Number(c.time))}>
                {ago(Number(c.time))}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    {pager}
    </>
  );
}
