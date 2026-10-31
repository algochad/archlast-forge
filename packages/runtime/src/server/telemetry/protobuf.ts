// Decodes OTLP's protobuf messages (opentelemetry-proto v1: ExportTraceServiceRequest, ExportLogsServiceRequest,
// ExportMetricsServiceRequest) into the same shape OTLP/JSON has (camelCase fields, ids as hex, 64-bit integers as strings), so one
// converter reads both. Only the wire format and the fields the engine reads are here; unknown fields are skipped.

type Scalar = "string" | "bytes" | "hex" | "bool" | "enum" | "uint32" | "int64" | "uint64" | "sint32" | "fixed64" | "sfixed64" | "fixed32" | "double";
type Schema = Record<number, readonly [name: string, type: Scalar | (() => Schema), repeated?: boolean]>;

class Reader {
  pos = 0;
  private view: DataView;
  constructor(readonly buf: Uint8Array) {
    this.view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  /** A varint as a number: exact up to 2^53, which covers every tag, length, count and enum. */
  varint(): number {
    let result = 0;
    let scale = 1;
    for (let i = 0; i < 10; i++) {
      if (this.pos >= this.buf.length) throw new Error("Truncated protobuf message");
      const b = this.buf[this.pos++]!;
      result += (b & 0x7f) * scale;
      if (b < 0x80) return result;
      scale *= 128;
    }
    throw new Error("Malformed varint");
  }
  /** A varint as a 64-bit integer, two's complement for negatives. */
  varint64(signed: boolean): string {
    let result = 0n;
    let shift = 0n;
    for (let i = 0; i < 10; i++) {
      const b = this.buf[this.pos++]!;
      result |= BigInt(b & 0x7f) << shift;
      if (b < 0x80) break;
      shift += 7n;
    }
    return (signed ? BigInt.asIntN(64, result) : BigInt.asUintN(64, result)).toString();
  }
  bytes(): Uint8Array {
    const n = this.varint();
    if (this.pos + n > this.buf.length) throw new Error("Truncated protobuf message");
    const out = this.buf.subarray(this.pos, this.pos + n);
    this.pos += n;
    return out;
  }
  fixed64(signed: boolean) {
    const v = signed ? this.view.getBigInt64(this.pos, true) : this.view.getBigUint64(this.pos, true);
    this.pos += 8;
    return v.toString();
  }
  double() {
    const v = this.view.getFloat64(this.pos, true);
    this.pos += 8;
    return v;
  }
  fixed32() {
    const v = this.view.getUint32(this.pos, true);
    this.pos += 4;
    return v;
  }
  skip(wire: number) {
    if (wire === 0) this.varint();
    else if (wire === 1) this.pos += 8;
    else if (wire === 2) this.pos += this.varint();
    else if (wire === 5) this.pos += 4;
    else throw new Error(`Unsupported protobuf wire type ${wire}`);
  }
}

const text = new TextDecoder();
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

function scalar(r: Reader, type: Scalar): unknown {
  switch (type) {
    case "string":
      return text.decode(r.bytes());
    case "bytes":
      return Buffer.from(r.bytes()).toString("base64");
    case "hex":
      return hex(r.bytes());
    case "bool":
      return r.varint() !== 0;
    case "enum":
    case "uint32":
      return r.varint();
    case "sint32": {
      const n = r.varint();
      return n % 2 ? -(n + 1) / 2 : n / 2;
    }
    case "int64":
      return r.varint64(true);
    case "uint64":
      return r.varint64(false);
    case "fixed64":
      return r.fixed64(false);
    case "sfixed64":
      return r.fixed64(true);
    case "fixed32":
      return r.fixed32();
    case "double":
      return r.double();
  }
}

/** Wire type each scalar is written with, to tell a packed repeated field (always length-delimited) from a single value. */
const WIRE: Record<Scalar, number> = { string: 2, bytes: 2, hex: 2, bool: 0, enum: 0, uint32: 0, int64: 0, uint64: 0, sint32: 0, fixed64: 1, sfixed64: 1, fixed32: 5, double: 1 };

export function decode(buf: Uint8Array, schema: Schema): Record<string, unknown> {
  return read(new Reader(buf), schema, buf.length);
}

function read(r: Reader, schema: Schema, end: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  while (r.pos < end) {
    const tag = r.varint();
    const field = Math.floor(tag / 8);
    const wire = tag & 7;
    const spec = schema[field];
    if (!spec) {
      r.skip(wire);
      continue;
    }
    const [name, type, repeated] = spec;
    const put = (v: unknown) => {
      if (repeated) ((out[name] ??= []) as unknown[]).push(v);
      else out[name] = v;
    };
    if (typeof type === "function") {
      const len = r.varint();
      const stop = r.pos + len;
      put(read(r, type(), stop));
      r.pos = stop;
    } else if (repeated && wire === 2 && WIRE[type] !== 2) {
      const stop = r.pos + r.varint();
      while (r.pos < stop) put(scalar(r, type));
    } else put(scalar(r, type));
  }
  return out;
}

// ---- the OTLP messages ----

const KeyValue = (): Schema => ({ 1: ["key", "string"], 2: ["value", AnyValue] });
const AnyValue = (): Schema => ({
  1: ["stringValue", "string"],
  2: ["boolValue", "bool"],
  3: ["intValue", "int64"],
  4: ["doubleValue", "double"],
  5: ["arrayValue", () => ({ 1: ["values", AnyValue, true] })],
  6: ["kvlistValue", () => ({ 1: ["values", KeyValue, true] })],
  7: ["bytesValue", "bytes"],
});
const Resource = (): Schema => ({ 1: ["attributes", KeyValue, true] });
const Scope = (): Schema => ({ 1: ["name", "string"], 2: ["version", "string"], 3: ["attributes", KeyValue, true] });

const Span = (): Schema => ({
  1: ["traceId", "hex"],
  2: ["spanId", "hex"],
  3: ["traceState", "string"],
  4: ["parentSpanId", "hex"],
  5: ["name", "string"],
  6: ["kind", "enum"],
  7: ["startTimeUnixNano", "fixed64"],
  8: ["endTimeUnixNano", "fixed64"],
  9: ["attributes", KeyValue, true],
  11: ["events", () => ({ 1: ["timeUnixNano", "fixed64"], 2: ["name", "string"], 3: ["attributes", KeyValue, true] }), true],
  13: ["links", () => ({ 1: ["traceId", "hex"], 2: ["spanId", "hex"], 4: ["attributes", KeyValue, true] }), true],
  15: ["status", () => ({ 2: ["message", "string"], 3: ["code", "enum"] })],
});
export const TracesRequest: Schema = {
  1: ["resourceSpans", () => ({ 1: ["resource", Resource], 2: ["scopeSpans", () => ({ 1: ["scope", Scope], 2: ["spans", Span, true] }), true] }), true],
};

const LogRecord = (): Schema => ({
  1: ["timeUnixNano", "fixed64"],
  11: ["observedTimeUnixNano", "fixed64"],
  2: ["severityNumber", "enum"],
  3: ["severityText", "string"],
  5: ["body", AnyValue],
  6: ["attributes", KeyValue, true],
  9: ["traceId", "hex"],
  10: ["spanId", "hex"],
  12: ["eventName", "string"],
});
export const LogsRequest: Schema = {
  1: ["resourceLogs", () => ({ 1: ["resource", Resource], 2: ["scopeLogs", () => ({ 1: ["scope", Scope], 2: ["logRecords", LogRecord, true] }), true] }), true],
};

const NumberDataPoint = (): Schema => ({ 7: ["attributes", KeyValue, true], 2: ["startTimeUnixNano", "fixed64"], 3: ["timeUnixNano", "fixed64"], 4: ["asDouble", "double"], 6: ["asInt", "sfixed64"] });
const HistogramDataPoint = (): Schema => ({
  9: ["attributes", KeyValue, true],
  2: ["startTimeUnixNano", "fixed64"],
  3: ["timeUnixNano", "fixed64"],
  4: ["count", "fixed64"],
  5: ["sum", "double"],
  6: ["bucketCounts", "fixed64", true],
  7: ["explicitBounds", "double", true],
  11: ["min", "double"],
  12: ["max", "double"],
});
const ExpHistogramDataPoint = (): Schema => ({
  1: ["attributes", KeyValue, true],
  2: ["startTimeUnixNano", "fixed64"],
  3: ["timeUnixNano", "fixed64"],
  4: ["count", "fixed64"],
  5: ["sum", "double"],
  12: ["min", "double"],
  13: ["max", "double"],
});
const SummaryDataPoint = (): Schema => ({ 7: ["attributes", KeyValue, true], 2: ["startTimeUnixNano", "fixed64"], 3: ["timeUnixNano", "fixed64"], 4: ["count", "fixed64"], 5: ["sum", "double"] });
const Metric = (): Schema => ({
  1: ["name", "string"],
  2: ["description", "string"],
  3: ["unit", "string"],
  5: ["gauge", () => ({ 1: ["dataPoints", NumberDataPoint, true] })],
  7: ["sum", () => ({ 1: ["dataPoints", NumberDataPoint, true], 2: ["aggregationTemporality", "enum"], 3: ["isMonotonic", "bool"] })],
  9: ["histogram", () => ({ 1: ["dataPoints", HistogramDataPoint, true], 2: ["aggregationTemporality", "enum"] })],
  10: ["exponentialHistogram", () => ({ 1: ["dataPoints", ExpHistogramDataPoint, true], 2: ["aggregationTemporality", "enum"] })],
  11: ["summary", () => ({ 1: ["dataPoints", SummaryDataPoint, true] })],
});
export const MetricsRequest: Schema = {
  1: ["resourceMetrics", () => ({ 1: ["resource", Resource], 2: ["scopeMetrics", () => ({ 1: ["scope", Scope], 2: ["metrics", Metric, true] }), true] }), true],
};
