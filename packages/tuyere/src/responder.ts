import { ByteWriter, type HeaderBlock, type HeaderInit } from "./codec.ts";
import { FileReply } from "./file.ts";
import { type Body, Reply, type Result, TemplateReply, toReply } from "./server.ts";

/** Content-type codes understood by the native side (it maps them to static header values). 0 = none. */
export const CT_TEXT = 1;
export const CT_JSON = 2;
export const CT_BINARY = 3;

/** Encodes responses as `respond` commands (kind 1) into a growable buffer; used by the lane runtime. */
export class Responder {
  readonly out: ByteWriter;
  count = 0;

  constructor(size = 16 * 1024) {
    this.out = new ByteWriter(size);
    this.out.pos = 4; // [u32 count] is patched when the batch is sealed
  }

  /** Writes a buffered result. Streams and `Response` objects are handled by the caller. */
  writeResult(id: number, v: Result): void {
    if (typeof v === "string") return this.put(id, 200, CT_TEXT, null, v);
    if (v === null || v === undefined) return this.put(id, 200, 0, null, null);
    if (v instanceof FileReply) return this.putFile(id, v);
    if (v instanceof TemplateReply) return this.putTemplate(id, v);
    if (v instanceof Reply) {
      const r = toReply(v);
      return this.put(id, r.status, 0, r.headers, r.body, r.block);
    }
    if (v instanceof Uint8Array) return this.put(id, 200, CT_BINARY, null, v);
    return this.put(id, 200, CT_JSON, null, JSON.stringify(v));
  }

  /** Writes a `respond template` command (kind 22): the status and headers now, the page printed by Rust. */
  private putTemplate(id: number, t: TemplateReply): void {
    const w = this.out;
    w.u8(22);
    w.u32(id);
    w.u16(t.init.status ?? 200);
    const hcAt = w.pos;
    w.u16(0);
    w.setU16(hcAt, this.writeHeaders(null, t.init.headers ?? null));
    w.u32(t.template);
    const lenAt = w.pos;
    w.u32(0);
    w.setU32(lenAt, w.utf8(t.data));
    this.count++;
  }

  put(
    id: number,
    status: number,
    ct: number,
    extra: HeaderInit | null,
    body: Body,
    block: HeaderBlock | null = null,
  ): void {
    const w = this.out;
    w.u8(1);
    w.u32(id);
    w.u16(status);
    w.u8(ct);
    const hcAt = w.pos;
    w.u16(0);
    let hc = this.writeHeaders(null, extra);
    if (block !== null) {
      w.bytes(block.bytes);
      hc += block.count;
    }
    w.setU16(hcAt, hc);
    const lenAt = w.pos;
    w.u32(0);
    let len = 0;
    if (typeof body === "string") len = w.utf8(body);
    else if (body !== null) {
      w.bytes(body);
      len = body.length;
    }
    w.setU32(lenAt, len);
    this.count++;
  }

  private hc = 0;
  private hasCt = false;
  /** Writes one header of a `Headers` object (a method-level callback, so no closure is made per response). */
  private eachHeader = (value: string, key: string): void => {
    this.out.str16(key); // Headers hands out lower-case names
    this.out.str16(value);
    this.hc++;
    if (key === "content-type") this.hasCt = true;
  };

  /**
   * Writes the answer to a request from a fetch-style `Response`: its headers go straight into the command buffer (no
   * intermediate array), and a body without a Content-Type is given one by `inferType`.
   */
  putFetched(
    id: number,
    status: number,
    headers: Headers,
    body: Uint8Array | null,
    inferType: ((b: Uint8Array) => string) | null,
  ): void {
    const w = this.out;
    w.u8(1);
    w.u32(id);
    w.u16(status);
    w.u8(0);
    const hcAt = w.pos;
    w.u16(0);
    this.hc = 0;
    this.hasCt = false;
    headers.forEach(this.eachHeader);
    if (inferType !== null && body !== null && body.length > 0 && !this.hasCt) {
      w.str16("content-type");
      w.str16(inferType(body));
      this.hc++;
    }
    w.setU16(hcAt, this.hc);
    const lenAt = w.pos;
    w.u32(0);
    let len = 0;
    if (body !== null) {
      w.bytes(body);
      len = body.length;
    }
    w.setU32(lenAt, len);
    this.count++;
  }

  writeHeaders(ct: Uint8Array | null, extra: HeaderInit | null): number {
    const w = this.out;
    let hc = 0;
    if (ct !== null) {
      w.bytes(ct);
      hc++;
    }
    if (extra !== null) {
      const each = (k: string, val: string) => {
        w.str16(k.toLowerCase());
        w.str16(val);
        hc++;
      };
      if (Array.isArray(extra)) for (const [k, val] of extra) each(k, val);
      else for (const k in extra) each(k, extra[k]);
    }
    return hc;
  }

  putFile(id: number, f: FileReply): void {
    const w = this.out;
    w.u8(10);
    w.u32(id);
    w.u16(f.status);
    w.u8(f.range ? 1 : 0);
    const hcAt = w.pos;
    w.u16(0);
    w.setU16(hcAt, this.writeHeaders(null, f.headers));
    w.str16(f.path);
    w.str16(f.contentType ?? "");
    this.count++;
  }

  /** Seals the batch: patches the count and returns a copy of the bytes. */
  seal(): Uint8Array {
    this.out.setU32(0, this.count);
    return this.out.buf.slice(0, this.out.pos);
  }
}
