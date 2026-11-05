// One request's passage through the WAF. Derived from @coraza/core's transaction.ts (Apache-2.0, see THIRD_PARTY_NOTICES.md), which has the whole
// lifecycle; the engine inspects requests only, in one call, so only that path is kept.
import { encodeHeaders, utf8, type Abi } from "./abi";

export interface WafRequest {
  method: string;
  /** The path and query, as the client sent them. */
  url: string;
  protocol: string;
  headers: Iterable<readonly [string, string]>;
  remoteAddr: string;
  remotePort: number;
  serverPort: number;
}

export interface Interruption {
  ruleId: number;
  action: string;
  status: number;
  data: string;
}

export interface MatchedRule {
  id: number;
  severity: number;
  message: string;
}

/** Cuts bytes to at most `max` without ending in the middle of a character: a field made too long on purpose must still be inspected, not refused. */
function clip(bytes: Uint8Array, max: number): Uint8Array {
  if (bytes.length <= max) return bytes;
  let end = max;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end);
}

/** The connection, URI, headers and body as the one buffer `tx_process_request_bundle` reads (layout: wasm/bundle.go upstream). */
export function encodeRequestBundle(req: WafRequest, body?: Uint8Array): Uint8Array {
  const addr = clip(utf8(req.remoteAddr), 0xffff);
  const method = clip(utf8(req.method), 255);
  const proto = clip(utf8(req.protocol), 255);
  const url = utf8(req.url);
  const headers = encodeHeaders(req.headers);
  const payload = body ?? new Uint8Array(0);
  const out = new Uint8Array(2 + addr.length + 4 + 1 + method.length + 1 + proto.length + 4 + url.length + 4 + headers.length + 4 + payload.length);
  const view = new DataView(out.buffer);
  let at = 0;
  const bytes = (b: Uint8Array) => (out.set(b, at), (at += b.length));
  view.setUint16(at, addr.length, true);
  at += 2;
  bytes(addr);
  view.setUint16(at, req.remotePort & 0xffff, true);
  view.setUint16(at + 2, req.serverPort & 0xffff, true);
  at += 4;
  out[at++] = method.length;
  bytes(method);
  out[at++] = proto.length;
  bytes(proto);
  for (const part of [url, headers, payload]) {
    view.setUint32(at, part.length, true);
    at += 4;
    bytes(part);
  }
  return out;
}

export class Transaction {
  #closed = false;
  constructor(
    private abi: Abi,
    private id: number,
  ) {}

  /** Runs every request phase over the request. True when the rules want it stopped (never in detection-only mode). */
  inspect(req: WafRequest, body?: Uint8Array): boolean {
    const rc = this.abi.withBytes(encodeRequestBundle(req, body), (ptr, len) => this.abi.exports.tx_process_request_bundle(this.id, ptr, len));
    this.abi.check(rc, "tx_process_request_bundle");
    return rc === 1;
  }

  interruption(): Interruption | null {
    if (this.abi.exports.tx_has_interrupt(this.id) === 0) return null;
    const packed = this.abi.exports.tx_get_interrupt(this.id);
    return packed === 0n ? null : (JSON.parse(this.abi.readPacked(packed)) as Interruption);
  }

  /** Every rule that matched, whether or not it stopped the request. */
  matchedRules(): MatchedRule[] {
    const packed = this.abi.exports.tx_get_matched_rules(this.id);
    return packed === 0n ? [] : (JSON.parse(this.abi.readPacked(packed)) as MatchedRule[]);
  }

  close() {
    if (this.#closed) return;
    this.#closed = true;
    this.abi.exports.tx_destroy(this.id);
  }
}
