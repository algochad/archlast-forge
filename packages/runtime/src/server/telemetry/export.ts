// Optional export: with OTEL_EXPORTER_OTLP_ENDPOINT (or _TRACES_ENDPOINT) set, every trace the engine finishes, sampled or not, is sent to
// that collector as OTLP/HTTP JSON (no SDK dependency). Spans keep the trace ids they were recorded with, so a call that came in with a
// W3C `traceparent` joins its caller's trace there too.
import { log } from "../logger";
import type { Attrs, RequestRecord, Span } from "./types";

type OtlpValue = { stringValue: string } | { intValue: string } | { doubleValue: number } | { boolValue: boolean };
type OtlpSpan = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: number;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  status: { code: number; message?: string };
  attributes: { key: string; value: OtlpValue }[];
};

const value = (v: string | number | boolean): OtlpValue =>
  typeof v === "boolean" ? { boolValue: v } : typeof v === "number" ? (Number.isInteger(v) ? { intValue: String(v) } : { doubleValue: v }) : { stringValue: v };
export const otlpAttributes = (attrs: Attrs | undefined) => Object.entries(attrs ?? {}).map(([key, v]) => ({ key, value: value(v) }));
const nanos = (ms: number) => (BigInt(Math.round(ms * 1000)) * 1000n).toString();

/** Most spans waiting to be sent; past it, new ones are dropped rather than held. */
const MAX_QUEUE = 50_000;

export class OtlpExporter {
  private queue: OtlpSpan[] = [];
  private timer: Timer;
  private dropped = 0;

  constructor(
    private endpoint: string,
    private service: string,
    private headers: Record<string, string> = {},
  ) {
    this.timer = setInterval(() => void this.flush(), 2000);
    this.timer.unref?.();
  }

  static fromEnv(env: Record<string, string | undefined>, service: string) {
    const endpoint = env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ?? (env.OTEL_EXPORTER_OTLP_ENDPOINT && `${env.OTEL_EXPORTER_OTLP_ENDPOINT.replace(/\/$/, "")}/v1/traces`);
    if (!endpoint) return undefined;
    // OTEL_EXPORTER_OTLP_HEADERS: "key=value,key2=value2", values URL-encoded, as the OpenTelemetry SDKs read it.
    const headers = Object.fromEntries(
      (env.OTEL_EXPORTER_OTLP_TRACES_HEADERS ?? env.OTEL_EXPORTER_OTLP_HEADERS ?? "")
        .split(",")
        .map((pair) => pair.split("=").map((s) => decodeURIComponent(s.trim())))
        .filter((kv): kv is [string, string] => kv.length === 2 && Boolean(kv[0])),
    );
    return new OtlpExporter(endpoint, service, headers);
  }

  export(spans: Span[], request: RequestRecord) {
    for (const s of spans) {
      if (this.queue.length >= MAX_QUEUE) {
        this.dropped++;
        continue;
      }
      const isRoot = s.spanId === request.spanId;
      this.queue.push({
        traceId: s.traceId,
        spanId: s.spanId,
        parentSpanId: s.parentId,
        name: s.name,
        kind: s.kind ?? 1,
        startTimeUnixNano: nanos(s.start),
        endTimeUnixNano: nanos(s.start + s.duration),
        status: s.status === 2 ? { code: 2, message: s.error } : { code: 1 },
        attributes: otlpAttributes({ ...s.attrs, ...(s.rows !== undefined && { "db.response.returned_rows": s.rows }), ...(isRoot && request.userId && { "enduser.id": request.userId }) }),
      });
    }
  }

  /** One flush at a time: a collector that is slow to answer must not get a pile of them. */
  flush(): Promise<void> {
    return (this.flushing ??= this.send().finally(() => (this.flushing = undefined)));
  }
  private flushing?: Promise<void>;

  private async send() {
    if (this.dropped) {
      log("warn", "trace export queue full; spans dropped", { dropped: this.dropped });
      this.dropped = 0;
    }
    while (this.queue.length) {
      const spans = this.queue.splice(0, 1000);
      const body = {
        resourceSpans: [
          {
            resource: { attributes: [{ key: "service.name", value: { stringValue: this.service } }] },
            scopeSpans: [{ scope: { name: "archlast-forge" }, spans }],
          },
        ],
      };
      // x-forge-service: an engine that receives its own service's spans (this exporter pointed back at it) knows it has them already.
      const headers = { "content-type": "application/json", "x-forge-service": this.service, ...this.headers };
      const ok = await fetch(this.endpoint, { method: "POST", headers, body: JSON.stringify(body), signal: AbortSignal.timeout(10_000) }).then(
        (r) => r.ok || (log("warn", "trace export failed", { status: r.status }), false),
        (e) => (log("warn", "trace export failed", { error: String(e) }), false),
      );
      if (!ok) return; // the rest waits for the next tick
    }
  }

  async close() {
    clearInterval(this.timer);
    await this.flush();
  }
}
