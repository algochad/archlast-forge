// Custom metrics from the app's code (`metrics.counter("orders.placed").add(1)`), aggregated per minute in the process that records
// them and sent to the server every few seconds. A point is replaced, not added to, when it is sent again: each process owns its rows.
import type { MetricPoint } from "./types";

type Kind = MetricPoint["type"];
type Point = Omit<MetricPoint, "service" | "instance">;

const canonical = (attrs?: Record<string, unknown>) => {
  if (!attrs) return "{}";
  const keys = Object.keys(attrs).sort();
  return JSON.stringify(Object.fromEntries(keys.map((k) => [k, attrs[k]])));
};

const NAME = /^[A-Za-z][\w./-]{0,127}$/;
/** Distinct attribute sets per metric and minute; past it, new ones fold into one "{}" point instead of growing without bound. */
const MAX_SERIES = 200;

export class MetricAggregator {
  private points = new Map<string, Point>();
  private series = new Map<string, Set<string>>();
  /** Points changed since the last drain. */
  private dirty = new Set<string>();

  record(type: Kind, name: string, value: number, attrs?: Record<string, unknown>, unit?: string) {
    if (!NAME.test(name)) throw new Error(`Metric names start with a letter and use letters, digits, ".", "_", "-" or "/" (got "${name}")`);
    if (!Number.isFinite(value)) throw new Error(`Metric ${name}: value must be a finite number`);
    const minute = Math.floor(Date.now() / 60_000);
    let a = canonical(attrs);
    const seen = this.series.get(`${minute}|${name}`) ?? new Set<string>();
    if (!seen.has(a) && seen.size >= MAX_SERIES) a = "{}";
    seen.add(a);
    this.series.set(`${minute}|${name}`, seen);
    const key = `${minute}|${name}|${a}`;
    let p = this.points.get(key);
    if (p && p.type !== type) throw new Error(`Metric ${name} is a ${p.type}, not a ${type}`);
    if (!p) this.points.set(key, (p = { minute, name, type, unit, attrs: a, value: 0, count: 0, min: value, max: value }));
    p.count++;
    p.min = Math.min(p.min, value);
    p.max = Math.max(p.max, value);
    p.value = type === "gauge" ? value : p.value + value;
    this.dirty.add(key);
  }

  /** The points that changed since last time, as they are now; minutes that are over are forgotten once sent. */
  drain(): Point[] {
    const out = [...this.dirty].map((k) => this.points.get(k)!).filter(Boolean);
    this.dirty.clear();
    const current = Math.floor(Date.now() / 60_000);
    for (const [k, p] of this.points) if (p.minute < current - 1) this.points.delete(k);
    for (const k of this.series.keys()) if (Number(k.split("|")[0]) < current - 1) this.series.delete(k);
    return out.map((p) => ({ ...p }));
  }
}
