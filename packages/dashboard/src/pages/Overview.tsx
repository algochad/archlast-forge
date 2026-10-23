import { ago, get, type Log, type Manifest } from "../api";
import { Logo } from "../brand";
import { Badge, Empty, Stat, useAsync } from "../ui";

type Bucket = { start: number; calls: number; errors: number; p50: number; p95: number; subscriptions: number | null; connections: number | null };
type Server = { serverId: string; connections: number; subscriptions: number; workers: number; uptimeMs: number };
type AuditEntry = { _id: string; time: number; actor: string; action: string; target: string | null };

const compact = (n: number) => (n >= 10_000 ? `${(n / 1000).toFixed(n >= 100_000 ? 0 : 1)}k` : String(n));
const uptime = (ms: number) => (ms < 3600_000 ? `${Math.round(ms / 60_000)} min` : ms < 86400_000 ? `${(ms / 3600_000).toFixed(1)} h` : `${(ms / 86400_000).toFixed(1)} d`);

export function Overview({ manifest, onOpen }: { manifest: Manifest; onOpen: (page: "Logs" | "Audit" | "Data" | "Functions") => void }) {
  const metrics = useAsync(() => get<Bucket[]>("metrics", { windowMs: 3600_000, buckets: 24 }), [], { interval: 15_000 });
  const server = useAsync(() => get<Server>("server"), [], { interval: 5000 });
  const logs = useAsync(() => get<Log[]>("recentLogs"), [], { interval: 5000 });
  const audit = useAsync(() => get<AuditEntry[]>("audit", { limit: 6 }), [], { interval: 15_000 });

  const b = metrics.data ?? [];
  const calls = b.reduce((n, x) => n + x.calls, 0);
  const errors = b.reduce((n, x) => n + x.errors, 0);
  const errorRate = calls ? (errors / calls) * 100 : 0;
  const p95 = Math.max(0, ...b.map((x) => x.p95));
  const publicFns = manifest.functions.filter((f) => f.visibility !== "internal").length;
  const userTables = Object.entries(manifest.tables).filter(([name, t]) => t.strict && !name.startsWith("_")).length;
  const healthy = !manifest.error;
  const recent = [...(logs.data ?? [])].reverse().slice(0, 8);

  return (
    <>
      <section className="hero" aria-label="Forge status">
        <Logo size={52} />
        <div>
          <h2>{healthy ? "The forge is hot" : "The forge is cold"}</h2>
          <p>
            {healthy
              ? `${manifest.functions.length} functions loaded across ${userTables} tables · up ${server.data ? uptime(server.data.uptimeMs) : "…"}`
              : `The function runtime failed to load: ${manifest.error}`}
          </p>
        </div>
        <span className="push" />
        <Badge tone={healthy ? "ok" : "bad"}>
          <span className={`status-dot ${healthy ? "live" : "bad"}`} /> {healthy ? "runtime healthy" : "runtime down"}
        </Badge>
        {manifest.storage && <Badge tone="accent">storage on</Badge>}
      </section>

      <section className="stats" aria-label="Last hour">
        <Stat label="Calls · 1h" icon="bolt" tone="ember" value={compact(calls)} hint={`${(calls / 60).toFixed(1)} per minute`} trend={b.map((x) => x.calls)} />
        <Stat label="Error rate" icon="flame" tone={errorRate > 5 ? "bad" : errorRate > 1 ? "warn" : undefined} value={`${errorRate.toFixed(errorRate < 10 ? 1 : 0)}%`} hint={`${errors} failed calls`} trend={b.map((x) => x.errors)} />
        <Stat label="p95 latency" icon="metrics" value={`${Math.round(p95)} ms`} hint="slowest 5% of calls" trend={b.map((x) => x.p95)} />
        <Stat label="Live queries" icon="data" tone="ok" value={server.data?.subscriptions ?? "…"} hint={`${server.data?.connections ?? 0} open connections`} />
      </section>

      <section className="stats" aria-label="Project">
        <Stat label="Tables" icon="data" value={userTables} hint={`+ ${Object.keys(manifest.tables).length - userTables} built in (auth, files)`} />
        <Stat label="Functions" icon="functions" value={manifest.functions.length} hint={`${publicFns} public · ${manifest.functions.length - publicFns} internal`} />
        <Stat label="Crons" icon="scheduled" value={manifest.crons.length} hint={manifest.crons[0]?.name ?? "none scheduled"} />
        <Stat label="Runtime processes" icon="settings" value={server.data?.workers ?? "…"} hint={server.data?.serverId ?? ""} />
      </section>

      <div className="two-col">
        <section className="panel" aria-label="Recent activity">
          <div className="toolbar">
            <h3>Recent activity</h3>
            <button className="link push small" onClick={() => onOpen("Logs")}>
              All logs →
            </button>
          </div>
          {recent.length ? (
            <ul className="activity">
              {recent.map((l, i) => (
                <li key={i}>
                  {l.level === "call" ? <Badge tone={l.ok ? "ok" : "bad"}>{l.ok ? "ok" : "fail"}</Badge> : <Badge tone={l.level === "error" ? "bad" : "neutral"}>{l.level}</Badge>}
                  <span className="mono small cell-code">
                    {l.name}
                    {l.level !== "call" || !l.ok ? <span className="muted"> · {l.message}</span> : null}
                  </span>
                  <span className="muted small nowrap">{l.durationMs !== undefined ? `${l.durationMs} ms · ` : ""}{ago(l.time)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="bolt">No calls yet. Use your app, or run a function from the Functions page.</Empty>
          )}
        </section>
        <section className="panel" aria-label="Dashboard changes">
          <div className="toolbar">
            <h3>Dashboard changes</h3>
            <button className="link push small" onClick={() => onOpen("Audit")}>
              Audit log →
            </button>
          </div>
          {audit.data?.length ? (
            <ul className="activity">
              {audit.data.map((e) => (
                <li key={e._id}>
                  <Badge tone="accent">{e.action}</Badge>
                  <span className="small cell-code">
                    {e.actor}
                    {e.target && <span className="muted mono"> · {e.target}</span>}
                  </span>
                  <span className="muted small nowrap">{ago(e.time)}</span>
                </li>
              ))}
            </ul>
          ) : (
            <Empty icon="audit">Nothing changed from the dashboard yet.</Empty>
          )}
        </section>
      </div>
    </>
  );
}
