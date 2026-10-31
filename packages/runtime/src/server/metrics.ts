import type { CacheSnapshot } from "./subscriptions";

const BUCKETS = [0.5, 1, 2.5, 5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

/** The last event-loop delay a process reported (it samples every 10 s), by its telemetry instance id. */
export type LoopDelays = Map<string, { role: string; p99: number; max: number }>;

/** Per-function call counters and latency histograms, rendered in Prometheus text format. */
export class Metrics {
  private fns = new Map<string, { calls: number; errors: number; sum: number; buckets: number[] }>();

  observe(name: string, durationMs: number, ok: boolean) {
    let m = this.fns.get(name);
    if (!m) this.fns.set(name, (m = { calls: 0, errors: 0, sum: 0, buckets: BUCKETS.map(() => 0) }));
    m.calls++;
    if (!ok) m.errors++;
    m.sum += durationMs;
    BUCKETS.forEach((b, i) => {
      if (durationMs <= b) m.buckets[i]!++;
    });
  }

  render(gauges: { subscriptions: number; connections: number; workers: number }, cache?: CacheSnapshot, loops?: LoopDelays) {
    const label = (name: string) => `function="${name.replace(/["\\\n]/g, "_")}"`;
    const lines = [
      "# HELP forge_function_calls_total Function calls.",
      "# TYPE forge_function_calls_total counter",
      ...[...this.fns].map(([n, m]) => `forge_function_calls_total{${label(n)}} ${m.calls}`),
      "# HELP forge_function_errors_total Function calls that failed.",
      "# TYPE forge_function_errors_total counter",
      ...[...this.fns].map(([n, m]) => `forge_function_errors_total{${label(n)}} ${m.errors}`),
      "# HELP forge_function_duration_ms Function call duration.",
      "# TYPE forge_function_duration_ms histogram",
      ...[...this.fns].flatMap(([n, m]) => [
        ...BUCKETS.map((b, i) => `forge_function_duration_ms_bucket{${label(n)},le="${b}"} ${m.buckets[i]}`),
        `forge_function_duration_ms_bucket{${label(n)},le="+Inf"} ${m.calls}`,
        `forge_function_duration_ms_sum{${label(n)}} ${m.sum}`,
        `forge_function_duration_ms_count{${label(n)}} ${m.calls}`,
      ]),
      ...(cache?.enabled ? cacheLines(cache, label) : []),
      "# TYPE forge_subscriptions gauge",
      `forge_subscriptions ${gauges.subscriptions}`,
      "# TYPE forge_websocket_connections gauge",
      `forge_websocket_connections ${gauges.connections}`,
      "# TYPE forge_runtime_workers gauge",
      `forge_runtime_workers ${gauges.workers}`,
      "# TYPE forge_process_resident_bytes gauge",
      `forge_process_resident_bytes ${process.memoryUsage().rss}`,
      ...(loops?.size
        ? [
            "# HELP forge_event_loop_delay_ms How late each process ran its timers over its last 10 s sample: time any request there waited on top of its own work.",
            "# TYPE forge_event_loop_delay_ms gauge",
            ...[...loops].flatMap(([p, l]) => [`forge_event_loop_delay_ms{process="${p}",role="${l.role}",stat="p99"} ${l.p99}`, `forge_event_loop_delay_ms{process="${p}",role="${l.role}",stat="max"} ${l.max}`]),
          ]
        : []),
    ];
    return lines.join("\n") + "\n";
  }
}

function cacheLines(cache: CacheSnapshot, label: (name: string) => string) {
  const counter = (name: string, help: string, key: "hits" | "misses" | "coalesced" | "skipped") => [
    `# HELP ${name} ${help}`,
    `# TYPE ${name} counter`,
    ...cache.functions.map((f) => `${name}{${label(f.name)}} ${f[key]}`),
  ];
  return [
    ...counter("forge_cache_hits_total", "Query calls answered from the result cache.", "hits"),
    ...counter("forge_cache_misses_total", "Query calls that had to run the function.", "misses"),
    ...counter("forge_cache_coalesced_total", "Query calls that shared an identical call already running.", "coalesced"),
    ...counter("forge_cache_skipped_total", "Executions whose result could not be cached.", "skipped"),
    "# TYPE forge_cache_invalidated_entries_total counter",
    `forge_cache_invalidated_entries_total ${cache.invalidatedEntries}`,
    "# TYPE forge_cache_evictions_total counter",
    `forge_cache_evictions_total ${cache.evictions}`,
    ...(cache.entries === null ? [] : ["# TYPE forge_cache_entries gauge", `forge_cache_entries ${cache.entries}`]),
    ...(cache.bytes === null ? [] : ["# TYPE forge_cache_bytes gauge", `forge_cache_bytes ${cache.bytes}`]),
  ];
}
