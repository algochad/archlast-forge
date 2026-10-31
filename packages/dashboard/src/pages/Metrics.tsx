import { Fragment, useState } from "react";
import { Icon } from "../brand";
import { Spark, TimeChart } from "../charts";
import { ago, count } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs } from "../obs";
import { Empty, ErrorNote, Skeleton } from "../ui";

type MetricItem = {
  name: string;
  type: "counter" | "gauge" | "histogram";
  unit: string | null;
  value: number | null;
  count: number;
  min: number | null;
  max: number | null;
  lastUpdated: number;
  lifetime: number | null;
  series: { attrs: string; points: { t: number; value: number | null }[] }[];
};

const fmt = (v: number | null | undefined, unit?: string | null) => (v === null || v === undefined ? "—" : `${Math.abs(v) < 10 && !Number.isInteger(v) ? v.toFixed(3) : count(v)}${unit ? ` ${unit}` : ""}`);
const SERIES = ["var(--viz-1)", "var(--viz-2)", "var(--viz-3)", "var(--viz-4)", "var(--viz-5)", "var(--viz-6)"];
const label = (attrs: string) => {
  try {
    const a = JSON.parse(attrs) as Record<string, unknown>;
    const parts = Object.entries(a).map(([k, v]) => `${k}=${v}`);
    return parts.length ? parts.join(", ") : "all";
  } catch {
    return attrs;
  }
};

export function CustomMetrics() {
  const m = useObs<{ step: number; list: MetricItem[] }>("metrics");
  const [open, setOpen] = useState<string | null>(null);
  if (m.loading && !m.data) return <Skeleton rows={6} />;
  if (!m.data) return <ErrorNote error={m.error} />;
  const d = m.data;
  if (!d.list.length) return <MetricsHowTo />;
  return (
    <div className="obs-page">
      <div className="metric-cards">
        {d.list.slice(0, 8).map((x) => (
          <button key={x.name} type="button" className="metric-card" onClick={() => setOpen(x.name)} aria-pressed={open === x.name}>
            <span className="metric-card-head">
              <code>{x.name}</code>
              <span className="badge">{x.type}</span>
            </span>
            <strong>{x.type === "histogram" ? fmt(x.count ? (x.value ?? 0) / x.count : null, x.unit) : fmt(x.value, x.unit)}</strong>
            <Spark values={x.series.length ? x.series[0]!.points.map((p) => p.value) : []} bars={x.type === "counter"} />
            <span className="faint small">
              {x.type === "gauge" ? `latest reading · ${ago(x.lastUpdated)}` : x.type === "histogram" ? `average of ${count(x.count)} in this range` : `this range${x.lifetime !== null ? ` · ${count(x.lifetime)} lifetime` : ""}`}
            </span>
          </button>
        ))}
      </div>
      <Card title={<>Metrics <span className="badge">{d.list.length}</span> <Refreshing on={m.refreshing} /></>} className="flush">
        <table className="obs-table">
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">Type</th>
              <th scope="col" className="num">
                Value / increase
              </th>
              <th scope="col" className="num">
                Min · max
              </th>
              <th scope="col" className="num">
                Lifetime
              </th>
              <th scope="col" className="num">
                Updated
              </th>
            </tr>
          </thead>
          <tbody>
            {d.list.map((x) => (
              <Fragment key={x.name}>
                <tr className="clickable" onClick={() => setOpen(open === x.name ? null : x.name)} aria-expanded={open === x.name}>
                  <td>
                    <span className="op-name">
                      <Icon name={open === x.name ? "chevron-down" : "chevron-right"} size={12} />
                      <code>{x.name}</code>
                    </span>
                  </td>
                  <td>
                    <span className="badge">{x.type}</span>
                  </td>
                  <td className="num mono">{x.type === "histogram" ? `${fmt(x.count ? (x.value ?? 0) / x.count : null, x.unit)} avg` : fmt(x.value, x.unit)}</td>
                  <td className="num mono">
                    {fmt(x.min)} · {fmt(x.max)}
                  </td>
                  <td className="num mono">{x.lifetime === null ? "—" : fmt(x.lifetime)}</td>
                  <td className="num muted small">{ago(x.lastUpdated)}</td>
                </tr>
                {open === x.name && (
                  <tr className="log-expand">
                    <td colSpan={6}>
                      <TimeChart
                        points={x.series[0]!.points.map((p, i) => ({ t: p.t, ...Object.fromEntries(x.series.slice(0, 6).map((s, j) => [`s${j}`, s.points[i]?.value ?? null])) }))}
                        step={d.step}
                        height={170}
                        format={(v) => fmt(v)}
                        marks={x.series.slice(0, 6).map((s, j) => (x.type === "counter" ? { kind: "line" as const, key: `s${j}`, label: label(s.attrs), color: SERIES[j]!, area: j === 0 } : { kind: "line" as const, key: `s${j}`, label: label(s.attrs), color: SERIES[j]! }))}
                      />
                      <div className="viz-legend" style={{ marginTop: "0.4rem" }}>
                        {x.series.slice(0, 6).map((s, j) => (
                          <span key={s.attrs}>
                            <i className="viz-swatch line" style={{ "--c": SERIES[j] } as React.CSSProperties} />
                            {label(s.attrs)}
                          </span>
                        ))}
                        {x.series.length > 6 && <span className="faint">+{x.series.length - 6} more attribute sets</span>}
                      </div>
                    </td>
                  </tr>
                )}
              </Fragment>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function MetricsHowTo() {
  return (
    <Card title="No custom metrics yet">
      <p className="muted" style={{ margin: 0 }}>
        Record your own numbers from any function, and they show up here per minute, split by their attributes. Other services' OpenTelemetry metrics land here too.
      </p>
      <pre className="json">{`import { metrics, mutation } from "@archlast/forge-runtime";

const placed = metrics.counter("orders.placed");
const depth = metrics.gauge("queue.depth");

export const placeOrder = mutation({
  handler: async (ctx, args) => {
    // …
    placed.add(1, { plan: args.plan });
    depth.set(await countPending(ctx));
  },
});`}</pre>
    </Card>
  );
}
