import { useState } from "react";
import { Icon, type IconName } from "../brand";
import { useWidth } from "../charts";
import { count, ms, pct } from "../format";
import { Card, Refreshing } from "../kit";
import { useObs, useRange, type Stats } from "../obs";
import { href } from "../router";
import { Empty, ErrorNote, Skeleton } from "../ui";

type MapData = {
  services: { service: string; requests: Stats; jobs: Stats }[];
  dependencies: (Stats & { from: string; to: string; type: string; label: string })[];
  links: { from: string; to: string; count: number; avg: number; errors: number }[];
};

type Kind = "clients" | "app" | "queue" | "db" | "http";
type MapNode = { id: string; kind: Kind; title: string; sub: string; col: number; errorRate: number; go?: string };
type MapEdge = { from: string; to: string; count: number; errorRate: number; inferred?: boolean; label: string };

const ICON: Record<Kind, IconName> = { clients: "users", app: "box", queue: "jobs", db: "data", http: "globe" };
const W = 188;
const H = 56;

/** Columns left to right: who calls in, the services (by how many hops from a client), then what they call out to. */
function layout(d: MapData, serviceFilter?: string) {
  const nodes = new Map<string, MapNode>();
  const edges: MapEdge[] = [];
  const incoming = new Map<string, number>();
  for (const l of d.links) incoming.set(l.to, (incoming.get(l.to) ?? 0) + l.count);
  const depth = new Map<string, number>();
  const entry = d.services.filter((s) => s.requests.count > (incoming.get(s.service) ?? 0) * 0.5 || !incoming.has(s.service));
  for (const s of entry) depth.set(s.service, 1);
  for (let changed = true, guard = 0; changed && guard < 20; guard++) {
    changed = false;
    for (const l of d.links) {
      const next = (depth.get(l.from) ?? 1) + 1;
      if (!depth.has(l.to) || (depth.get(l.to)! < next && next < 8)) {
        depth.set(l.to, next);
        changed = true;
      }
    }
  }
  const clients = entry.reduce((n, s) => n + s.requests.count - (incoming.get(s.service) ?? 0), 0);
  if (clients > 0) nodes.set("clients", { id: "clients", kind: "clients", title: "Clients", sub: `${count(clients)} requests`, col: 0, errorRate: 0 });
  for (const s of d.services) {
    if (serviceFilter && s.service !== serviceFilter && !d.links.some((l) => (l.from === serviceFilter && l.to === s.service) || (l.to === serviceFilter && l.from === s.service))) continue;
    const r = s.requests;
    const er = r.count ? r.errors / r.count : 0;
    nodes.set(`svc:${s.service}`, { id: `svc:${s.service}`, kind: "app", title: s.service, sub: `${count(r.count)} requests · ${ms(r.avg)}`, col: depth.get(s.service) ?? 1, errorRate: er, go: href("requests") });
    if (clients > 0 && entry.includes(s)) edges.push({ from: "clients", to: `svc:${s.service}`, count: r.count - (incoming.get(s.service) ?? 0), errorRate: er, label: `${count(r.count)} req` });
    if (s.jobs.count) {
      const id = `queue:${s.service}`;
      const jr = (s.jobs.errors + s.jobs.clientErrors) / s.jobs.count;
      nodes.set(id, { id, kind: "queue", title: "Scheduler", sub: `${count(s.jobs.count)} jobs · ${ms(s.jobs.avg)}`, col: (depth.get(s.service) ?? 1) + 1, errorRate: jr, go: href("jobs") });
      edges.push({ from: `svc:${s.service}`, to: id, count: s.jobs.count, errorRate: jr, inferred: true, label: `${count(s.jobs.count)} jobs` });
    }
  }
  for (const l of d.links) {
    if (!nodes.has(`svc:${l.from}`) || !nodes.has(`svc:${l.to}`)) continue;
    edges.push({ from: `svc:${l.from}`, to: `svc:${l.to}`, count: l.count, errorRate: l.count ? l.errors / l.count : 0, label: `${count(l.count)} calls · ${ms(l.avg)}` });
  }
  const maxCol = Math.max(1, ...[...nodes.values()].map((n) => n.col));
  // A dependency several services use is one node: its calls and time added up across them.
  const deps = new Map<string, { kind: Kind; label: string; type: string; count: number; sum: number; errors: number }>();
  for (const dep of d.dependencies) {
    if (!nodes.has(`svc:${dep.from}`)) continue;
    const id = `dep:${dep.to}`;
    const er = dep.count ? dep.errors / dep.count : 0;
    const kind: Kind = dep.type === "db" ? "db" : dep.type === "queue" ? "queue" : "http";
    const total = deps.get(id) ?? deps.set(id, { kind, label: dep.label, type: dep.type, count: 0, sum: 0, errors: 0 }).get(id)!;
    total.count += dep.count;
    total.sum += dep.avg * dep.count;
    total.errors += dep.errors;
    edges.push({ from: `svc:${dep.from}`, to: id, count: dep.count, errorRate: er, label: `${count(dep.count)} · ${ms(dep.avg)}` });
  }
  for (const [id, t] of deps)
    nodes.set(id, {
      id,
      kind: t.kind,
      title: t.label,
      sub: `${count(t.count)} ${t.kind === "db" ? "queries" : "calls"} · ${ms(t.count ? t.sum / t.count : 0)}`,
      col: maxCol + 1,
      errorRate: t.count ? t.errors / t.count : 0,
      go: href("spans", { type: t.type }),
    });
  return { nodes: [...nodes.values()], edges, cols: Math.max(...[...nodes.values()].map((n) => n.col), 0) + 1 };
}

export function ServiceMap() {
  const m = useObs<MapData>("map");
  const range = useRange();
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hot, setHot] = useState<string | null>(null);
  if (m.loading && !m.data) return <Skeleton rows={8} />;
  if (!m.data) return <ErrorNote error={m.error} />;
  const { nodes, edges, cols } = layout(m.data, range.service);
  if (!nodes.length) return <Empty icon="map">Nothing has run in this range yet.</Empty>;
  const colW = Math.max(W + 60, (Math.max(width, 700) - 40) / Math.max(cols, 1));
  const byCol = new Map<number, MapNode[]>();
  for (const n of nodes) (byCol.get(n.col) ?? byCol.set(n.col, []).get(n.col)!).push(n);
  const rows = Math.max(...[...byCol.values()].map((c) => c.length));
  const height = Math.max(280, rows * (H + 44) + 70);
  const pos = new Map<string, { x: number; y: number }>();
  for (const [col, list] of byCol) {
    const gap = height / (list.length + 1);
    list.forEach((n, i) => pos.set(n.id, { x: 20 + col * colW + (colW - W) / 2, y: gap * (i + 1) - H / 2 }));
  }
  const svgW = Math.max(width, 20 + cols * colW);
  const reduced = typeof matchMedia !== "undefined" && matchMedia("(prefers-reduced-motion: reduce)").matches;
  return (
    <div className="obs-page">
      <Card title={<>Map <Refreshing on={m.refreshing} /></>} extra={<MapLegend />} footer={<span>Databases and outbound hosts come from the spans requests make; links between services come from traces that cross them, and a service's scheduled jobs are drawn dashed.</span>}>
        <div className="service-map" ref={ref}>
          {width > 0 && (
            <svg width={svgW} height={height} role="img" aria-label={`Service map: ${nodes.map((n) => n.title).join(", ")}`}>
              {Array.from({ length: cols }, (_, c) => (
                <line key={c} x1={20 + c * colW + colW / 2} x2={20 + c * colW + colW / 2} y1={12} y2={height - 12} className="sm-col" />
              ))}
              {edges.map((e, i) => {
                const a = pos.get(e.from);
                const b = pos.get(e.to);
                if (!a || !b) return null;
                const x1 = a.x + W;
                const y1 = a.y + H / 2;
                const x2 = b.x;
                const y2 = b.y + H / 2;
                const mid = (x1 + x2) / 2;
                const d = `M${x1},${y1} C${mid},${y1} ${mid},${y2} ${x2},${y2}`;
                const bad = e.errorRate > 0.01;
                const isHot = hot === e.from || hot === e.to;
                return (
                  <g key={i}>
                    <path d={d} className={`sm-edge${e.inferred ? " inferred" : ""}${bad ? " bad" : ""}${isHot ? " hot" : ""}`} />
                    {!reduced && e.count > 0 && (
                      <circle r={3} className={`sm-flow${bad ? " bad" : ""}`}>
                        <animateMotion dur={`${Math.max(1.2, 4 - Math.log10(e.count + 1))}s`} repeatCount="indefinite" path={d} />
                      </circle>
                    )}
                    <text x={mid} y={(y1 + y2) / 2 - 7} textAnchor="middle" className="viz-axis sm-edge-label">
                      {e.label}
                    </text>
                  </g>
                );
              })}
              {nodes.map((n) => {
                const p = pos.get(n.id)!;
                const bad = n.errorRate > 0.01;
                return (
                  <a key={n.id} href={n.go} className={`sm-node ${n.kind}${bad ? " bad" : ""}${hot === n.id ? " hot" : ""}`} onPointerEnter={() => setHot(n.id)} onPointerLeave={() => setHot(null)}>
                    <rect x={p.x} y={p.y} width={W} height={H} rx={12} />
                    <foreignObject x={p.x + 10} y={p.y + 14} width={28} height={28}>
                      <span className="sm-icon">
                        <Icon name={ICON[n.kind]} size={24} />
                      </span>
                    </foreignObject>
                    <text x={p.x + 46} y={p.y + 23} className="sm-node-title">
                      {n.title.length > 20 ? `${n.title.slice(0, 19)}…` : n.title}
                    </text>
                    <text x={p.x + 46} y={p.y + 40} className="sm-node-sub">
                      {n.sub}
                    </text>
                    {bad && (
                      <g>
                        <rect x={p.x + W - 66} y={p.y - 10} width={64} height={18} rx={9} className="sm-badge" />
                        <text x={p.x + W - 34} y={p.y + 3} textAnchor="middle" className="sm-badge-text">
                          {pct(n.errorRate)} err
                        </text>
                      </g>
                    )}
                  </a>
                );
              })}
            </svg>
          )}
        </div>
      </Card>
    </div>
  );
}

function MapLegend() {
  return (
    <span className="sm-legend">
      <span>
        <Icon name="box" size={14} /> service
      </span>
      <span>
        <Icon name="jobs" size={14} /> queue
      </span>
      <span>
        <Icon name="data" size={14} /> database
      </span>
      <span>
        <Icon name="globe" size={14} /> external
      </span>
      <span>
        <i className="viz-swatch line" style={{ "--c": "var(--bad)" } as React.CSSProperties} /> errors above 1%
      </span>
    </span>
  );
}
