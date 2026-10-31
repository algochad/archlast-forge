import { useState } from "react";
import { Legend, RangeBar, RateBar, Scatter, TimeChart } from "../charts";
import { ago, count, fullTime, ms } from "../format";
import { BackLink, Card, Chips, Delta, Facts, Headline, Refreshing, SearchBox, spanHref, TraceLink, usePages, useSort } from "../kit";
import { attrsOf, useObs, type Stats } from "../obs";
import { href, navigate } from "../router";
import { Empty, ErrorNote, Skeleton } from "../ui";
import { typeColor } from "./Trace";

type SpanItem = { type: string; name: string; namespace: string; count: number; errors: number; failureRate: number; avg: number; p95: number; max: number; self: number; total: number };
type SpansData = { total: number; previous: number; step: number; series: ({ t: number } & Record<string, number>)[]; types: string[]; list: SpanItem[] };

export const TYPE_LABEL: Record<string, string> = { db: "database", http: "outbound HTTP", function: "functions", nest: "Nest classes", custom: "custom", cache: "cache", queue: "queues", job: "jobs" };

export function Spans({ params }: { params: URLSearchParams }) {
  const name = params.get("name");
  if (name) return <SpanDetail type={params.get("type") ?? "custom"} name={name} />;
  return <SpanList />;
}

function SpanList() {
  const [type, setType] = useState("");
  const [search, setSearch] = useState("");
  const s = useObs<SpansData>("spans", { search: search || undefined });
  const { th, apply } = useSort<"name" | "p95" | "failureRate" | "count" | "self">("count");
  if (s.loading && !s.data) return <Skeleton rows={8} />;
  if (!s.data) return <ErrorNote error={s.error} />;
  const d = s.data;
  const list = d.list.filter((x) => !type || x.type === type);
  const rows = apply(list, (r, k) => (k === "name" ? r.name : r[k]));
  const maxP95 = Math.max(1, ...rows.map((r) => r.p95));
  const types = type ? [type] : d.types;
  return (
    <div className="obs-page">
      <ErrorNote error={s.error} />
      <div className="grid-2">
        <Card title={<>Spans <Refreshing on={s.refreshing} /></>} extra={<Legend items={types.map((t) => ({ label: TYPE_LABEL[t] ?? t, color: typeColor(t) }))} />}>
          <Headline value={type ? list.reduce((n, x) => n + x.count, 0) : d.total} sub={!type && <Delta now={d.total} before={d.previous} />} />
          <TimeChart points={d.series} step={d.step} height={150} marks={[{ kind: "bars", stack: types.map((t) => ({ key: t, label: TYPE_LABEL[t] ?? t, color: typeColor(t) })) }]} emptyLabel="No spans in this range" />
        </Card>
        <Card title="Latency by span" extra={<span className="note-line">dot color: failure rate</span>}>
          {list.length ? (
            <Scatter points={list.slice(0, 150).map((x) => ({ id: `${x.type}\u0000${x.name}`, label: x.name, x: x.count, y: x.p95, rate: x.failureRate }))} xLabel="invocations" yLabel="p95" onPick={(id) => navigate("spans", { type: id.split("\u0000")[0], name: id.split("\u0000")[1] })} />
          ) : (
            <Empty icon="spans">No spans yet.</Empty>
          )}
        </Card>
      </div>
      <div className="toolbar-row">
        <Chips label="Type" value={type} onChange={setType} options={[{ value: "", label: "All", count: d.list.length }, ...d.types.map((t) => ({ value: t, label: TYPE_LABEL[t] ?? t, count: d.list.filter((x) => x.type === t).length }))]} />
        <span className="push" />
        <SearchBox value={search} onChange={setSearch} placeholder="Find a span…" />
      </div>
      <Card className="flush" footer={<span>Spans are the steps inside requests: each database statement, outbound call, Nest method, function a function calls, and every <code>trace.span()</code> in your code.</span>}>
        <SpanTable rows={rows} th={th} maxP95={maxP95} />
      </Card>
    </div>
  );
}

function SpanTable({ rows, th, maxP95 }: { rows: SpanItem[]; th: ReturnType<typeof useSort<any>>["th"]; maxP95: number }) {
  const { rows: page, pager } = usePages(rows, 20);
  if (!rows.length) return <Empty icon="spans">No spans in this range.</Empty>;
  return (
    <>
      <div className="table-scroll">
        <table className="obs-table">
          <thead>
            <tr>
              {th("name", "Name")}
              {th("p95", "Duration")}
              {th("failureRate", "Failure rate")}
              {th("self", "Own time", "num")}
              {th("count", "Invocations", "num")}
            </tr>
          </thead>
          <tbody>
            {page.map((r) => (
              <tr key={r.type + r.name} className="clickable" onClick={() => (location.hash = spanHref(r.type, r.name))}>
                <td>
                  <span className="op-name">
                    <span className="wf-type" style={{ "--c": typeColor(r.type) } as React.CSSProperties}>
                      {r.type}
                    </span>
                    <code title={r.name}>{r.name}</code>
                  </span>
                </td>
                <td>
                  <RangeBar avg={r.avg} p95={r.p95} max={maxP95} />
                </td>
                <td>
                  <RateBar rate={r.failureRate} />
                </td>
                <td className="num mono">{ms(r.self)}</td>
                <td className="num mono">{count(r.count)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {pager}
    </>
  );
}

type SpanDetailData = Stats & {
  type: string;
  name: string;
  namespace: string | null;
  self: number;
  step: number;
  series: { t: number; count: number; errors: number; avg: number | null; p95: number | null }[];
  invocations: { trace_id: string; span_id: string; time: number; duration: number; self: number | null; status: number | null; error: string | null; attrs: string | null; root_time: number | null; operation: string | null; kind: string | null }[];
};

function SpanDetail({ type, name }: { type: string; name: string }) {
  const [outcome, setOutcome] = useState<"" | "ok" | "error">("");
  const s = useObs<SpanDetailData>("span", { type, name, outcome: outcome || undefined });
  if (s.loading && !s.data) return <Skeleton rows={8} />;
  if (!s.data) return <ErrorNote error={s.error} />;
  const d = s.data;
  const sql = d.invocations.map((i) => attrsOf(i.attrs)["db.query.text"]).find(Boolean);
  return (
    <div className="obs-page">
      <BackLink to={href("spans")}>All spans</BackLink>
      <Card
        title={
          <span className="op-name">
            <span className="wf-type" style={{ "--c": typeColor(type) } as React.CSSProperties}>
              {type}
            </span>
            <code>{name}</code> <Refreshing on={s.refreshing} />
          </span>
        }
        className="flush"
      >
        <Facts
          items={[
            { label: "Invocations", value: count(d.count) },
            { label: "Errors", value: count(d.errors), tone: d.errors ? "bad" : undefined },
            { label: "Failure rate", value: d.count ? `${((d.errors / d.count) * 100).toFixed(2)}%` : "—" },
            { label: "Avg duration", value: ms(d.avg) },
            { label: "p95 · p99", value: `${ms(d.p95)} · ${ms(d.p99)}` },
            { label: "Own time, total", value: ms(d.self) },
            ...(d.namespace ? [{ label: "Code", value: d.namespace }] : []),
          ]}
        />
      </Card>
      <div className="grid-2">
        <Card title="Invocations" extra={<Legend items={[{ label: "ok", color: typeColor(type) }, { label: "failed", color: "var(--bad)" }]} />}>
          <TimeChart points={d.series.map((p) => ({ t: p.t, ok: p.count - p.errors, errors: p.errors }))} step={d.step} height={140} marks={[{ kind: "bars", stack: [{ key: "ok", label: "ok", color: typeColor(type) }, { key: "errors", label: "failed", color: "var(--bad)" }] }]} />
        </Card>
        <Card title="Duration" extra={<Legend items={[{ label: "avg", color: typeColor(type), kind: "line" }, { label: "p95", color: typeColor(type), kind: "dashed" }]} />}>
          <TimeChart
            points={d.series}
            step={d.step}
            height={140}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "avg", label: "avg", color: typeColor(type), area: true },
              { kind: "line", key: "p95", label: "p95", color: typeColor(type), dashed: true },
            ]}
          />
        </Card>
      </div>
      {sql && (
        <Card title="Statement">
          <pre className="json">{String(sql)}</pre>
        </Card>
      )}
      <div className="toolbar-row">
        <Chips
          label="Outcome"
          value={outcome}
          onChange={setOutcome}
          options={[
            { value: "", label: "All" },
            { value: "ok", label: "Succeeded" },
            { value: "error", label: "Failed" },
          ]}
        />
      </div>
      <Card title="Recent invocations" className="flush">
        {d.invocations.length ? (
          <table className="obs-table">
            <thead>
              <tr>
                <th scope="col">Trace</th>
                <th scope="col">Outcome</th>
                <th scope="col">In</th>
                <th scope="col" className="num">
                  Start offset
                </th>
                <th scope="col" className="num">
                  Duration
                </th>
                <th scope="col" className="num">
                  When
                </th>
              </tr>
            </thead>
            <tbody>
              {d.invocations.map((i) => (
                <tr key={i.span_id} className="clickable" onClick={() => navigate("trace", { id: i.trace_id })}>
                  <td>
                    <TraceLink id={i.trace_id} />
                  </td>
                  <td>{Number(i.status) === 2 ? <span className="badge bad">failed</span> : <span className="badge ok">ok</span>}</td>
                  <td className="mono small">{i.operation ?? <span className="faint">—</span>}</td>
                  <td className="num mono">{i.root_time === null ? "—" : `+${ms(Number(i.time) - Number(i.root_time))}`}</td>
                  <td className="num mono">{ms(Number(i.duration))}</td>
                  <td className="num muted small" title={fullTime(Number(i.time))}>
                    {ago(Number(i.time))}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <Empty icon="spans">No kept invocations in this range.</Empty>
        )}
      </Card>
    </div>
  );
}

