const BUCKETS = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000];

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

  render(gauges: { subscriptions: number; connections: number; workers: number }) {
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
      "# TYPE forge_subscriptions gauge",
      `forge_subscriptions ${gauges.subscriptions}`,
      "# TYPE forge_websocket_connections gauge",
      `forge_websocket_connections ${gauges.connections}`,
      "# TYPE forge_runtime_workers gauge",
      `forge_runtime_workers ${gauges.workers}`,
      "# TYPE forge_process_resident_bytes gauge",
      `forge_process_resident_bytes ${process.memoryUsage().rss}`,
    ];
    return lines.join("\n") + "\n";
  }
}
