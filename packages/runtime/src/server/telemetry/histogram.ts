// Latency histograms with log-scale buckets: each bucket is 8% wider than the one before, from 10 µs up, so any percentile read from
// one is within about 4% of the exact value, at any scale, and merging two is adding counts. Sparse: { bucket index: count }.

export type Histogram = Record<number, number>;

const MIN = 0.01;
const GROWTH = 1.08;
const LOG = Math.log(GROWTH);

export const bucketOf = (ms: number) => (ms <= MIN ? 0 : Math.floor(Math.log(ms / MIN) / LOG) + 1);
const lowerOf = (i: number) => (i <= 0 ? 0 : MIN * GROWTH ** (i - 1));
const upperOf = (i: number) => MIN * GROWTH ** i;

export function record(h: Histogram, ms: number, weight = 1) {
  const i = bucketOf(ms);
  h[i] = (h[i] ?? 0) + weight;
}

export function merge(into: Histogram, from: Histogram | string | null | undefined): Histogram {
  const h = typeof from === "string" ? (JSON.parse(from) as Histogram) : from;
  if (h) for (const k in h) into[k as unknown as number] = (into[k as unknown as number] ?? 0) + h[k as unknown as number]!;
  return into;
}

const sorted = (h: Histogram) =>
  Object.keys(h)
    .map(Number)
    .sort((a, b) => a - b);

export const total = (h: Histogram) => Object.values(h).reduce((n, c) => n + c, 0);

/** The value at quantile `q` (0..1), interpolated inside its bucket on the log scale; 0 for an empty histogram. */
export function quantile(h: Histogram, q: number): number {
  const n = total(h);
  if (!n) return 0;
  const target = q * n;
  let seen = 0;
  for (const i of sorted(h)) {
    const c = h[i]!;
    if (seen + c >= target) {
      const lo = lowerOf(i);
      const hi = upperOf(i);
      const f = c ? (target - seen) / c : 0;
      return lo <= 0 ? hi * f : lo * (hi / lo) ** f;
    }
    seen += c;
  }
  return upperOf(sorted(h).at(-1)!);
}

/** How many observations were at or under `ms` (the bucket holding it counted in proportion). */
export function countUnder(h: Histogram, ms: number): number {
  const edge = bucketOf(ms);
  let n = 0;
  for (const k in h) {
    const i = Number(k);
    if (i < edge) n += h[i]!;
    else if (i === edge) {
      const lo = lowerOf(i);
      const hi = upperOf(i);
      n += h[i]! * (lo <= 0 ? ms / hi : Math.log(ms / lo) / Math.log(hi / lo));
    }
  }
  return n;
}

/** Re-bins into `edges` (ascending upper bounds, the last catching everything above): counts for a distribution chart. */
export function rebin(h: Histogram, edges: number[]): number[] {
  const out = edges.map(() => 0);
  for (const k in h) {
    const i = Number(k);
    const mid = i <= 0 ? MIN / 2 : Math.sqrt(lowerOf(i) * upperOf(i));
    const j = edges.findIndex((e) => mid <= e);
    out[j < 0 ? edges.length - 1 : j]! += h[i]!;
  }
  return out;
}
