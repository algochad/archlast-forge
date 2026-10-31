import { useState } from "react";
import { formatBytes } from "../api";
import { Gauge, Legend, TimeChart } from "../charts";
import { ago, count, ms, pct } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs } from "../obs";
import { Empty, ErrorNote, Skeleton } from "../ui";

type Sample = Record<string, number | null> & { t: number };
type RuntimeData = {
  step: number;
  instances: { instance: string; role: string; time: number; stale: boolean; cpu: number | null; rss: number | null; heap_used: number | null; heap_total: number | null; loop_p99: number | null; loop_mean: number | null; connections: number | null; subscriptions: number | null; inflight: number | null }[];
  series: { instance: string; role: string; points: Sample[] }[];
};

const bytes = (v: number) => formatBytes(v);

export function Runtime() {
  const r = useObs<RuntimeData>("runtime");
  const [pick, setPick] = useState<string | null>(null);
  if (r.loading && !r.data) return <Skeleton rows={8} />;
  if (!r.data) return <ErrorNote error={r.error} />;
  const d = r.data;
  if (!d.instances.length && !d.series.length)
    return <Empty icon="runtime">No samples yet. Each server process (and each function-runtime process in development) reports its CPU, memory and event loop every 10 seconds.</Empty>;
  const instance = pick ?? d.instances.find((i) => i.role === "server")?.instance ?? d.series[0]?.instance;
  const s = d.series.find((x) => x.instance === instance);
  const now = d.instances.find((i) => i.instance === instance);
  const pts = s?.points ?? [];
  const cacheRate = pts.map((p) => {
    const served = (p.cache_hits ?? 0) + (p.cache_shared ?? 0);
    const all = served + (p.cache_misses ?? 0);
    return { t: p.t, rate: all ? (served / all) * 100 : null };
  });
  return (
    <div className="obs-page">
      <Card title={<>Instances <Refreshing on={r.refreshing} /></>} className="flush">
        <table className="obs-table">
          <thead>
            <tr>
              <th scope="col">Process</th>
              <th scope="col">Role</th>
              <th scope="col" className="num">
                CPU
              </th>
              <th scope="col" className="num">
                Memory
              </th>
              <th scope="col" className="num">
                Heap
              </th>
              <th scope="col" className="num">
                Loop delay p99
              </th>
              <th scope="col" className="num">
                Connections
              </th>
              <th scope="col" className="num">
                Reported
              </th>
            </tr>
          </thead>
          <tbody>
            {d.instances.map((i) => (
              <tr key={i.instance} className={`clickable${i.instance === instance ? " selected-row" : ""}`} onClick={() => setPick(i.instance)} aria-selected={i.instance === instance}>
                <td className="mono">{i.instance}</td>
                <td>
                  <span className="badge">{i.role === "server" ? "server" : "function runtime"}</span>
                </td>
                <td className={`num mono${(i.cpu ?? 0) > 85 ? " bad" : ""}`}>{i.cpu === null ? "—" : `${Number(i.cpu).toFixed(1)}%`}</td>
                <td className="num mono">{i.rss === null ? "—" : bytes(Number(i.rss))}</td>
                <td className="num mono">{i.heap_used === null ? "—" : `${bytes(Number(i.heap_used))} / ${bytes(Number(i.heap_total))}`}</td>
                <td className={`num mono${(i.loop_p99 ?? 0) > 100 ? " bad" : ""}`}>{i.loop_p99 === null ? "—" : ms(Number(i.loop_p99))}</td>
                <td className="num mono">{i.connections === null ? "—" : count(Number(i.connections))}</td>
                <td className="num small">{i.stale ? <span className="badge warn">stale · {ago(Number(i.time))}</span> : <span className="muted">{ago(Number(i.time))}</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
      {now && (
        <Card title={<>Now <span className="badge mono">{instance}</span></>}>
          <div className="gauges">
            <Gauge label="CPU" value={now.cpu === null ? null : Number(now.cpu)} max={100} format={(v) => `${v.toFixed(0)}%`} />
            <Gauge label="Heap used" value={now.heap_used === null ? null : (Number(now.heap_used) / Math.max(1, Number(now.heap_total))) * 100} max={100} format={(v) => `${v.toFixed(0)}%`} />
            <Gauge label="Loop delay" value={now.loop_p99 === null ? null : Number(now.loop_p99)} max={200} format={(v) => ms(v, 0)} tone={(now.loop_p99 ?? 0) > 100 ? "bad" : (now.loop_p99 ?? 0) > 40 ? "warn" : "ok"} />
            <Gauge label="In flight" value={now.inflight === null ? null : Number(now.inflight)} max={Math.max(50, Number(now.inflight ?? 0) * 1.5)} format={(v) => count(v)} tone="ok" />
          </div>
        </Card>
      )}
      <div className="grid-2">
        <Card title="CPU" extra={<Legend items={[{ label: "user", color: "var(--viz-1)", kind: "line" }, { label: "system", color: "var(--viz-2)", kind: "line" }]} />}>
          <TimeChart
            points={pts}
            step={d.step}
            format={(v) => `${v.toFixed(0)}%`}
            marks={[
              { kind: "line", key: "cpu_user", label: "user", color: "var(--viz-1)", area: true },
              { kind: "line", key: "cpu_system", label: "system", color: "var(--viz-2)" },
            ]}
          />
        </Card>
        <Card title="Memory" extra={<Legend items={[{ label: "resident", color: "var(--viz-1)", kind: "line" }, { label: "heap used", color: "var(--viz-3)", kind: "line" }, { label: "heap size", color: "var(--viz-3)", kind: "dashed" }]} />}>
          <TimeChart
            points={pts}
            step={d.step}
            format={bytes}
            unit={2 ** 20}
            marks={[
              { kind: "line", key: "rss", label: "resident", color: "var(--viz-1)" },
              { kind: "line", key: "heap_used", label: "heap used", color: "var(--viz-3)", area: true },
              { kind: "line", key: "heap_total", label: "heap size", color: "var(--viz-3)", dashed: true },
            ]}
          />
        </Card>
        <Card title="Event loop delay" extra={<Legend items={[{ label: "mean", color: "var(--viz-4)", kind: "line" }, { label: "p99", color: "var(--viz-4)", kind: "dashed" }, { label: "max", color: "var(--bad)", kind: "line" }]} />}>
          <TimeChart
            points={pts}
            step={d.step}
            format={(v) => ms(v, 0)}
            marks={[
              { kind: "line", key: "loop_mean", label: "mean", color: "var(--viz-4)", area: true },
              { kind: "line", key: "loop_p99", label: "p99", color: "var(--viz-4)", dashed: true },
              { kind: "line", key: "loop_max", label: "max", color: "var(--bad)" },
            ]}
          />
          <p className="note-line">How late timers fire: work that never yields (a long synchronous loop) shows up here first.</p>
        </Card>
        <Card title="Connections and live queries" extra={<Legend items={[{ label: "WebSocket connections", color: "var(--viz-2)", kind: "line" }, { label: "subscriptions", color: "var(--viz-1)", kind: "line" }]} />}>
          <TimeChart
            points={pts}
            step={d.step}
            marks={[
              { kind: "line", key: "connections", label: "connections", color: "var(--viz-2)" },
              { kind: "line", key: "subscriptions", label: "subscriptions", color: "var(--viz-1)", area: true },
            ]}
          />
        </Card>
        <Card title="Query cache" extra={<span className="note-line">calls answered without running the query</span>}>
          <TimeChart points={cacheRate} step={d.step} format={(v) => `${v.toFixed(0)}%`} marks={[{ kind: "line", key: "rate", label: "hit rate", color: "var(--viz-3)", area: true }]} emptyLabel="The cache is off, or idle" />
          {pts.length > 0 && (
            <p className="note-line">
              {count(pts.reduce((n, p) => n + (p.cache_hits ?? 0) + (p.cache_shared ?? 0), 0))} served from cache · {count(pts.reduce((n, p) => n + (p.cache_misses ?? 0), 0))} ran ·{" "}
              {pct(cacheRate.filter((c) => c.rate !== null).reduce((n, c) => n + c.rate!, 0) / Math.max(1, cacheRate.filter((c) => c.rate !== null).length) / 100)} average
            </p>
          )}
        </Card>
        <Card title="Requests in flight">
          <TimeChart points={pts} step={d.step} marks={[{ kind: "line", key: "inflight", label: "in flight", color: "var(--viz-6)", area: true }]} />
        </Card>
      </div>
    </div>
  );
}
