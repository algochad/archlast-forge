import { Fragment, useState } from "react";
import { formatBytes } from "../api";
import { Icon } from "../brand";
import { ago, count, ms } from "../format";
import { Card, Rate, Refreshing } from "../kit";
import { useObs } from "../obs";
import { Empty, ErrorNote, Skeleton, Stat } from "../ui";

type Proc = {
  instance: string;
  role: string;
  time: number;
  cpu: number | null;
  rss: number | null;
  heap_used: number | null;
  heap_total: number | null;
  loop_p99: number | null;
  connections: number | null;
  subscriptions: number | null;
  inflight: number | null;
};
type NodeRow = {
  service: string;
  node: string;
  host: string;
  pid: string;
  first: number;
  last: number;
  live: boolean;
  processes: Proc[];
  requests: { count: number; errors: number; clientErrors: number; avg: number | null } | null;
};

/** Stopped nodes shown per service before "show all": a dev machine restarts often, and each restart is a node of its own. */
const STOPPED_SHOWN = 5;
const sum = (ps: Proc[], k: keyof Proc) => ps.reduce((n, p) => n + (Number(p[k]) || 0), 0);
/** CPU is a share of one core per process; a node's is its processes' together, in cores. */
const cores = (ps: Proc[]) => (sum(ps, "cpu") / 100).toFixed(2);
const since = (t: number) => {
  const s = Math.max(0, (Date.now() - t) / 1000);
  return s < 3600 ? `${Math.round(s / 60)} min` : s < 86_400 ? `${(s / 3600).toFixed(1)} h` : `${(s / 86_400).toFixed(1)} d`;
};

/**
 * The nodes of every service: a node is one server process (a container, a Kubernetes pod or a machine running the engine) with the function
 * runtime processes it runs. Replicas a scaler adds show up within seconds of starting; ones it removes stop reporting and are listed as stopped.
 */
export function Nodes() {
  const n = useObs<NodeRow[]>("nodes");
  const [open, setOpen] = useState<string | null>(null);
  const [all, setAll] = useState<string[]>([]);
  if (n.loading && !n.data) return <Skeleton rows={8} />;
  if (!n.data) return <ErrorNote error={n.error} />;
  if (!n.data.length)
    return <Empty icon="nodes">No node has reported in this range. Each server process sends its CPU, memory and event loop every 10 seconds, its first a second after it starts.</Empty>;
  const services = Map.groupBy(n.data, (x) => x.service);
  const live = n.data.filter((x) => x.live);
  return (
    <div className="obs-page">
      <section className="stats" aria-label="Nodes summary">
        <Stat
          label="Live nodes"
          icon="nodes"
          tone={live.length ? "ok" : "warn"}
          value={count(live.length)}
          hint={`across ${services.size} ${services.size === 1 ? "service" : "services"}`}
        />
        <Stat label="Processes" icon="runtime" value={count(live.reduce((k, x) => k + x.processes.length, 0))} hint="servers and function runtimes, live" />
        <Stat label="CPU" icon="bolt" value={`${cores(live.flatMap((x) => x.processes))} cores`} hint="the live nodes together" />
        <Stat
          label="Memory"
          icon="data"
          value={formatBytes(
            sum(
              live.flatMap((x) => x.processes),
              "rss",
            ),
          )}
          hint="resident, the live nodes together"
        />
      </section>
      {[...services].map(([service, rows]) => {
        const up = rows.filter((x) => x.live);
        const stopped = rows.filter((x) => !x.live);
        const shown = [...up, ...(all.includes(service) ? stopped : stopped.slice(0, STOPPED_SHOWN))];
        return (
          <Card
            key={service}
            className="flush"
            title={
              <>
                <Icon name="flame" size={16} /> {service} <Refreshing on={n.refreshing} />
              </>
            }
            extra={
              <span className="note-line">
                {up.length} live{stopped.length ? ` · ${stopped.length} stopped in this range` : ""}
              </span>
            }
            footer={
              stopped.length > STOPPED_SHOWN && !all.includes(service) ? (
                <button className="btn ghost" onClick={() => setAll([...all, service])}>
                  Show all {stopped.length} stopped nodes
                </button>
              ) : undefined
            }
          >
            <table className="obs-table">
              <thead>
                <tr>
                  <th scope="col">Node</th>
                  <th scope="col">Status</th>
                  <th scope="col" className="num">
                    Up for
                  </th>
                  <th scope="col" className="num">
                    CPU
                  </th>
                  <th scope="col" className="num">
                    Memory
                  </th>
                  <th scope="col" className="num">
                    Loop p99
                  </th>
                  <th scope="col" className="num">
                    Connections
                  </th>
                  <th scope="col" className="num">
                    Requests
                  </th>
                  <th scope="col" className="num">
                    Avg
                  </th>
                  <th scope="col" className="num">
                    Errors
                  </th>
                </tr>
              </thead>
              <tbody>
                {shown.map((x) => {
                  const id = `${service}\u0000${x.node}`;
                  const server = x.processes.find((p) => p.role === "server");
                  const r = x.requests;
                  return (
                    <Fragment key={id}>
                      <tr className={`clickable${x.live ? "" : " faded"}`} onClick={() => setOpen(open === id ? null : id)} aria-expanded={open === id}>
                        <td>
                          <span className="op-name">
                            <Icon name={open === id ? "chevron-down" : "chevron-right"} size={12} />
                            <code>{x.host}</code>
                            <span className="muted small">pid {x.pid}</span>
                            <span className="badge">{x.processes.length === 1 ? "1 process" : `${x.processes.length} processes`}</span>
                          </span>
                        </td>
                        <td>{x.live ? <span className="badge ok">live</span> : <span className="badge warn">stopped · {ago(x.last)}</span>}</td>
                        <td className="num mono">{x.live ? since(x.first) : "—"}</td>
                        <td className="num mono">{cores(x.processes)}</td>
                        <td className="num mono">{formatBytes(sum(x.processes, "rss"))}</td>
                        <td className={`num mono${(server?.loop_p99 ?? 0) > 100 ? " bad" : ""}`}>{server?.loop_p99 == null ? "—" : ms(Number(server.loop_p99))}</td>
                        <td className="num mono">{server?.connections == null ? "—" : count(Number(server.connections))}</td>
                        <td className="num mono">{r ? count(r.count) : "—"}</td>
                        <td className="num mono">{r?.avg == null ? "—" : ms(r.avg)}</td>
                        <td className="num mono">{r?.count ? <Rate value={(r.errors + r.clientErrors) / r.count} /> : "—"}</td>
                      </tr>
                      {open === id &&
                        x.processes.map((p) => (
                          <tr key={p.instance} className="sub-row">
                            <td>
                              <code className="sub-name">{p.instance}</code>
                            </td>
                            <td>
                              <span className="badge">{p.role === "server" ? "server" : "function runtime"}</span>
                            </td>
                            <td className="num small muted">{ago(p.time)}</td>
                            <td className={`num mono${(p.cpu ?? 0) > 85 ? " bad" : ""}`}>{p.cpu == null ? "—" : `${Number(p.cpu).toFixed(1)}%`}</td>
                            <td className="num mono">{p.rss == null ? "—" : formatBytes(Number(p.rss))}</td>
                            <td className={`num mono${(p.loop_p99 ?? 0) > 100 ? " bad" : ""}`}>{p.loop_p99 == null ? "—" : ms(Number(p.loop_p99))}</td>
                            <td className="num mono">{p.connections == null ? "—" : count(Number(p.connections))}</td>
                            <td className="num mono" colSpan={3}>
                              {p.inflight == null ? "" : `${count(Number(p.inflight))} in flight`}
                              {p.subscriptions == null ? "" : ` · ${count(Number(p.subscriptions))} live queries`}
                            </td>
                          </tr>
                        ))}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </Card>
        );
      })}
      <p className="muted small">
        A node is one server process with the function runtime processes it runs, named by its host (in a container or a Kubernetes pod, its name) and process id. When a service scales,
        through Kubernetes, archlast gaia or any other scaler, a new replica is listed here a second after it starts, and one that was removed stops reporting and moves to stopped. Requests
        per node cover the last two days at most: older traffic is kept per service.
      </p>
    </div>
  );
}
