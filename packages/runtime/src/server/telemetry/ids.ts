// W3C trace context ids: 16 random bytes for a trace, 8 for a span, as lowercase hex. Random bytes come from one buffer refilled when
// used up, and hex comes from one native conversion, so an id costs a slice of the buffer rather than a call into the system's random
// source or a string built byte by byte.

const pool = Buffer.alloc(8192);
let at = pool.length;
const ZERO_TRACE = "0".repeat(32);
const ZERO_SPAN = "0".repeat(16);

function hex(bytes: number, zero: string): string {
  if (at + bytes > pool.length) {
    crypto.getRandomValues(pool);
    at = 0;
  }
  const s = pool.toString("hex", at, (at += bytes));
  // All zeros is the invalid id in the spec; astronomically unlikely, but cheap to rule out.
  return s === zero ? hex(bytes, zero) : s;
}

export const traceId = () => hex(16, ZERO_TRACE);

let prefix = hex(4, "00000000");
let counter = 0;
/** Random for the process, then counted: unique across a trace (and in practice everywhere) at a fraction of the cost of random bytes. */
export function spanId(): string {
  if (counter === 0xffffffff) (prefix = hex(4, "00000000")), (counter = 0);
  const n = (++counter).toString(16);
  return prefix + "00000000".slice(n.length) + n;
}

const TRACEPARENT = /^00-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/;

/** The trace and parent span an incoming `traceparent` header names, if it is valid, and whether the caller recorded its side. */
export function parseTraceparent(header: string | null | undefined): { traceId: string; parentId: string; sampled: boolean } | undefined {
  const m = header ? TRACEPARENT.exec(header.trim()) : null;
  if (!m || m[1] === ZERO_TRACE || m[2] === ZERO_SPAN) return undefined;
  return { traceId: m[1]!, parentId: m[2]!, sampled: (parseInt(m[3]!, 16) & 1) === 1 };
}

export const traceparent = (trace: string, span: string) => `00-${trace}-${span}-01`;
