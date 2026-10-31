// Custom spans and metrics for forge/ code. The engine's function runtime provides them through a global (the project's copy of this
// package may not be the engine's); anywhere else (createTestBackend, a browser) spans just run their function and metrics do nothing.

export type TelemetryAttributes = Record<string, string | number | boolean>;

interface Bridge {
  span<T>(name: string, fn: () => T | Promise<T>, attrs?: TelemetryAttributes): Promise<T>;
  annotate(attrs: TelemetryAttributes, request?: boolean): void;
  metric(type: "counter" | "gauge" | "histogram", name: string, value: number, attrs?: TelemetryAttributes, unit?: string): void;
}

const bridge = () => (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.telemetry")] as Bridge | undefined;

export const trace = {
  /**
   * Runs `fn` as a span named `name` in the trace of the call it runs in. Spans inside it (queries, fetches, other spans) nest under it,
   * and the dashboard's Spans page shows its timings: `await trace.span("pricing.quote", () => quote(cart))`.
   */
  span<T>(name: string, fn: () => T | Promise<T>, attrs?: TelemetryAttributes): Promise<T> {
    const b = bridge();
    return b ? b.span(name, fn, attrs) : Promise.resolve().then(fn);
  },
  /** Adds attributes to the span that is running, or with `{ request: true }` to the request the trace is about. */
  annotate(attrs: TelemetryAttributes, opts?: { request?: boolean }) {
    bridge()?.annotate(attrs, opts?.request);
  },
};

export const metrics = {
  /** A count that only goes up, summed per minute: `metrics.counter("orders.placed").add(1, { plan: "pro" })`. */
  counter(name: string, opts?: { unit?: string }) {
    return { add: (value = 1, attrs?: TelemetryAttributes) => bridge()?.metric("counter", name, value, attrs, opts?.unit) };
  },
  /** A reading that goes up and down; the last one each minute is kept: `metrics.gauge("queue.depth").set(n)`. */
  gauge(name: string, opts?: { unit?: string }) {
    return { set: (value: number, attrs?: TelemetryAttributes) => bridge()?.metric("gauge", name, value, attrs, opts?.unit) };
  },
  /** Values whose spread matters (sizes, amounts): count, sum, min and max per minute. */
  histogram(name: string, opts?: { unit?: string }) {
    return { record: (value: number, attrs?: TelemetryAttributes) => bridge()?.metric("histogram", name, value, attrs, opts?.unit) };
  },
};
