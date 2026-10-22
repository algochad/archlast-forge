import { useState } from "react";
import { get, type Log } from "../api";
import { ErrorNote, Field, LineChart, Spinner, useAsync } from "../ui";

type Bucket = { start: number; calls: number; errors: number; p50: number; p95: number; subscriptions: number | null; connections: number | null };
const WINDOWS = { "1h": 3600_000, "24h": 86400_000, "7d": 7 * 86400_000 } as const;

export function Metrics() {
  const [window, setWindow] = useState<keyof typeof WINDOWS>("1h");
  const metrics = useAsync(() => get<Bucket[]>("metrics", { windowMs: WINDOWS[window], buckets: 30 }), [window], { interval: 15_000 });
  const recent = useAsync(() => get<Log[]>("recentLogs"), [], { interval: 5000 });
  const server = useAsync(() => get<Record<string, number | string>>("server"), [], { interval: 5000 });
  const b = metrics.data ?? [];
  const labels = b.map((x) => new Date(x.start).toLocaleTimeString([], window === "7d" ? { month: "short", day: "numeric" } : { hour: "2-digit", minute: "2-digit" }));
  const perFunction = Object.entries(
    (recent.data ?? [])
      .filter((l) => l.level === "call")
      .reduce<Record<string, { n: number; errors: number; ms: number }>>((acc, l) => {
        const s = (acc[l.name] ??= { n: 0, errors: 0, ms: 0 });
        s.n++;
        if (!l.ok) s.errors++;
        s.ms += l.durationMs ?? 0;
        return acc;
      }, {}),
  ).sort((x, y) => y[1].n - x[1].n);

  return (
    <div className="stack">
      <section className="panel toolbar" aria-label="Server">
        {server.data &&
          (
            [
              ["server", server.data.serverId],
              ["connections", server.data.connections],
              ["subscriptions", server.data.subscriptions],
              ["runtime processes", server.data.workers],
              ["uptime", `${Math.round(Number(server.data.uptimeMs) / 60_000)} min`],
            ] as const
          ).map(([label, value]) => (
            <div key={label} className="stat">
              <span className="muted small">{label}</span>
              <strong>{String(value)}</strong>
            </div>
          ))}
        <Field label="Window">
          {(id) => (
            <select id={id} value={window} onChange={(e) => setWindow(e.target.value as keyof typeof WINDOWS)}>
              {Object.keys(WINDOWS).map((w) => (
                <option key={w}>{w}</option>
              ))}
            </select>
          )}
        </Field>
      </section>
      <ErrorNote error={metrics.error} />
      {metrics.loading && !metrics.data ? (
        <Spinner />
      ) : (
        <div className="charts">
          <LineChart
            title="Calls and errors"
            labels={labels}
            series={[
              { name: "calls", values: b.map((x) => x.calls), color: "var(--accent)" },
              { name: "errors", values: b.map((x) => x.errors), color: "var(--bad)" },
            ]}
          />
          <LineChart
            title="Latency"
            unit=" ms"
            labels={labels}
            series={[
              { name: "p50", values: b.map((x) => (x.calls ? x.p50 : null)), color: "var(--accent)" },
              { name: "p95", values: b.map((x) => (x.calls ? x.p95 : null)), color: "var(--warn)" },
            ]}
          />
          <LineChart
            title="Subscriptions and connections (all servers)"
            labels={labels}
            series={[
              { name: "subscriptions", values: b.map((x) => x.subscriptions), color: "var(--accent)" },
              { name: "connections", values: b.map((x) => x.connections), color: "var(--ok)" },
            ]}
          />
        </div>
      )}
      <section className="panel" aria-label="Recent calls by function">
        <h3>Recent calls on this server</h3>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th scope="col">function</th>
                <th scope="col" className="num">calls</th>
                <th scope="col" className="num">errors</th>
                <th scope="col" className="num">avg ms</th>
              </tr>
            </thead>
            <tbody>
              {perFunction.map(([name, s]) => (
                <tr key={name}>
                  <td>{name}</td>
                  <td className="num">{s.n}</td>
                  <td className={`num ${s.errors ? "bad" : ""}`}>{s.errors}</td>
                  <td className="num">{(s.ms / s.n).toFixed(1)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
