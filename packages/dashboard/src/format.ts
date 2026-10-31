// How numbers read on the dashboard: durations, counts, rates and times, short enough for a table cell.

/** 0.4 ms, 12 ms, 1.43 s, 2.1 min. */
export function ms(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  if (v < 1) return `${v.toFixed(digits ?? (v < 0.1 ? 2 : 1))} ms`;
  if (v < 100) return `${v.toFixed(digits ?? (v < 10 ? 1 : 0))} ms`;
  if (v < 1000) return `${Math.round(v)} ms`;
  if (v < 60_000) return `${(v / 1000).toFixed(digits ?? (v < 10_000 ? 2 : 1))} s`;
  if (v < 3600_000) return `${(v / 60_000).toFixed(1)} min`;
  return `${(v / 3600_000).toFixed(1)} h`;
}

/** The number and the unit apart, for a headline: ["903", "ms"]. */
export function msParts(v: number | null | undefined): [string, string] {
  const s = ms(v);
  const i = s.lastIndexOf(" ");
  return i < 0 ? [s, ""] : [s.slice(0, i), s.slice(i + 1)];
}

/** 1,284 · 12.9k · 4.2M; fractions for weighted (sampled) counts below 10. */
export function count(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${(v / 1e3).toFixed(a >= 1e5 ? 0 : 1)}k`;
  if (a < 10 && !Number.isInteger(v)) return v.toFixed(1);
  return Math.round(v).toLocaleString("en-US");
}

/** 0.52% · 12% · 100%, from a fraction. */
export function pct(v: number | null | undefined, digits?: number): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const p = v * 100;
  return `${p.toFixed(digits ?? (p === 0 || p >= 10 ? 0 : p < 1 ? 2 : 1))}%`;
}

/** Change against a previous period, as a signed percentage; null when there is nothing to compare to. */
export function delta(now: number, before: number | null | undefined): number | null {
  if (before === null || before === undefined || !Number.isFinite(before) || before === 0) return null;
  return (now - before) / before;
}

export const perMinute = (n: number, windowMs: number) => (windowMs > 0 ? n / (windowMs / 60_000) : 0);

export function ago(t: number | null | undefined): string {
  if (!t) return "never";
  const s = Math.round((Date.now() - t) / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}

const dayFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const secFmt = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fullFmt = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "2-digit", minute: "2-digit" });

/** A time on a chart axis: the time of day for ranges within a day, the date beyond. */
export const axisTime = (t: number, rangeMs: number) => (rangeMs <= 36 * 3600_000 ? timeFmt.format(t) : `${dayFmt.format(t)} ${rangeMs <= 4 * 86_400_000 ? timeFmt.format(t) : ""}`.trim());
export const clock = (t: number) => secFmt.format(t);
export const fullTime = (t: number) => fullFmt.format(t);
export const isoish = (t: number) => {
  const d = new Date(t);
  return `${d.toISOString().slice(0, 10)} ${secFmt.format(d)}.${String(d.getMilliseconds()).padStart(3, "0")}`;
};

/** The class name for a value that is good (falls) or bad (rises) as it moves. */
export const trendTone = (d: number | null, upIsGood = false) => (d === null || Math.abs(d) < 0.005 ? "flat" : d > 0 === upIsGood ? "good" : "bad");

/** "GET /users/:id" → { method: "GET", path: "/users/:id" }. */
export function splitOperation(op: string): { method?: string; path: string } {
  const m = /^(GET|POST|PUT|PATCH|DELETE|HEAD|OPTIONS)\s+(.*)$/.exec(op);
  return m ? { method: m[1], path: m[2]! } : { path: op };
}

export const plural = (n: number, one: string, many = `${one}s`) => `${count(n)} ${Math.round(n) === 1 ? one : many}`;
