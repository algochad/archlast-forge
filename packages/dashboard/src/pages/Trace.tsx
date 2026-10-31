import { useMemo, useState } from "react";
import { Icon } from "../brand";
import { ago, fullTime, isoish, ms, pct } from "../format";
import { BackLink, Callout, Card, errorHref, Facts, KindTag, OpName, opHref, StatusTag, userHref } from "../kit";
import { attrsOf, useObs, type LogRow, type RequestRow, type SpanRow } from "../obs";
import { href } from "../router";
import { Empty, ErrorNote, Segmented, Skeleton, useToast } from "../ui";

type TraceData = {
  requests: (RequestRow & { kind: string; operation: string; service: string; error_group: string | null; attrs: string | null; error: { type: string; message: string; state: string } | null })[];
  spans: SpanRow[];
  logs: LogRow[];
  typical: { count: number; avg: number; p50: number; p95: number } | null;
};

export const TYPE_COLOR: Record<string, string> = {
  request: "var(--viz-quiet)",
  function: "var(--viz-1)",
  db: "var(--viz-3)",
  http: "var(--viz-2)",
  nest: "var(--viz-4)",
  custom: "var(--viz-5)",
  job: "var(--viz-6)",
  queue: "var(--viz-6)",
  cache: "var(--viz-3)",
};
export const typeColor = (t: string) => TYPE_COLOR[t] ?? "var(--viz-quiet)";

type Node = SpanRow & { start: number; children: Node[]; depth: number };

function buildTree(spans: SpanRow[]) {
  const t0 = Math.min(...spans.map((s) => Number(s.time)));
  const nodes = new Map<string, Node>(spans.map((s) => [s.span_id, { ...s, start: Number(s.time) - t0, children: [], depth: 0 }]));
  const roots: Node[] = [];
  for (const n of nodes.values()) {
    const parent = n.parent_id ? nodes.get(n.parent_id) : undefined;
    if (parent) parent.children.push(n);
    else roots.push(n);
  }
  const order: Node[] = [];
  const walk = (n: Node, depth: number) => {
    n.depth = depth;
    n.children.sort((a, b) => a.start - b.start);
    order.push(n);
    for (const c of n.children) walk(c, depth + 1);
  };
  roots.sort((a, b) => a.start - b.start).forEach((r) => walk(r, 0));
  const end = Math.max(...[...nodes.values()].map((n) => n.start + Number(n.duration)));
  return { t0, roots, order, end, nodes };
}

/** The spans that decided how long the request took: from the root, the child that finished last, and so on down. */
function criticalPath(roots: Node[]) {
  const path = new Set<string>();
  let n: Node | undefined = roots[0];
  while (n) {
    path.add(n.span_id);
    n = [...n.children].sort((a, b) => b.start + Number(b.duration) - (a.start + Number(a.duration)))[0];
  }
  return path;
}

/** Sibling spans with the same name, one after another, five or more: a query in a loop (N+1). */
function repeated(order: Node[]) {
  const found: { name: string; count: number; total: number; parent: string; sql?: string }[] = [];
  for (const n of order) {
    const groups = new Map<string, Node[]>();
    for (const c of n.children) {
      if (c.type !== "db" && c.type !== "http") continue;
      const sql = String(attrsOf(c.attrs)["db.query.text"] ?? "");
      const key = `${c.name}\u0000${sql}`;
      (groups.get(key) ?? groups.set(key, []).get(key)!).push(c);
    }
    for (const [key, list] of groups) {
      if (list.length < 5) continue;
      // Back to back: mostly not overlapping one another.
      let overlaps = 0;
      for (let i = 1; i < list.length; i++) if (list[i]!.start < list[i - 1]!.start + Number(list[i - 1]!.duration) - 0.05) overlaps++;
      if (overlaps > list.length / 2) continue;
      found.push({ name: list[0]!.name, count: list.length, total: list.reduce((s, c) => s + Number(c.duration), 0), parent: n.name, sql: key.split("\u0000")[1] || undefined });
    }
  }
  return found.sort((a, b) => b.total - a.total);
}

export function TraceView({ id }: { id: string }) {
  const t = useObs<TraceData>("trace", { traceId: id }, { range: false, live: false });
  const [view, setView] = useState<"waterfall" | "flame">("waterfall");
  const [critical, setCritical] = useState(true);
  const toast = useToast();
  const tree = useMemo(() => (t.data?.spans.length ? buildTree(t.data.spans) : null), [t.data]);
  if (!id) return <Empty icon="trace">No trace id.</Empty>;
  if (t.loading && !t.data) return <Skeleton rows={10} />;
  if (!t.data) return <ErrorNote error={t.error} />;
  const root = t.data.requests[0];
  if (!root && !t.data.spans.length) return <Empty icon="trace">This trace isn't stored: it may be older than the retention, or wasn't kept by sampling.</Empty>;
  const total = tree?.end ?? Number(root?.duration ?? 0);
  const path = tree && critical ? criticalPath(tree.roots) : new Set<string>();
  const loops = tree ? repeated(tree.order) : [];
  const typical = t.data.typical;
  const kind = root?.kind ?? "query";
  return (
    <div className="obs-page">
      {root && <BackLink to={opHref(kind, root.operation)}>{root.operation}</BackLink>}
      <Card
        title={root ? <OpName operation={root.operation} kind={kind} /> : "Trace"}
        className="flush"
        extra={
          <button className="btn ghost" onClick={() => navigator.clipboard?.writeText(id).then(() => toast("Trace id copied"))}>
            <Icon name="copy" size={14} /> {id.slice(0, 16)}…
          </button>
        }
      >
        {root ? (
          <Facts
            items={[
              { label: "Duration", value: ms(Number(root.duration)) },
              { label: "Status", value: <StatusTag status={Number(root.status)} /> },
              { label: "Kind", value: <><KindTag kind={kind} /> {root.method && <span className="muted mono small">{root.method}</span>}</> },
              { label: "User", value: root.user_id ? <a className="plain-link" href={userHref(root.user_id)}>{root.user_name ?? root.user_id}</a> : "anonymous" },
              { label: "Service", value: root.service },
              { label: "Called at", value: <span title={isoish(Number(root.time))}>{fullTime(Number(root.time))} · {ago(Number(root.time))}</span> },
              { label: "Release", value: root.release ?? "—" },
              { label: "Cache", value: root.cache ?? "—" },
              { label: "Spans", value: `${t.data.spans.length}${Number(root.weight) > 1 ? ` · sampled ×${Number(root.weight).toFixed(0)}` : ""}` },
            ]}
          />
        ) : (
          <p className="empty-inline">Spans of this trace arrived without the request that started them.</p>
        )}
      </Card>
      {root?.error && (
        <Callout tone={Number(root.status) >= 500 ? "bad" : "warn"} icon="errors" title={`${root.error.type}: ${root.error.message}`} actions={root.error_group && <a className="btn ghost" href={errorHref(root.error_group)}>Open the issue</a>}>
          This request failed with {root.status}.
        </Callout>
      )}
      {root && typical && typical.count > 1 && <Compared duration={Number(root.duration)} typical={typical} />}
      {loops.map((l) => (
        <Callout key={l.name + l.parent} tone="warn" icon="spans" title={<>Repeated span: <code>{l.name}</code> ran {l.count} times back to back</>}>
          {ms(l.total)} of this request's {ms(total)} ({pct(l.total / Math.max(1, total))}), {ms(l.total / l.count)} per call, all from <code>{l.parent}</code>. One call per item instead of one for the set: read
          them in one query (an index range or <code>include</code>) or fetch them together, and this request saves about {ms(l.total - l.total / l.count)}.
        </Callout>
      ))}
      {tree && (
        <Card
          title={<>Spans <span className="badge">{t.data.spans.length}</span></>}
          className="flush"
          extra={
            <>
              <Segmented label="View" value={view} onChange={setView} options={[{ value: "waterfall", label: "Waterfall" }, { value: "flame", label: "Flame" }]} />
              {view === "waterfall" && (
                <label className="check-inline">
                  <input type="checkbox" checked={critical} onChange={(e) => setCritical(e.target.checked)} /> Critical path
                </label>
              )}
            </>
          }
          footer={<span>Bars sit on the request's clock: the left edge is when a span started, its width how long it ran. Children that overlap ran at the same time.</span>}
        >
          {view === "waterfall" ? <Waterfall tree={tree} total={total} critical={path} /> : <Flame tree={tree} total={total} />}
        </Card>
      )}
      <div className="grid-2">
        <TraceLogs logs={t.data.logs} t0={tree?.t0 ?? Number(root?.time ?? 0)} />
        {tree && <SelfTime spans={t.data.spans} />}
      </div>
    </div>
  );
}

function Compared({ duration, typical }: { duration: number; typical: { avg: number; p50: number; p95: number; count: number } }) {
  const top = Math.max(duration, typical.p95) * 1.15;
  const at = (v: number) => `${Math.min(100, (v / top) * 100)}%`;
  const verdict = duration > typical.p95 ? "slower than 95% of calls" : duration < typical.p50 ? "faster than the median" : "typical";
  return (
    <Card title={<>Compared to other calls <span className="badge">{typical.count} in the hour around it</span></>} extra={<span className={`badge ${duration > typical.p95 ? "bad" : "ok"}`}>{verdict}</span>}>
      <div className="compare">
        <div className="compare-track">
          <i className="compare-fill" style={{ width: at(typical.p95) }} />
          <span className="compare-mark" style={{ left: at(typical.avg) }}>
            <b>avg</b> {ms(typical.avg)}
          </span>
          <span className="compare-mark upper" style={{ left: at(typical.p95) }}>
            <b>p95</b> {ms(typical.p95)}
          </span>
          <span className={`compare-this ${duration > typical.p95 ? "bad" : ""}${duration / top < 0.12 ? " start" : duration / top > 0.88 ? " end" : ""}`} style={{ left: at(duration) }}>
            <i />
            <span>
              {ms(duration)} <small>this call</small>
            </span>
          </span>
        </div>
      </div>
    </Card>
  );
}

function Waterfall({ tree, total, critical }: { tree: ReturnType<typeof buildTree>; total: number; critical: Set<string> }) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const hidden = new Set<string>();
  for (const n of tree.order) if (closed.has(n.span_id) || (n.parent_id && hidden.has(n.parent_id))) for (const c of n.children) hidden.add(c.span_id);
  const ticks = [0, 0.25, 0.5, 0.75, 1];
  const at = (v: number) => `${(v / Math.max(total, 0.001)) * 100}%`;
  return (
    <div className="waterfall" role="tree" aria-label="Spans">
      <div className="wf-head">
        <span style={{ paddingLeft: "0.9rem" }}>Span</span>
        <span className="wf-ticks">
          {ticks.map((f) => (
            <span key={f} style={{ left: `${f * 100}%` }} className={f === 0 ? "first" : f === 1 ? "last" : undefined}>
              {f === 0 ? "0" : ms(total * f)}
            </span>
          ))}
        </span>
        <span style={{ textAlign: "right", paddingRight: "0.75rem" }}>Duration</span>
      </div>
      {tree.order
        .filter((n) => !hidden.has(n.span_id))
        .map((n) => {
          const a = attrsOf(n.attrs);
          return (
            <div key={n.span_id} role="treeitem" aria-expanded={n.children.length ? !closed.has(n.span_id) : undefined}>
              <div className={`wf-row${open === n.span_id ? " selected" : ""}${critical.size && !critical.has(n.span_id) ? " dim" : ""}`} onClick={() => setOpen(open === n.span_id ? null : n.span_id)}>
                <span className="wf-name" style={{ paddingLeft: `${0.5 + n.depth * 1}rem` }}>
                  <button
                    type="button"
                    className="twisty"
                    disabled={!n.children.length}
                    aria-label={closed.has(n.span_id) ? "Expand" : "Collapse"}
                    onClick={(e) => {
                      e.stopPropagation();
                      const next = new Set(closed);
                      if (next.has(n.span_id)) next.delete(n.span_id);
                      else next.add(n.span_id);
                      setClosed(next);
                    }}
                  >
                    <Icon name={closed.has(n.span_id) ? "chevron-right" : "chevron-down"} size={12} />
                  </button>
                  <span className="wf-type" style={{ "--c": typeColor(n.type) } as React.CSSProperties}>
                    {n.type === "request" ? (a["forge.kind"] ?? "request") : n.type}
                  </span>
                  <code title={n.name}>{n.name}</code>
                  {n.status === 2 && <Icon name="errors" size={13} className="bad" />}
                </span>
                <span className="wf-bars">
                  {ticks.slice(1, -1).map((f) => (
                    <i key={f} className="gridline" style={{ left: `${f * 100}%` }} />
                  ))}
                  <i
                    className={`wf-bar${n.status === 2 ? " error" : ""}${critical.has(n.span_id) && critical.size > 1 ? " critical" : ""}`}
                    style={{ left: at(n.start), width: at(Number(n.duration)), "--c": typeColor(n.type) } as React.CSSProperties}
                    title={`${n.name}: ${ms(Number(n.duration))} at +${ms(n.start)}`}
                  />
                </span>
                <span className="wf-dur">
                  {ms(Number(n.duration))}
                  <small>{pct(Number(n.duration) / Math.max(total, 0.001), 0)}</small>
                </span>
              </div>
              {open === n.span_id && <SpanDetail span={n} />}
            </div>
          );
        })}
    </div>
  );
}

function SpanDetail({ span }: { span: Node }) {
  const a = attrsOf(span.attrs);
  const sql = a["db.query.text"];
  return (
    <div className="span-detail">
      <dl className="attr-grid">
        <dt>started</dt>
        <dd>+{ms(span.start)}</dd>
        <dt>duration</dt>
        <dd>
          {ms(Number(span.duration))}
          {span.self !== null && ` (own ${ms(Number(span.self))})`}
        </dd>
        <dt>service</dt>
        <dd>{span.service}</dd>
        {span.error && (
          <>
            <dt>error</dt>
            <dd className="bad">{span.error}</dd>
          </>
        )}
        {Object.entries(a)
          .filter(([k]) => k !== "db.query.text")
          .map(([k, v]) => (
            <div key={k} style={{ display: "contents" }}>
              <dt>{k}</dt>
              <dd>{String(v)}</dd>
            </div>
          ))}
      </dl>
      {sql && <pre className="json">{String(sql)}</pre>}
    </div>
  );
}

function Flame({ tree, total }: { tree: ReturnType<typeof buildTree>; total: number }) {
  const depth = Math.max(...tree.order.map((n) => n.depth)) + 1;
  return (
    <div className="flame" style={{ height: depth * 24 + 12, margin: "0.75rem 1rem" }}>
      {tree.order.map((n) => (
        <div
          key={n.span_id}
          className={`flame-node${n.status === 2 ? " error" : ""}`}
          title={`${n.name} · ${ms(Number(n.duration))}`}
          style={{ left: `${(n.start / Math.max(total, 0.001)) * 100}%`, width: `max(2px, ${(Number(n.duration) / Math.max(total, 0.001)) * 100}%)`, top: n.depth * 24, "--c": typeColor(n.type) } as React.CSSProperties}
        >
          {n.name}
        </div>
      ))}
    </div>
  );
}

function TraceLogs({ logs, t0 }: { logs: LogRow[]; t0: number }) {
  const [level, setLevel] = useState("all");
  const shown = logs.filter((l) => level === "all" || l.level === level);
  const levels = [...new Set(logs.map((l) => l.level))];
  return (
    <Card title={<>Logs <span className="badge">{logs.length}</span></>} className="flush" extra={levels.length > 1 && <Segmented label="Level" value={level} onChange={setLevel} options={[{ value: "all", label: "All" }, ...levels.map((l) => ({ value: l, label: l }))]} />}>
      {shown.length ? (
        <table className="obs-table log-table">
          <tbody>
            {shown.map((l) => (
              <tr key={l.id} className={`log-row ${l.level}`}>
                <td className="mono faint nowrap">+{ms(Number(l.time) - t0, 0)}</td>
                <td>
                  <span className={`log-level ${l.level}`}>{l.level}</span>
                </td>
                <td className="mono small nowrap">{l.name}</td>
                <td className="msg mono">{l.message}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : (
        <p className="empty-inline">No log lines in this request.</p>
      )}
    </Card>
  );
}

function SelfTime({ spans }: { spans: SpanRow[] }) {
  const rows = Object.values(
    spans.reduce<Record<string, { name: string; type: string; count: number; self: number; total: number }>>((acc, s) => {
      const k = `${s.type}\u0000${s.name}`;
      const e = (acc[k] ??= { name: s.name, type: s.type, count: 0, self: 0, total: 0 });
      e.count++;
      e.self += Number(s.self ?? s.duration);
      e.total += Number(s.duration);
      return acc;
    }, {}),
  ).sort((a, b) => b.self - a.self);
  const all = rows.reduce((s, r) => s + r.self, 0);
  return (
    <Card title="Own time" className="flush" footer={<span>Own time is a span's duration minus what its children took: where this request actually spent its time.</span>}>
      <table className="obs-table">
        <thead>
          <tr>
            <th scope="col">Span</th>
            <th scope="col">Own %</th>
            <th scope="col" className="num">
              Own
            </th>
            <th scope="col" className="num">
              Total
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.slice(0, 12).map((r) => (
            <tr key={r.type + r.name}>
              <td>
                <span className="op-name">
                  <span className="wf-type" style={{ "--c": typeColor(r.type) } as React.CSSProperties}>
                    {r.type}
                  </span>
                  <code>{r.name}</code>
                  {r.count > 1 && <span className="faint mono small">×{r.count}</span>}
                </span>
              </td>
              <td>
                <span className="share">
                  <i style={{ width: `${(r.self / Math.max(all, 0.001)) * 100}%` }} />
                  <b>{pct(r.self / Math.max(all, 0.001))}</b>
                </span>
              </td>
              <td className="num mono">{ms(r.self)}</td>
              <td className="num mono">{ms(r.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Card>
  );
}

