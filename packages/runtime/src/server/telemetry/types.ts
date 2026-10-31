// What the engine records about the work it does, in the shape the telemetry store keeps it. Spans follow OpenTelemetry's model
// (trace id, span id, parent, kind, status, attributes), so the engine's own spans and spans from other services sent over OTLP are one thing.

/** What a span measures, for grouping in the dashboard. A request or job is the root of its trace; the rest happen inside one. */
export type SpanType = "request" | "function" | "db" | "http" | "nest" | "custom" | "job" | "queue" | "cache" | "other";

/** OpenTelemetry's SpanKind numbers. */
export const SpanKind = { internal: 1, server: 2, client: 3, producer: 4, consumer: 5 } as const;

export type Attrs = Record<string, string | number | boolean>;

export interface Span {
  traceId: string;
  spanId: string;
  parentId?: string;
  name: string;
  type: SpanType;
  kind?: number;
  /** Epoch milliseconds, with a fraction. */
  start: number;
  /** Milliseconds. */
  duration: number;
  /** 0 unset, 1 ok, 2 error (OpenTelemetry's StatusCode). */
  status?: 0 | 1 | 2;
  error?: string;
  attrs?: Attrs;
  /** Set on spans from other services (OTLP); the engine's own spans take the engine's service name. */
  service?: string;
  /** Rows a database statement returned; kept apart from `attrs` so a statement's attributes can be one object shared by every run of it. */
  rows?: number;
}

/**
 * What started a trace. Function kinds for calls over /rpc (a WebSocket subscription is `query` with method WS), `live` for a
 * subscription re-running after a write, `http` for /http routes (and Nest controllers), `auth` for /api/auth, `page` for a full-stack
 * app's document requests, `job`/`cron` for the scheduler, and `server`/`consumer` for entry spans other services sent over OTLP.
 */
export type RequestKind = "query" | "mutation" | "action" | "live" | "http" | "auth" | "page" | "job" | "cron" | "server" | "consumer";

export interface ErrorInfo {
  type: string;
  message: string;
  stack?: string;
  /** Thrown on purpose (a ForgeError, a validation failure, an HttpException under 500) rather than a crash. */
  handled: boolean;
}

/** The root of a trace, one row per request the store keeps. */
export interface RequestRecord {
  traceId: string;
  spanId: string;
  time: number;
  duration: number;
  service: string;
  instance?: string;
  kind: RequestKind;
  /** The function, route pattern or job name: what requests are grouped by. */
  operation: string;
  /** GET/POST/..., WS for a subscription, LIVE for a re-run, CRON or SCHEDULED for jobs. */
  method?: string;
  /** HTTP status, or what a function call's outcome would answer with over HTTP. */
  status: number;
  userId?: string;
  userName?: string;
  error?: ErrorInfo;
  cache?: "hit" | "miss" | "shared";
  release?: string;
  /** How many requests this row stands for: 1, or more when it was sampled (1 / the chance it had of being kept). */
  weight: number;
  /** Jobs: from when they were due to when they started. */
  queueWait?: number;
  attrs?: Attrs;
}

/** A finished trace, ready for the store. */
export interface TraceRecord {
  request: RequestRecord;
  spans: Span[];
}

export interface LogRecord {
  time: number;
  service: string;
  instance?: string;
  level: string;
  /** The function, class or logger the line came from. */
  name: string;
  message: string;
  traceId?: string;
  spanId?: string;
  attrs?: Attrs;
}

/** Per minute and operation, from every request (sampled or not): the numbers charts and totals come from. */
export interface Rollup {
  minute: number;
  service: string;
  kind: string;
  operation: string;
  instance: string;
  count: number;
  /** Server errors: crashes, timeouts, 5xx. */
  errors: number;
  /** 4xx: validation failures, ForgeErrors, HttpExceptions under 500. */
  clientErrors: number;
  cached: number;
  sum: number;
  max: number;
  hist: Record<number, number>;
}

/** Per minute and span name: spans inside requests, with the time spent in the span's own code (children subtracted). */
export interface SpanRollup {
  minute: number;
  service: string;
  type: string;
  name: string;
  /** The class or module a span's code belongs to (Nest classes, forge modules), for the time-by-code view. */
  namespace: string;
  instance: string;
  count: number;
  errors: number;
  sum: number;
  self: number;
  max: number;
  hist: Record<number, number>;
}

/** One process's health, every 10 seconds. */
export interface RuntimeSample {
  time: number;
  service: string;
  instance: string;
  role: "server" | "runtime";
  /** Percent of one core over the interval. */
  cpu: number;
  cpuUser: number;
  cpuSystem: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  /** Event loop delay over the interval, milliseconds. */
  loopMean: number;
  loopP99: number;
  loopMax: number;
  connections?: number;
  subscriptions?: number;
  cacheHits?: number;
  cacheMisses?: number;
  cacheShared?: number;
  cacheEntries?: number | null;
  inflight?: number;
}

/** A custom metric's state for one minute and attribute set. */
export interface MetricPoint {
  minute: number;
  service: string;
  name: string;
  type: "counter" | "gauge" | "histogram";
  unit?: string;
  /** Canonical JSON of the attributes. */
  attrs: string;
  instance: string;
  /** Counter: the increase in this minute. Gauge: the last reading. Histogram: the sum. */
  value: number;
  count: number;
  min: number;
  max: number;
  /** Lifetime total of a counter where the source reports one (OTLP cumulative sums). */
  total?: number;
}

/** What one flush sends the store. */
export interface TelemetryBatch {
  traces?: TraceRecord[];
  /** Spans that arrived without their request (OTLP batches split a trace across exports). */
  spans?: Span[];
  logs?: LogRecord[];
  rollups?: Rollup[];
  spanRollups?: SpanRollup[];
  samples?: RuntimeSample[];
  metrics?: MetricPoint[];
  releases?: { service: string; version: string; time: number }[];
  /** Services seen, with what they say about themselves (OpenTelemetry resource attributes). */
  services?: { service: string; attrs: Attrs; time: number }[];
}
