import { useState } from "react";
import type { Admin } from "../api";
import { Legend, RangeBar, RateBar, TimeChart } from "../charts";
import { count, ms, pct } from "../format";
import { Card, Delta, Headline, OpName, opHref, Refreshing, SearchBox, TelemetryOff, usePages, useSort } from "../kit";
import { useObs, useTelemetryOn, type Operation, type Point, type Stats } from "../obs";
import { Empty, ErrorNote, Segmented, Skeleton } from "../ui";
import { Requests } from "./Requests";
import { Scheduled } from "./Scheduled";

type JobOp = Operation & { queue: string; waitAvg: number | null; waitP95: number | null };
type JobsData = Stats & { previous: number; step: number; series: Point[]; wait: { avg: number | null; p95: number | null; series: { t: number; p95: number | null; p50: number | null }[] }; operations: JobOp[] };

const RUNS = [
  { key: "ok", label: "completed", color: "var(--viz-quiet)" },
  { key: "failed", label: "failed", color: "var(--bad)" },
];

export function Jobs({ params, admin }: { params: URLSearchParams; admin: Admin }) {
  const telemetry = useTelemetryOn();
  const [tab, setTab] = useState<"runs" | "queue">(params.get("tab") === "queue" || !telemetry ? "queue" : "runs");
  if (params.get("op")) return telemetry ? <Requests params={params} /> : <TelemetryOff />;
  return (
    <div className="obs-page">
      <div className="toolbar-row">
        <Segmented
          label="View"
          value={tab}
          onChange={setTab}
          options={[
            { value: "runs", label: "Runs" },
            { value: "queue", label: "Queue & crons" },
          ]}
        />
      </div>
      {tab === "queue" ? <Scheduled admin={admin} /> : telemetry ? <JobRuns /> : <TelemetryOff />}
    </div>
  );
}

function JobRuns() {
  const j = useObs<JobsData>("jobs");
  const [search, setSearch] = useState("");
  const { th, apply } = useSort<"operation" | "p95" | "failure" | "count" | "wait">("count");
  if (j.loading && !j.data) return <Skeleton rows={8} />;
  if (!j.data) return <ErrorNote error={j.error} />;
  const d = j.data;
  const failed = d.errors + d.clientErrors;
  const q = search.trim().toLowerCase();
  const rows = apply(
    d.operations.filter((o) => !q || o.operation.toLowerCase().includes(q)),
    (o, k) => (k === "operation" ? o.operation : k === "failure" ? (o.errors + o.clientErrors) / Math.max(1, o.count) : k === "wait" ? (o.waitAvg ?? 0) : o[k]),
  );
  const maxP95 = Math.max(1, ...rows.map((o) => o.p95));
  const points = d.series.map((p) => ({ t: p.t, ok: p.ok, failed: p.errors + p.clientErrors, avg: p.avg, p95: p.p95 }));
  return (
    <>
      <ErrorNote error={j.error} />
      <div className="grid-3">
        <Card title={<>Runs <Refreshing on={j.refreshing} /></>} extra={<Legend items={[{ label: "completed", color: "var(--viz-quiet)", value: count(d.count - failed) }, { label: "failed", color: "var(--bad)", value: count(failed) }]} />}>
          <Headline value={d.count} sub={<><span>{pct(d.count ? failed / d.count : 0)} failed</span><Delta now={d.count} before={d.previous} upIsGood /></>} />
          <TimeChart points={points} step={d.step} height={130} marks={[{ kind: "bars", stack: RUNS }]} emptyLabel="No jobs ran in this range" />
        </Card>
        <Card title="Duration" extra={<Legend items={[{ label: "avg", color: "var(--viz-1)", kind: "line" }, { label: "p95", color: "var(--viz-1)", kind: "dashed" }]} />}>
          <Headline value={d.avg} format={(v) => ms(v)} sub={<span>p95 {ms(d.p95)}</span>} />
          <TimeChart
            points={points}
            step={d.step}
            height={130}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "avg", label: "avg", color: "var(--viz-1)", area: true },
              { kind: "line", key: "p95", label: "p95", color: "var(--viz-1)", dashed: true },
            ]}
          />
        </Card>
        <Card title="Queue wait" extra={<Legend items={[{ label: "median", color: "var(--viz-2)", kind: "line" }, { label: "p95", color: "var(--viz-2)", kind: "dashed" }]} />}>
          <Headline value={d.wait.avg ?? 0} format={(v) => (d.wait.avg === null ? "—" : ms(v))} sub={<span>p95 {ms(d.wait.p95)} · from due to started</span>} />
          <TimeChart
            points={d.wait.series}
            step={d.step}
            height={130}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "p50", label: "median", color: "var(--viz-2)" },
              { kind: "line", key: "p95", label: "p95", color: "var(--viz-2)", dashed: true },
            ]}
          />
        </Card>
      </div>
      <div className="toolbar-row">
        <span className="push" />
        <SearchBox value={search} onChange={setSearch} placeholder="Find a job…" />
      </div>
      <Card className="flush">
        <JobTable rows={rows} th={th} maxP95={maxP95} />
      </Card>
    </>
  );
}

function JobTable({ rows, th, maxP95 }: { rows: JobOp[]; th: ReturnType<typeof useSort<any>>["th"]; maxP95: number }) {
  const { rows: page, pager } = usePages(rows, 20);
  if (!rows.length) return <Empty icon="jobs">No jobs in this range. Functions scheduled with ctx.scheduler, crons in forge/crons.ts, and consumers that report over OTLP show up here.</Empty>;
  return (
    <>
      <table className="obs-table">
        <thead>
          <tr>
            {th("operation", "Job")}
            {th("p95", "Duration")}
            {th("wait", "Queue wait", "num")}
            {th("failure", "Failure rate")}
            {th("count", "Runs", "num")}
          </tr>
        </thead>
        <tbody>
          {page.map((o) => (
            <tr key={o.kind + o.operation} className="clickable" onClick={() => (location.hash = opHref(o.kind, o.operation))}>
              <td>
                <a className="op-link" href={opHref(o.kind, o.operation)} onClick={(e) => e.stopPropagation()}>
                  <OpName operation={o.operation} kind={o.kind} />
                </a>
                <div className="faint mono small">{o.queue}</div>
              </td>
              <td>
                <RangeBar avg={o.avg} p95={o.p95} max={maxP95} />
              </td>
              <td className="num mono">{o.waitAvg === null ? "—" : `${ms(o.waitAvg)} avg`}</td>
              <td>
                <RateBar rate={(o.errors + o.clientErrors) / Math.max(1, o.count)} />
              </td>
              <td className="num mono">{count(o.count)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {pager}
    </>
  );
}
