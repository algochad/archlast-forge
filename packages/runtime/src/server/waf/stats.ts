// What the WAF has done, kept in memory for the dashboard and /metrics: counters, a per-minute timeline, which rules, paths and clients
// matched most, how long inspecting takes, and the latest events. It all starts at zero with the process (the log and metrics are the record
// that outlives it) and is bounded: a flood of different paths or addresses can't grow it.
import { quantile, record, total, type Histogram } from "../telemetry/histogram";
import { isFinding, scoreOf } from "./engine";
import type { MatchedRule } from "./transaction";

export type EventAction = "blocked" | "detected" | "error";

export interface WafEvent {
  id: number;
  at: number;
  action: EventAction;
  requestId: string;
  method: string;
  /** The path only: the query string may hold a token. */
  path: string;
  ip: string;
  /** The rules that looked for something and matched; empty when the WAF failed. */
  rules: { id: number; message: string }[];
  /** What the matches add up to (CRS stops a request at 5). */
  score: number;
  /** Set when the WAF couldn't inspect the request. */
  error?: string;
  /** What inspecting took, in milliseconds. */
  ms: number;
}

export interface Counters {
  /** Requests the rules looked at. */
  inspected: number;
  blocked: number;
  detected: number;
  /** Requests the WAF couldn't inspect. */
  errors: number;
}

type Minute = { t: number; inspected: number; blocked: number; detected: number; errors: number };
type Tally = { key: string; count: number; blocked: number; detected: number };

const EVENTS = 300;
const KEEP_MINUTES = 24 * 60;
const MAX_KEYS = 500;

/** Counts per key, bounded: past `MAX_KEYS` the quietest quarter is forgotten. */
class Tallies {
  private by = new Map<string, Tally>();
  bump(key: string, action: EventAction) {
    let t = this.by.get(key);
    if (!t) {
      if (this.by.size >= MAX_KEYS) this.prune();
      this.by.set(key, (t = { key, count: 0, blocked: 0, detected: 0 }));
    }
    t.count++;
    if (action === "blocked") t.blocked++;
    else if (action === "detected") t.detected++;
  }
  private prune() {
    const sorted = [...this.by.values()].sort((a, b) => a.count - b.count);
    for (const t of sorted.slice(0, MAX_KEYS / 4)) this.by.delete(t.key);
  }
  top(n: number): Tally[] {
    return [...this.by.values()].sort((a, b) => b.count - a.count).slice(0, n);
  }
  get(key: string) {
    return this.by.get(key);
  }
}

export class WafStats {
  readonly counters: Counters = { inspected: 0, blocked: 0, detected: 0, errors: 0 };
  /** Since when these numbers count. */
  readonly since = Date.now();
  private latency: Histogram = {};
  private maxMs = 0;
  private sumMs = 0;
  private minutes = new Map<number, Minute>();
  private events: WafEvent[] = [];
  private seq = 0;
  private rules = new Tallies();
  private ruleNames = new Map<number, string>();
  private paths = new Tallies();
  private ips = new Tallies();

  private minute(now = Date.now()): Minute {
    const t = now - (now % 60_000);
    let m = this.minutes.get(t);
    if (!m) {
      m = { t, inspected: 0, blocked: 0, detected: 0, errors: 0 };
      this.minutes.set(t, m);
      for (const old of this.minutes.keys()) if (old < t - KEEP_MINUTES * 60_000) this.minutes.delete(old);
    }
    return m;
  }

  /** A request the rules looked at and found nothing in. */
  allowed(ms: number) {
    this.counters.inspected++;
    this.minute().inspected++;
    this.time(ms);
  }

  /** A request the rules matched (blocked, or only flagged in detect mode), or that couldn't be inspected. */
  flagged(action: EventAction, o: { requestId: string; method: string; path: string; ip: string; rules?: MatchedRule[]; error?: string; ms: number }): WafEvent {
    const m = this.minute();
    const key = action === "blocked" ? "blocked" : action === "detected" ? "detected" : "errors";
    this.counters[key]++;
    m[key]++;
    if (action !== "error") {
      this.counters.inspected++;
      m.inspected++;
      this.time(o.ms);
    }
    const findings = (o.rules ?? []).filter(isFinding);
    for (const r of findings) {
      this.rules.bump(String(r.id), action);
      this.ruleNames.set(r.id, r.message);
    }
    const path = o.path.slice(0, 200);
    this.paths.bump(path, action);
    this.ips.bump(o.ip, action);
    const event: WafEvent = {
      id: ++this.seq,
      at: Date.now(),
      action,
      requestId: o.requestId,
      method: o.method,
      path,
      ip: o.ip,
      rules: findings.map((r) => ({ id: r.id, message: r.message })),
      score: scoreOf(o.rules ?? []),
      ...(o.error && { error: o.error }),
      ms: o.ms,
    };
    this.events.push(event);
    if (this.events.length > EVENTS) this.events.shift();
    return event;
  }

  private time(ms: number) {
    record(this.latency, ms);
    this.sumMs += ms;
    if (ms > this.maxMs) this.maxMs = ms;
  }

  /** How many requests each rule matched, for /metrics. */
  ruleCounts(): { id: number; count: number }[] {
    return this.rules.top(100).map((t) => ({ id: Number(t.key), count: t.count }));
  }

  snapshot(minutes = 60) {
    const span = Math.min(Math.max(Math.floor(minutes) || 60, 1), KEEP_MINUTES);
    const end = this.minute().t;
    const timeline: Minute[] = [];
    for (let t = end - (span - 1) * 60_000; t <= end; t += 60_000) timeline.push(this.minutes.get(t) ?? { t, inspected: 0, blocked: 0, detected: 0, errors: 0 });
    const n = total(this.latency);
    return {
      since: this.since,
      counters: { ...this.counters },
      latency: { avg: n ? this.sumMs / n : 0, p50: quantile(this.latency, 0.5), p95: quantile(this.latency, 0.95), p99: quantile(this.latency, 0.99), max: this.maxMs },
      timeline,
      rules: this.rules.top(50).map((t) => ({ id: Number(t.key), message: this.ruleNames.get(Number(t.key)) ?? "", count: t.count, blocked: t.blocked, detected: t.detected })),
      paths: this.paths.top(20).map(({ key, ...rest }) => ({ path: key, ...rest })),
      ips: this.ips.top(20).map(({ key, ...rest }) => ({ ip: key, ...rest })),
      events: [...this.events].reverse().slice(0, 150),
    };
  }
}
