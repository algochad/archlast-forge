// Optional tracing: with OTEL_EXPORTER_OTLP_ENDPOINT set, every function call is a span, exported as OTLP/HTTP JSON.
// Incoming W3C `traceparent` headers are continued, so calls join the caller's trace.
import { log } from "./logger";

type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: { key: string; value: { stringValue: string } }[];
};

const hex = (bytes: number) => Buffer.from(crypto.getRandomValues(new Uint8Array(bytes))).toString("hex");
const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}$/;

export class Tracer {
  private queue: Span[] = [];
  private timer: Timer;

  constructor(
    private endpoint: string,
    private service: string,
  ) {
    this.timer = setInterval(() => void this.flush(), 2000);
  }

  static fromEnv(env: Record<string, string | undefined>) {
    const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (env.OTEL_EXPORTER_OTLP_ENDPOINT && `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`);
    return endpoint ? new Tracer(endpoint, env.OTEL_SERVICE_NAME ?? "archlast-forge") : undefined;
  }

  /** Runs `fn` as a span named `name`, continuing `traceparent` when it's valid. */
  async span<T>(name: string, traceparent: string | undefined, attributes: Record<string, string>, fn: () => Promise<T>): Promise<T> {
    const parent = traceparent ? TRACEPARENT.exec(traceparent) : null;
    const start = BigInt(Date.now()) * 1_000_000n;
    const record = (error?: unknown) =>
      this.queue.push({
        traceId: parent?.[1] ?? hex(16),
        spanId: hex(8),
        parentSpanId: parent?.[2],
        name,
        kind: 2, // SERVER
        startTimeUnixNano: String(start),
        endTimeUnixNano: String(BigInt(Date.now()) * 1_000_000n),
        status: error ? { code: 2, message: (error as Error)?.message } : { code: 1 },
        attributes: Object.entries(attributes).map(([key, v]) => ({ key, value: { stringValue: v } })),
      });
    try {
      const out = await fn();
      record();
      return out;
    } catch (e) {
      record(e);
      throw e;
    }
  }

  async flush() {
    const spans = this.queue.splice(0, 1000);
    if (!spans.length) return;
    const body = {
      resourceSpans: [
        {
          resource: { attributes: [{ key: "service.name", value: { stringValue: this.service } }] },
          scopeSpans: [{ scope: { name: "archlast-forge" }, spans }],
        },
      ],
    };
    await fetch(this.endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then(
      (r) => r.ok || log("warn", "trace export failed", { status: r.status }),
      (e) => log("warn", "trace export failed", { error: String(e) }),
    );
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
