// Charts for the observability pages, drawn in SVG at the pixel size of their box (so text and hairlines stay crisp). One y axis per
// chart, solid hairline gridlines, 2px lines, bars of at most 24px with a 2px gap and a rounded data end; a crosshair and a tooltip on
// every time chart, a tooltip on every mark. Colors are the --viz-* and status tokens of styles.css, so both themes work.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { axisTime, count as fmtCount, fullTime, ms as fmtMs } from "./format";

/** The width of an element, kept current as it resizes; a callback ref, so it works for an element that mounts after the first render. */
export function useWidth<T extends HTMLElement>(): [(el: T | null) => void, number] {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((el: T | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    setWidth(el.clientWidth);
    observer.current = new ResizeObserver(([e]) => setWidth(Math.floor(e!.contentRect.width)));
    observer.current.observe(el);
  }, []);
  return [ref, width];
}

/** A round number at or above `v`: 1, 2, 2.5 or 5 times a power of ten. */
export function niceMax(v: number) {
  if (!(v > 0)) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  return ([1, 2, 2.5, 5, 10].find((m) => m * p >= v) ?? 10) * p;
}

// ---- tooltip ----

export type TipRow = { label: ReactNode; value: ReactNode; color?: string; dashed?: boolean };
type Tip = { x: number; y: number; title?: ReactNode; rows: TipRow[] };

function Tooltip({ tip, width }: { tip: Tip | null; width: number }) {
  if (!tip) return null;
  const left = Math.min(Math.max(tip.x + 14, 0), Math.max(0, width - 220));
  return (
    <div className="viz-tip" style={{ left, top: Math.max(0, tip.y - 10) }} role="status">
      {tip.title && <div className="viz-tip-title">{tip.title}</div>}
      {tip.rows.map((r, i) => (
        <div key={i} className="viz-tip-row">
          {r.color && <i className={`viz-key${r.dashed ? " dashed" : ""}`} style={{ "--c": r.color } as React.CSSProperties} />}
          <strong>{r.value}</strong>
          <span>{r.label}</span>
        </div>
      ))}
    </div>
  );
}

export function Legend({ items }: { items: { label: ReactNode; color: string; kind?: "bar" | "line" | "dashed" | "dot"; value?: ReactNode }[] }) {
  return (
    <span className="viz-legend">
      {items.map((it, i) => (
        <span key={i}>
          <i className={`viz-swatch ${it.kind ?? "bar"}`} style={{ "--c": it.color } as React.CSSProperties} />
          {it.label}
          {it.value !== undefined && <b>{it.value}</b>}
        </span>
      ))}
    </span>
  );
}

// ---- time series ----

export type Mark =
  | { kind: "bars"; stack: { key: string; label: string; color: string }[] }
  | { kind: "line"; key: string; label: string; color: string; dashed?: boolean; area?: boolean }
  | { kind: "lollipop"; stack: { key: string; label: string; color: string }[] };

type Row = { t: number } & Record<string, number | null | undefined>;

/**
 * Buckets over time. `step` is the bucket width; the x axis runs from the first bucket to the end of the last, with the range's start and
 * end written under it. Hovering shows every series at that bucket.
 */
export function TimeChart({
  points: given,
  step,
  marks,
  height = 150,
  format = fmtCount,
  emptyLabel = "No data in this range",
  onPick,
  unit = 1,
}: {
  /** Buckets in time order, each with `t` (its start) and a number for every key the marks name. */
  points: readonly { t: number }[];
  step: number;
  marks: Mark[];
  height?: number;
  format?: (v: number) => string;
  emptyLabel?: string;
  onPick?: (t: number) => void;
  /** Round the axis in this unit (2 ** 20 for bytes, so ticks land on whole mebibytes). */
  unit?: number;
}) {
  const points = given as Row[];
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 44, r: 8, t: 8, b: 20 };
  const n = points.length;
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const value = (p: Row, key: string) => (typeof p[key] === "number" ? (p[key] as number) : null);
  const max = useMemo(() => {
    let m = 0;
    for (const p of points)
      for (const mk of marks) {
        if (mk.kind === "line") m = Math.max(m, value(p, mk.key) ?? 0);
        else m = Math.max(m, mk.stack.reduce((s, k) => s + (value(p, k.key) ?? 0), 0));
      }
    return niceMax(m / unit) * unit;
  }, [points, marks, unit]);
  const slot = n ? plotW / n : 0;
  const x = (i: number) => pad.l + slot * (i + 0.5);
  const y = (v: number) => pad.t + plotH - (v / max) * plotH;
  // A line of zeros is data (nothing in flight); bars of zeros are nothing to show.
  const empty = !points.some((p) => marks.some((mk) => (mk.kind === "line" ? value(p, mk.key) !== null : mk.stack.some((k) => (value(p, k.key) ?? 0) > 0))));
  const barW = Math.max(1, Math.min(24, slot - 2));
  const gid = useId().replace(/:/g, "");
  const tip: Tip | null =
    hover === null || !points[hover]
      ? null
      : {
          x: x(hover),
          y: pad.t,
          title: `${fullTime(points[hover]!.t)}${step >= 120_000 ? ` – ${axisTime(points[hover]!.t + step, step * n)}` : ""}`,
          rows: marks.flatMap((mk) =>
            mk.kind === "line"
              ? [{ label: mk.label, value: value(points[hover]!, mk.key) === null ? "—" : format(value(points[hover]!, mk.key)!), color: mk.color, dashed: mk.dashed }]
              : mk.stack.map((k) => ({ label: k.label, value: format(value(points[hover]!, k.key) ?? 0), color: k.color })),
          ),
        };
  const ticks = [0, 0.5, 1];
  const inner = n > 6 ? [Math.round(n / 3), Math.round((2 * n) / 3)] : [];
  return (
    <div className="viz" ref={ref} style={{ height: height + 22 }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${marks.map((m) => (m.kind === "line" ? m.label : m.stack.map((s) => s.label).join(", "))).join("; ")} over time`}>
          <defs>
            {marks.map((mk, i) =>
              mk.kind === "line" && mk.area ? (
                <linearGradient key={i} id={`${gid}-${i}`} x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0" stopColor={mk.color} stopOpacity="0.18" />
                  <stop offset="1" stopColor={mk.color} stopOpacity="0.02" />
                </linearGradient>
              ) : null,
            )}
          </defs>
          {ticks.map((f) => (
            <g key={f}>
              <line x1={pad.l} x2={width - pad.r} y1={y(max * f)} y2={y(max * f)} className="viz-grid" />
              <text x={pad.l - 6} y={y(max * f) + 4} textAnchor="end" className="viz-axis">
                {format(max * f)}
              </text>
            </g>
          ))}
          {inner.map((i) => (
            <text key={i} x={x(i)} y={height - 4} textAnchor="middle" className="viz-axis">
              {axisTime(points[i]!.t, step * n)}
            </text>
          ))}
          {marks.map((mk, mi) => {
            if (mk.kind === "bars")
              return points.map((p, i) => {
                let base = 0;
                return (
                  <g key={`${mi}-${i}`} opacity={hover === null || hover === i ? 1 : 0.55}>
                    {mk.stack.map((k, si) => {
                      const v = value(p, k.key) ?? 0;
                      if (!v) return null;
                      const y0 = y(base);
                      base += v;
                      const y1 = y(base);
                      const h = Math.max(1, y0 - y1 - (base === v ? 0 : 2));
                      const top = mk.stack.slice(si + 1).every((s) => !(value(p, s.key) ?? 0));
                      return <path key={k.key} d={barPath(x(i) - barW / 2, y0 - (base === v ? 0 : 2) - h, barW, h, top ? Math.min(3, barW / 2) : 0)} fill={k.color} />;
                    })}
                  </g>
                );
              });
            if (mk.kind === "lollipop")
              return points.map((p, i) => {
                const total = mk.stack.reduce((s, k) => s + (value(p, k.key) ?? 0), 0);
                if (!total) return null;
                const top = [...mk.stack].reverse().find((k) => (value(p, k.key) ?? 0) > 0)!;
                return (
                  <g key={`${mi}-${i}`} opacity={hover === null || hover === i ? 1 : 0.6}>
                    <line x1={x(i)} x2={x(i)} y1={y(0)} y2={y(total)} stroke={top.color} strokeWidth={1.5} />
                    <circle cx={x(i)} cy={y(total)} r={4} fill={top.color} className="viz-ring" />
                  </g>
                );
              });
            const pts = points.map((p, i) => [i, value(p, mk.key)] as const).filter(([, v]) => v !== null) as [number, number][];
            if (!pts.length) return null;
            const d = linePath(points, mk.key, x, y);
            return (
              <g key={mi}>
                {mk.area && pts.length > 1 && <path d={`${d}L${x(pts.at(-1)![0])},${y(0)}L${x(pts[0]![0])},${y(0)}Z`} fill={`url(#${gid}-${mi})`} />}
                <path d={d} fill="none" stroke={mk.color} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" strokeDasharray={mk.dashed ? "4 4" : undefined} opacity={mk.dashed ? 0.8 : 1} />
                {pts.length === 1 && <circle cx={x(pts[0]![0])} cy={y(pts[0]![1])} r={4} fill={mk.color} className="viz-ring" />}
                {hover !== null && value(points[hover]!, mk.key) !== null && <circle cx={x(hover)} cy={y(value(points[hover]!, mk.key)!)} r={4} fill={mk.color} className="viz-ring" />}
              </g>
            );
          })}
          {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + plotH} className="viz-crosshair" />}
          <rect
            x={pad.l}
            y={pad.t}
            width={plotW}
            height={plotH}
            fill="transparent"
            style={{ cursor: onPick ? "pointer" : "crosshair" }}
            onPointerMove={(e) => {
              const box = (e.currentTarget as SVGRectElement).getBoundingClientRect();
              const i = Math.floor(((e.clientX - box.left) / box.width) * n);
              setHover(i >= 0 && i < n ? i : null);
            }}
            onPointerLeave={() => setHover(null)}
            onClick={() => hover !== null && onPick?.(points[hover]!.t)}
          />
          {empty && (
            <text x={pad.l + plotW / 2} y={pad.t + plotH / 2} textAnchor="middle" className="viz-empty">
              {emptyLabel}
            </text>
          )}
        </svg>
      )}
      {n > 0 && (
        <div className="viz-range">
          <span>{fullTime(points[0]!.t)}</span>
          <span>{fullTime(points[n - 1]!.t + step)}</span>
        </div>
      )}
      <Tooltip tip={tip} width={width} />
    </div>
  );
}

function barPath(x: number, y: number, w: number, h: number, r: number) {
  if (r <= 0 || h < r) return `M${x},${y}h${w}v${h}h${-w}Z`;
  return `M${x},${y + h}V${y + r}Q${x},${y} ${x + r},${y}H${x + w - r}Q${x + w},${y} ${x + w},${y + r}V${y + h}Z`;
}

function linePath(points: Row[], key: string, x: (i: number) => number, y: (v: number) => number) {
  let d = "";
  let pen = false;
  points.forEach((p, i) => {
    const v = p[key];
    if (typeof v !== "number") return void (pen = false);
    d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`;
    pen = true;
  });
  return d;
}

// ---- scatter: p95 against volume, both on log scales ----

export function Scatter({
  points,
  height = 230,
  xLabel,
  yLabel,
  onPick,
}: {
  points: { id: string; label: string; x: number; y: number; rate: number; sub?: string }[];
  height?: number;
  xLabel: string;
  yLabel: string;
  onPick?: (id: string) => void;
}) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const pad = { l: 52, r: 16, t: 14, b: 30 };
  const xs = points.map((p) => Math.max(p.x, 1));
  const ys = points.map((p) => Math.max(p.y, 0.01));
  const x0 = Math.log10(Math.max(1, Math.min(...xs, 1)));
  const x1 = Math.log10(Math.max(10, ...xs) * 1.4);
  const y0 = Math.log10(Math.max(0.01, Math.min(...ys, 1) / 1.5));
  const y1 = Math.log10(Math.max(10, ...ys) * 1.6);
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const sx = (v: number) => pad.l + ((Math.log10(Math.max(v, 1)) - x0) / (x1 - x0 || 1)) * plotW;
  const sy = (v: number) => pad.t + plotH - ((Math.log10(Math.max(v, 0.01)) - y0) / (y1 - y0 || 1)) * plotH;
  const decades = (a: number, b: number) => Array.from({ length: Math.floor(b) - Math.ceil(a) + 1 }, (_, i) => 10 ** (Math.ceil(a) + i));
  // Busy and slow: above the median latency and the median volume.
  const median = (vals: number[]) => [...vals].sort((a, b) => a - b)[Math.floor(vals.length / 2)] ?? 0;
  const mx = median(xs);
  const my = median(ys);
  const rateColor = (r: number) => (r >= 0.05 ? "var(--bad)" : r >= 0.01 ? "var(--warn)" : "var(--ok)");
  const labelled = new Set([...points].sort((a, b) => b.y * Math.log10(b.x + 1) - a.y * Math.log10(a.x + 1)).slice(0, 3).map((p) => p.id));
  const hovered = points.find((p) => p.id === hover);
  return (
    <div className="viz" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`${yLabel} against ${xLabel}, log scales`}>
          {points.length > 2 && <rect x={sx(mx)} y={pad.t} width={Math.max(0, pad.l + plotW - sx(mx))} height={Math.max(0, sy(my) - pad.t)} className="viz-quadrant" />}
          {points.length > 2 && (
            <text x={pad.l + plotW - 4} y={pad.t + 12} textAnchor="end" className="viz-axis upper">
              busy & slow
            </text>
          )}
          {decades(y0, y1).map((v) => (
            <g key={`y${v}`}>
              <line x1={pad.l} x2={pad.l + plotW} y1={sy(v)} y2={sy(v)} className="viz-grid" />
              <text x={pad.l - 6} y={sy(v) + 4} textAnchor="end" className="viz-axis">
                {fmtMs(v, 0)}
              </text>
            </g>
          ))}
          {decades(x0, x1).map((v) => (
            <text key={`x${v}`} x={sx(v)} y={height - 10} textAnchor="middle" className="viz-axis">
              {fmtCount(v)}
            </text>
          ))}
          <text x={pad.l} y={height - 1} className="viz-axis upper">
            {yLabel} against {xLabel} · log scales
          </text>
          {points.map((p) => (
            <g key={p.id} onPointerEnter={() => setHover(p.id)} onPointerLeave={() => setHover(null)} onClick={() => onPick?.(p.id)} style={{ cursor: onPick ? "pointer" : "default" }}>
              <circle cx={sx(p.x)} cy={sy(p.y)} r={12} fill="transparent" />
              <circle cx={sx(p.x)} cy={sy(p.y)} r={hover === p.id ? 6 : 4.5} fill={rateColor(p.rate)} className="viz-ring" />
              {labelled.has(p.id) && (
                <text x={sx(p.x) + (sx(p.x) > pad.l + plotW * 0.7 ? -9 : 9)} y={sy(p.y) + 4} textAnchor={sx(p.x) > pad.l + plotW * 0.7 ? "end" : "start"} className="viz-label">
                  {p.label.length > 28 ? `${p.label.slice(0, 27)}…` : p.label} <tspan className="viz-label-value">{fmtMs(p.y)}</tspan>
                </text>
              )}
            </g>
          ))}
        </svg>
      )}
      <Tooltip
        tip={
          hovered
            ? {
                x: sx(hovered.x),
                y: sy(hovered.y),
                title: hovered.label,
                rows: [
                  { label: yLabel, value: fmtMs(hovered.y) },
                  { label: xLabel, value: fmtCount(hovered.x) },
                  { label: "failure rate", value: `${(hovered.rate * 100).toFixed(2)}%`, color: rateColor(hovered.rate) },
                ],
              }
            : null
        }
        width={width}
      />
    </div>
  );
}

// ---- latency distribution ----

export function Distribution({ edges, counts, marks, height = 150 }: { edges: number[]; counts: number[]; marks: { label: string; value: number }[]; height?: number }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const pad = { l: 8, r: 8, t: 22, b: 22 };
  const plotW = Math.max(0, width - pad.l - pad.r);
  const plotH = height - pad.t - pad.b;
  const max = Math.max(1, ...counts);
  const n = counts.length;
  const slot = n ? plotW / n : 0;
  const top = edges.at(-1) ?? 1;
  const xOf = (v: number) => pad.l + Math.min(1, v / top) * plotW;
  const total = counts.reduce((a, b) => a + b, 0);
  return (
    <div className="viz" ref={ref} style={{ height }}>
      {width > 0 && (
        <svg width={width} height={height} role="img" aria-label={`Latency distribution: ${marks.map((m) => `${m.label} ${fmtMs(m.value)}`).join(", ")}`}>
          <line x1={pad.l} x2={pad.l + plotW} y1={pad.t + plotH} y2={pad.t + plotH} className="viz-grid" />
          {counts.map((c, i) => {
            const h = (c / max) * plotH;
            const w = Math.max(1, Math.min(24, slot - 2));
            return (
              <g key={i} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover(null)}>
                <rect x={pad.l + slot * i} y={pad.t} width={slot} height={plotH} fill="transparent" />
                {c > 0 && <path d={barPath(pad.l + slot * i + (slot - w) / 2, pad.t + plotH - Math.max(1, h), w, Math.max(1, h), Math.min(3, w / 2))} fill="var(--viz-1)" opacity={hover === null || hover === i ? 0.9 : 0.45} />}
              </g>
            );
          })}
          {marks.map((m, i) => (
            <g key={m.label}>
              <line x1={xOf(m.value)} x2={xOf(m.value)} y1={pad.t - 4} y2={pad.t + plotH} className="viz-marker" />
              <text x={xOf(m.value)} y={pad.t - 8 - (i % 2) * 0} textAnchor={xOf(m.value) > pad.l + plotW - 60 ? "end" : "middle"} className="viz-axis upper">
                {m.label} {fmtMs(m.value)}
              </text>
            </g>
          ))}
          {[0, 0.5, 1].map((f) => (
            <text key={f} x={pad.l + f * plotW} y={height - 4} textAnchor={f === 0 ? "start" : f === 1 ? "end" : "middle"} className="viz-axis">
              {f === 1 ? `≥ ${fmtMs(top)}` : fmtMs(top * f)}
            </text>
          ))}
        </svg>
      )}
      <Tooltip
        tip={
          hover === null
            ? null
            : {
                x: pad.l + slot * hover,
                y: pad.t,
                title: `${fmtMs(hover ? edges[hover - 1]! : 0)} – ${fmtMs(edges[hover]!)}`,
                rows: [
                  { label: "calls", value: fmtCount(counts[hover]!) },
                  { label: "of all", value: total ? `${((counts[hover]! / total) * 100).toFixed(1)}%` : "—" },
                ],
              }
        }
        width={width}
      />
    </div>
  );
}

// ---- weekly rhythm: day of the week against time of day ----

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

export function Heatmap({ cells, metric }: { cells: { day: number; slot: number; count: number; p95: number | null }[]; metric: "count" | "p95" }) {
  const [hover, setHover] = useState<number | null>(null);
  const values = cells.map((c) => (metric === "count" ? c.count : (c.p95 ?? 0)));
  const max = Math.max(1, ...values);
  const order = [1, 2, 3, 4, 5, 6, 0];
  const h = hover === null ? null : cells[hover];
  return (
    <div className="heat" role="img" aria-label={`Weekly ${metric === "count" ? "traffic" : "p95 latency"} by day and time of day`}>
      <div className="heat-hours">
        <span />
        {Array.from({ length: 12 }, (_, s) => (
          <span key={s}>{s % 2 === 0 ? String(s * 2).padStart(2, "0") : ""}</span>
        ))}
      </div>
      {order.map((day) => (
        <div key={day} className="heat-row">
          <span>{DAYS[day]}</span>
          {cells
            .map((c, i) => [c, i] as const)
            .filter(([c]) => c.day === day)
            .map(([c, i]) => {
              const v = metric === "count" ? c.count : (c.p95 ?? 0);
              return (
                <i
                  key={i}
                  className={hover === i ? "hot" : undefined}
                  style={{ "--a": v ? 0.12 + 0.88 * (v / max) : 0 } as React.CSSProperties}
                  onPointerEnter={() => setHover(i)}
                  onPointerLeave={() => setHover(null)}
                />
              );
            })}
        </div>
      ))}
      <div className="heat-foot">
        {h ? (
          <>
            <strong>
              {DAYS[h.day]} {String(h.slot * 2).padStart(2, "0")}–{String(h.slot * 2 + 2).padStart(2, "0")}
            </strong>{" "}
            · {fmtCount(h.count)} calls · p95 {h.p95 === null ? "—" : fmtMs(h.p95)}
          </>
        ) : (
          <span className="faint">Hover a cell · local time</span>
        )}
      </div>
    </div>
  );
}

// ---- treemap: where the time goes ----

type Tile = { id: string; label: string; sub?: string; value: number; color: string };

/** Squarified layout (Bruls, Huizing, van Wijk): tiles as close to square as their shares allow. */
function squarify(items: Tile[], x: number, y: number, w: number, h: number): (Tile & { x: number; y: number; w: number; h: number })[] {
  const total = items.reduce((s, i) => s + i.value, 0);
  if (!total || w <= 0 || h <= 0) return [];
  const scale = (w * h) / total;
  const out: (Tile & { x: number; y: number; w: number; h: number })[] = [];
  let rest = items.map((i) => ({ ...i, area: i.value * scale }));
  let box = { x, y, w, h };
  while (rest.length) {
    const short = Math.min(box.w, box.h);
    let row: typeof rest = [];
    let best = Infinity;
    for (const item of rest) {
      const next = [...row, item];
      const sum = next.reduce((s, r) => s + r.area, 0);
      const worst = Math.max(...next.map((r) => Math.max((short * short * r.area) / (sum * sum), (sum * sum) / (short * short * r.area))));
      if (worst > best) break;
      best = worst;
      row = next;
    }
    const sum = row.reduce((s, r) => s + r.area, 0);
    const thick = sum / short;
    let along = 0;
    for (const r of row) {
      const len = r.area / thick;
      out.push(box.w >= box.h ? { ...r, x: box.x, y: box.y + along, w: thick, h: len } : { ...r, x: box.x + along, y: box.y, w: len, h: thick });
      along += len;
    }
    box = box.w >= box.h ? { x: box.x + thick, y: box.y, w: box.w - thick, h: box.h } : { x: box.x, y: box.y + thick, w: box.w, h: box.h - thick };
    rest = rest.slice(row.length);
  }
  return out;
}

export function Treemap({ tiles, height = 220, onPick }: { tiles: Tile[]; height?: number; onPick?: (id: string) => void }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<string | null>(null);
  const laid = useMemo(() => squarify(tiles.filter((t) => t.value > 0), 0, 0, width, height), [tiles, width, height]);
  const total = tiles.reduce((s, t) => s + t.value, 0);
  const hovered = laid.find((t) => t.id === hover);
  return (
    <div className="viz treemap" ref={ref} style={{ height }}>
      {laid.map((t) => (
        <button
          key={t.id}
          type="button"
          className="tile"
          style={{ left: t.x, top: t.y, width: Math.max(0, t.w - 3), height: Math.max(0, t.h - 3), "--c": t.color } as React.CSSProperties}
          onPointerEnter={() => setHover(t.id)}
          onPointerLeave={() => setHover(null)}
          onClick={() => onPick?.(t.id)}
          aria-label={`${t.label}: ${((t.value / total) * 100).toFixed(0)}% of the time`}
        >
          {t.w > 70 && t.h > 38 && (
            <>
              <span className="tile-label">{t.label}</span>
              <span className="tile-value">
                {((t.value / total) * 100).toFixed(0)}
                <small>%</small> {t.w > 120 && t.sub && <em>{t.sub}</em>}
              </span>
            </>
          )}
          {!(t.w > 70 && t.h > 38) && t.w > 26 && t.h > 18 && <span className="tile-value small">{((t.value / total) * 100).toFixed(0)}%</span>}
        </button>
      ))}
      <Tooltip tip={hovered ? { x: hovered.x + hovered.w / 2, y: hovered.y + 8, title: hovered.label, rows: [{ label: "of the time", value: `${((hovered.value / total) * 100).toFixed(1)}%` }, ...(hovered.sub ? [{ label: "", value: hovered.sub }] : [])] } : null} width={width} />
    </div>
  );
}

// ---- before → after ----

export function Dumbbell({ rows, format, max }: { rows: { label: ReactNode; before: number; after: number; worse: boolean; hint?: string }[]; format: (v: number) => string; max?: number }) {
  const top = niceMax(max ?? Math.max(0.0001, ...rows.flatMap((r) => [r.before, r.after])));
  return (
    <div className="dumbbell" role="table" aria-label="Before and after">
      {rows.map((r, i) => (
        <div key={i} className="db-row" role="row">
          <span className="db-label" role="cell">
            {r.label}
          </span>
          <span className="db-track" role="cell" title={r.hint}>
            <span className={`db-bar ${r.worse ? "worse" : "better"}`} style={{ left: `${(Math.min(r.before, r.after) / top) * 100}%`, width: `${(Math.abs(r.after - r.before) / top) * 100}%` }} />
            <span className="db-before" style={{ left: `${(r.before / top) * 100}%` }} />
            <span className={`db-after ${r.worse ? "worse" : "better"}`} style={{ left: `${(r.after / top) * 100}%` }} />
            <span className="db-value" style={{ left: `${(Math.max(r.before, r.after) / top) * 100}%` }}>
              {format(r.before)} → {format(r.after)}
            </span>
          </span>
        </div>
      ))}
      <div className="db-axis" aria-hidden="true">
        <span />
        <span>
          {[0, 0.25, 0.5, 0.75, 1].map((f) => (
            <i key={f} style={{ left: `${f * 100}%` }}>
              {format(top * f)}
            </i>
          ))}
        </span>
      </div>
    </div>
  );
}

// ---- small pieces for tables and tiles ----

/** A table cell's latency: the average and p95 as text, and both as marks on a shared scale (`max`, the column's largest p95). */
export function RangeBar({ avg, p95, max, budget }: { avg: number; p95: number; max: number; budget?: number }) {
  const over = budget !== undefined && p95 > budget;
  const f = (v: number) => `${Math.min(100, (v / (max || 1)) * 100)}%`;
  return (
    <span className={`rangebar${over ? " over" : ""}`} title={budget ? `p95 ${fmtMs(p95)} · budget ${fmtMs(budget)}` : undefined}>
      <span className="rb-k">avg</span>
      <b>{fmtMs(avg)}</b>
      <span className="rb-track">
        <i className="rb-fill" style={{ width: f(p95) }} />
        <i className="rb-avg" style={{ left: f(avg) }} />
      </span>
      <span className="rb-k">p95</span>
      <b className={over ? "bad" : undefined}>{fmtMs(p95)}</b>
    </span>
  );
}

/** A failure rate as ten ticks: one lit per 10% (any failure lights the first). */
export function RateBar({ rate }: { rate: number }) {
  const lit = rate <= 0 ? 0 : Math.max(1, Math.min(10, Math.ceil(rate * 10)));
  return (
    <span className={`ratebar ${rate >= 0.05 ? "bad" : rate >= 0.01 ? "warn" : "ok"}`}>
      <b>{(rate * 100).toFixed(rate === 0 || rate >= 0.1 ? 0 : 2)}%</b>
      <span aria-hidden="true">
        {Array.from({ length: 10 }, (_, i) => (
          <i key={i} className={i < lit ? "on" : undefined} />
        ))}
      </span>
    </span>
  );
}

/** A dial for a reading out of a known maximum (CPU, memory share). */
export function Gauge({ value, max, label, format, tone }: { value: number | null; max: number; label: string; format: (v: number) => string; tone?: "ok" | "warn" | "bad" }) {
  const f = value === null ? 0 : Math.max(0, Math.min(1, value / max));
  const r = 34;
  const arc = (to: number) => {
    const a = Math.PI * (0.75 + 1.5 * to);
    return `M${40 + r * Math.cos(Math.PI * 0.75)},${40 + r * Math.sin(Math.PI * 0.75)}A${r},${r} 0 ${to > 2 / 3 ? 1 : 0} 1 ${40 + r * Math.cos(a)},${40 + r * Math.sin(a)}`;
  };
  return (
    <div className={`gauge ${tone ?? (f > 0.85 ? "bad" : f > 0.6 ? "warn" : "ok")}`}>
      <svg viewBox="0 0 80 72" width="96" height="86" role="img" aria-label={`${label}: ${value === null ? "no data" : format(value)}`}>
        <path d={arc(1)} className="gauge-track" />
        {f > 0 && <path d={arc(f)} className="gauge-fill" />}
        <text x="40" y="44" textAnchor="middle" className="gauge-value">
          {value === null ? "—" : format(value)}
        </text>
      </svg>
      <span className="gauge-label">{label}</span>
    </div>
  );
}

/** A sparkline for a row or a tile: the shape of a series, no axes. */
export function Spark({ values, color = "var(--viz-1)", height = 28, bars = false }: { values: (number | null)[]; color?: string; height?: number; bars?: boolean }) {
  const [ref, width] = useWidth<HTMLSpanElement>();
  const max = Math.max(1e-9, ...values.map((v) => v ?? 0));
  const n = values.length;
  return (
    <span className="spark" ref={ref} style={{ height }}>
      {width > 0 && n > 0 && (
        <svg width={width} height={height} aria-hidden="true">
          {bars
            ? values.map((v, i) => {
                const w = Math.max(1, width / n - 1.5);
                const h = v ? Math.max(1.5, (v / max) * (height - 2)) : 0;
                return h ? <rect key={i} x={(width / n) * i} y={height - h} width={w} height={h} rx={1} fill={color} /> : null;
              })
            : (() => {
                const pts = values.map((v, i) => `${n === 1 ? width / 2 : (i / (n - 1)) * (width - 2) + 1},${height - 2 - ((v ?? 0) / max) * (height - 4)}`);
                return (
                  <>
                    <polyline points={`1,${height} ${pts.join(" ")} ${width - 1},${height}`} fill={color} opacity={0.1} />
                    <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" />
                  </>
                );
              })()}
        </svg>
      )}
    </span>
  );
}

/** Counts up to `value` when it first appears and when it changes, quickly; respects reduced motion. */
export function useCountUp(value: number, ms = 450) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !Number.isFinite(value)) return setShown(value);
    const start = performance.now();
    const a = from.current;
    let raf = 0;
    const step = () => {
      const t = Math.min(1, (performance.now() - start) / ms);
      setShown(a + (value - a) * (1 - (1 - t) ** 3));
      if (t < 1) raf = requestAnimationFrame(step);
      else from.current = value;
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return shown;
}
