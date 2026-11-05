// Bindings to the Coraza WASM module's exports (its ABI is documented in coraza-incubator/coraza-node, wasm/ABI.md). Derived from
// @coraza/core's abi.ts (Apache-2.0, see THIRD_PARTY_NOTICES.md), cut down to what the engine calls.

/** The ABI's major version this code was written against. */
export const ABI_MAJOR = 1;

export interface CorazaExports {
  memory: WebAssembly.Memory;
  abi_version(): number;
  last_error(): bigint;
  host_malloc(size: number): number;
  host_free(ptr: number): void;
  waf_create(cfgPtr: number, cfgLen: number): number;
  waf_destroy(id: number): void;
  tx_create(wafId: number): number;
  tx_destroy(id: number): void;
  tx_process_request_bundle(id: number, bundlePtr: number, bundleLen: number): number;
  tx_has_interrupt(id: number): number;
  tx_get_interrupt(id: number): bigint;
  tx_get_matched_rules(id: number): bigint;
}

const decoder = new TextDecoder("utf-8", { fatal: false });
const encoder = new TextEncoder();

export const utf8 = (s: string) => encoder.encode(s);

/** A typed handle on one WASM instance. Linear memory can grow (and detach its old views) whenever the module allocates, so views are taken fresh. */
export class Abi {
  constructor(readonly exports: CorazaExports) {
    const major = (exports.abi_version() >>> 16) & 0xffff;
    if (major !== ABI_MAJOR) throw new Error(`incompatible Coraza WASM ABI: expected major ${ABI_MAJOR}, got ${major}`);
  }

  get memory() {
    return new Uint8Array(this.exports.memory.buffer);
  }

  /** Copies `bytes` into a fresh WASM allocation, and returns it for `run` to read; the allocation is freed afterwards. */
  withBytes<T>(bytes: Uint8Array, run: (ptr: number, len: number) => T): T {
    if (bytes.length === 0) return run(0, 0);
    const ptr = this.exports.host_malloc(bytes.length);
    if (ptr === 0) throw new Error("coraza: out of memory for an input buffer");
    try {
      this.memory.set(bytes, ptr);
      return run(ptr, bytes.length);
    } finally {
      this.exports.host_free(ptr);
    }
  }

  /** A `(ptr << 32) | len` return value, as the string it points at. */
  readPacked(packed: bigint): string {
    const ptr = Number(packed >> 32n);
    const len = Number(packed & 0xffffffffn);
    return len === 0 ? "" : decoder.decode(this.memory.subarray(ptr, ptr + len));
  }

  /** Throws when `rc` is negative, with the module's own message. */
  check(rc: number, op: string) {
    if (rc >= 0) return;
    const packed = this.exports.last_error();
    throw new Error(`${op}: ${packed === 0n ? "unknown error" : this.readPacked(packed)}`);
  }
}

/** Header packet: `[count u32]` then `[name_len u32][name][value_len u32][value]` for each, little-endian. */
export function encodeHeaders(headers: Iterable<readonly [string, string]>): Uint8Array {
  const entries: [Uint8Array, Uint8Array][] = [];
  let total = 4;
  for (const [name, value] of headers) {
    const n = encoder.encode(name);
    const v = encoder.encode(value);
    entries.push([n, v]);
    total += 8 + n.length + v.length;
  }
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, entries.length, true);
  let at = 4;
  for (const [n, v] of entries) {
    view.setUint32(at, n.length, true);
    out.set(n, (at += 4));
    view.setUint32((at += n.length), v.length, true);
    out.set(v, (at += 4));
    at += v.length;
  }
  return out;
}
