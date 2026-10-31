// The observability pages' shared state and data: one time range and service for every page (kept between visits), live refresh,
// and a hook that keeps showing the last answer while it fetches the next, so charts never flash empty.
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get } from "./api";

export const PRESETS = { "1h": 3600_000, "24h": 86_400_000, "3d": 3 * 86_400_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 } as const;
export type Preset = keyof typeof PRESETS;

export interface RangeState {
  preset: Preset | "custom";
  /** For a custom range. */
  from?: number;
  to?: number;
  live: boolean;
  service?: string;
}

interface RangeContextValue extends RangeState {
  set(patch: Partial<RangeState>): void;
  /** The range as of now: live ranges end now. */
  resolve(): { from: number; to: number; service?: string };
  /** A counter that moves on every live tick, for pages to refetch on. */
  tick: number;
}

const RangeContext = createContext<RangeContextValue | null>(null);
const KEY = "afx:range";

const load = (): RangeState => {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? "null") as RangeState | null;
    if (s && (s.preset === "custom" || s.preset in PRESETS)) return s;
  } catch {}
  return { preset: "1h", live: true };
};

/** How often a live page refreshes: often for an hour's view, less for a month's. */
export const refreshEvery = (rangeMs: number) => (rangeMs <= 3600_000 ? 5000 : rangeMs <= 86_400_000 ? 15_000 : 60_000);

export function RangeProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<RangeState>(load);
  const [tick, setTick] = useState(0);
  const set = useCallback((patch: Partial<RangeState>) => {
    setState((s) => {
      const next = { ...s, ...patch };
      try {
        localStorage.setItem(KEY, JSON.stringify(next));
      } catch {}
      return next;
    });
  }, []);
  const width = state.preset === "custom" ? (state.to ?? Date.now()) - (state.from ?? Date.now() - 3600_000) : PRESETS[state.preset];
  useEffect(() => {
    if (!state.live || state.preset === "custom") return;
    const t = setInterval(() => document.visibilityState === "visible" && setTick((n) => n + 1), refreshEvery(width));
    return () => clearInterval(t);
  }, [state.live, state.preset, width]);
  const value = useMemo<RangeContextValue>(
    () => ({
      ...state,
      tick,
      set,
      resolve: () => {
        if (state.preset === "custom") return { from: state.from ?? Date.now() - 3600_000, to: state.to ?? Date.now(), service: state.service };
        // A live range ends a little after now, so the minute in progress is in it.
        const to = Date.now() + (state.live ? 30_000 : 0);
        return { from: to - PRESETS[state.preset] - (state.live ? 30_000 : 0), to, service: state.service };
      },
    }),
    [state, tick, set],
  );
  return <RangeContext.Provider value={value}>{children}</RangeContext.Provider>;
}

export function useRange() {
  const r = useContext(RangeContext);
  if (!r) throw new Error("useRange outside RangeProvider");
  return r;
}

/** Whether the server records telemetry: with TELEMETRY=off every `obs.*` call fails, so pages say so instead of asking. */
export const TelemetryOn = createContext(true);
export const useTelemetryOn = () => useContext(TelemetryOn);
export const TELEMETRY_OFF = "Telemetry is off (TELEMETRY=off)";

export interface ObsState<T> {
  data?: T;
  error?: string;
  /** The first load, with nothing to show yet. */
  loading: boolean;
  /** Fetching again with the last answer still shown. */
  refreshing: boolean;
  reload(): void;
}

/**
 * Reads `obs.<op>` with the page's range and service merged into `args`. Refetches when they change and on every live tick; the previous
 * answer stays until the next one arrives. `args: null` skips the call (a detail view with nothing picked yet).
 */
export function useObs<T>(op: string, args: Record<string, unknown> | null = {}, opts: { range?: boolean; live?: boolean } = {}): ObsState<T> {
  const range = useRange();
  const on = useTelemetryOn();
  const [state, setState] = useState<{ data?: T; error?: string; loading: boolean; refreshing: boolean }>({ loading: true, refreshing: false });
  const seq = useRef(0);
  const key = JSON.stringify(args);
  const withRange = opts.range !== false;
  const load = useCallback(async () => {
    if (!on) return setState({ error: TELEMETRY_OFF, loading: false, refreshing: false });
    if (args === null) return setState({ loading: false, refreshing: false });
    const mine = ++seq.current;
    setState((s) => ({ ...s, refreshing: s.data !== undefined, loading: s.data === undefined }));
    try {
      const r = withRange ? range.resolve() : {};
      const data = await get<T>(`obs.${op}`, { ...r, ...args });
      if (mine === seq.current) setState({ data, loading: false, refreshing: false });
    } catch (e) {
      if (mine === seq.current) setState((s) => ({ ...s, error: (e as Error).message, loading: false, refreshing: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [op, key, withRange, range.preset, range.from, range.to, range.service, range.live, on]);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    if (on && opts.live !== false && range.tick) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [range.tick]);
  return { ...state, reload: load };
}

// ---- what the store answers (packages/runtime/src/server/telemetry/queries.ts) ----

export interface Point {
  t: number;
  count: number;
  errors: number;
  clientErrors: number;
  ok: number;
  avg: number | null;
  p95: number | null;
  max: number | null;
}

export interface Stats {
  count: number;
  errors: number;
  clientErrors: number;
  cached: number;
  avg: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  apdex: number | null;
}

export interface Operation extends Stats {
  kind: string;
  operation: string;
  impact: number;
  reason: string;
  lastSeen: number;
  threshold: number;
}

export interface ReleaseImpact {
  service: string;
  version: string;
  at: number;
  verdict: "regression" | "improvement" | "stable" | "early" | "quiet";
  complete: boolean;
  before: { count: number; errorRate: number; avg: number; p95: number };
  after: { count: number; errorRate: number; avg: number; p95: number };
  operations: { operation: string; kind: string; before: { count: number; errorRate: number; p95: number; avg: number }; after: { count: number; errorRate: number; p95: number; avg: number } }[];
  changes: { type: string; name: string; isNew: boolean; calls: number; callsBefore: number; msPerRequest: number; msPerRequestBefore: number; delta: number }[];
  lastSeen?: number;
}

export interface Overview {
  step: number;
  requests: Stats & { previous: number; series: Point[] };
  all: Stats & { previous: number };
  outliers: { kind: string; operation: string; p95: number; count: number; threshold: number; ratio: number }[];
  throughput: { kind: string; operation: string; count: number; share: number }[];
  code: { total: number; items: { namespace: string; type: string; self: number; count: number; share: number }[] };
  errors: { unhandled: number; handled: number; rate: number; rateWithHandled: number; series: { t: number; unhandled: number; handled: number }[] };
  issues: { fingerprint: string; type: string; message: string; count: number; users: number; last: number; status: number; handled: boolean; state: string }[];
  jobs: Stats & { previous: number; series: Point[] };
  release: ReleaseImpact | null;
}

export interface RequestRow {
  trace_id: string;
  span_id: string;
  time: number;
  duration: number;
  status: number;
  user_id: string | null;
  user_name: string | null;
  error_message: string | null;
  handled: number | null;
  cache: string | null;
  method: string | null;
  release: string | null;
  weight: number;
  queue_wait: number | null;
  span_count: number;
  instance: string | null;
  kind?: string;
  operation?: string;
  error_group?: string | null;
}

export interface SpanRow {
  trace_id: string;
  span_id: string;
  parent_id: string | null;
  time: number;
  duration: number;
  self: number | null;
  service: string;
  name: string;
  type: string;
  kind: number | null;
  status: number | null;
  error: string | null;
  attrs: string | null;
}

export interface LogRow {
  id: number;
  time: number;
  service: string;
  instance: string | null;
  level: string;
  name: string;
  message: string;
  trace_id: string | null;
  span_id: string | null;
  attrs: string | null;
}

export const attrsOf = (raw: string | null | undefined): Record<string, string | number | boolean> => {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
};
