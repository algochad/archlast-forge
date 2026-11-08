// Wire formats shared with crates/core (all integers little-endian).
//
// Options blob (JS -> Rust, once at start):
//   u16 port, u32 threads (0 = one per CPU), u32 maxBody, u16 hostLen, host,
//   u32 staticCount, staticCount x { u8 methodLen, method, u16 pathLen, path,
//                                    u16 status, u16 headerCount, headers..., u32 bodyLen, body },
//   u16 wsRouteCount, wsRouteCount x { u8 kind (0 exact, 1 prefix, 2 any), u16 len, path },
//   u16 idleTimeoutSeconds, u16 wsIdleTimeoutSeconds, u32 wsMaxMessage, u32 wsBackpressure, u16 wsPingSeconds, u8 wsCloseOnBackpressure,
//   u8 flags (bit0 reusePort, bit1 ipv6Only, bit2 no HTTP/2), u16 unixLen, unix path (listen on a unix socket instead of TCP),
//   u8 tlsCount, tlsCount x { u32 len + cert PEM, u32 len + key PEM, u32 len + serverName, u32 len + CA PEM, u8 flags (bit0 requestCert, bit1 rejectUnauthorized, bit2 no TLS 1.2, bit3 no TLS 1.3) },
//   u8 deflate flags (bit0 permessage-deflate on, bit1 compress, bit2 no context takeover), u8 deflate window bits,
//   u16 spinMicros (poll this long for the answer before sleeping; 0 = sleep at once), u8 spinMaxConnections
//
// Event batch (Rust -> JS, filled into a JS-owned buffer by drain()): u32 count, then events, each starting with a kind byte:
//   1 request      u32 id, u8 method (255: u8 len + bytes), u8 flags (bit0: can be upgraded to a WebSocket, bit1: body continues as events, bit2: the connection is HTTPS), peer, u32 urlLen, url (path+query),
//                  u16 headerCount, u32 headerBytes, headers..., u32 bodyLen, body
//   2 ws open      u32 id, u32 requestId (the accepted upgrade request), peer, u32 urlLen, url, u16 headerCount, u32 headerBytes, headers...
//   3 ws message   u32 id, u8 type (0 text, 1 binary, 2 ASCII text), u32 len, data
//   4 ws close     u32 id, u16 code, u16 reasonLen, reason
//   5 stream closed u32 id        (the client of a streaming response went away)
//  10 ws ping      u32 id, u32 len, data       (a ping frame from the peer; the protocol layer already answered it)
//  11 ws pong      u32 id, u32 len, data
//  12 ws drain     u32 id                      (the backlog of a socket in non-closing backpressure mode has cleared)
//   7 body chunk   u32 id, u32 len, data     (the rest of a streamed request body; flow-controlled by body acks)
//   8 body end     u32 id
//   9 body error   u32 id                     (client left mid-upload)
//  14 stream ack  u32 id, u32 bytes          (that much of a streamed response reached the connection: flow control)
//  13 body too large u32 id                   (the streamed body passed the limit: the request is answered 413)
//   6 aborted      u32 id         (the client of an already-taken request went away: fires req.signal)
//   peer = u8 kind (0 none, 4, 6), address bytes (4 or 16), u16 port
//
// Command batch (JS -> Rust, one command() call per batch): u32 count, then commands, each starting with a kind byte:
//   1 respond      u32 id, u16 status, u8 contentType (0 none, 1 text, 2 json, 3 binary), u16 headerCount, headers..., u32 bodyLen, body
//   2 stream start u32 id, u16 status, u16 headerCount, headers...
//   3 stream chunk u32 id, u32 len, data
//   4 stream end   u32 id
//   5 ws send      u32 id, u8 binary, u32 len, data
//   6 ws close     u32 id, u16 code, u16 reasonLen, reason
//   7 ws subscribe u32 id, u16 topicLen, topic
//   8 ws unsubscribe u32 id, u16 topicLen, topic
//   9 publish      u16 topicLen, topic, u8 binary, u32 len, data, u32 excludeId (0 = none)
//  22 respond template u32 id, u16 status, u16 headerCount, headers..., u32 template, u32 len, data (JSON): Rust prints the page on the I/O thread
//  21 cache purge  u16 count, (u16 len, tag)*  (drop cached responses carrying one of the tags; none: all of them)
//  13 upgrade      u32 requestId, u16 headerCount, headers..., u16 protocolLen, protocol (accept the WebSocket upgrade of that request)
//  16 ws ping      u32 id, u32 len, data
//  17 ws pong      u32 id, u32 len, data
//  18 ws terminate u32 id                      (drop the connection without a closing handshake)
//  19 ws pause     u32 id                      (stop reading from the socket)
//  20 ws resume    u32 id
//  14 body ack     u32 id, u32 bytes          (the handler consumed that much of the streamed body: Rust may send more)
//  15 body cancel  u32 id                     (the handler does not want the rest)
//  11 timeout      u32 id, u16 seconds (0: no idle timeout for this request's connection until it completes)
//  12 stream error u32 id        (abort the connection instead of ending the body cleanly)
//  10 file         u32 id, u16 status, u8 flags (bit0: honour Range), u16 headerCount, headers..., u16 pathLen, path, u16 typeLen, type
//
// A header is { u16 nameLen, name, u16 valueLen, value }.

export const METHODS = [
  "GET",
  "POST",
  "PUT",
  "DELETE",
  "PATCH",
  "HEAD",
  "OPTIONS",
  "TRACE",
  "CONNECT",
] as const;

export const encoder = new TextEncoder();

/** Growable little-endian byte writer. */
export class ByteWriter {
  buf: Uint8Array;
  /** The same memory as a Buffer, for `utf8Write` (no view object per string). */
  private nbuf: Buffer;
  pos = 0;

  constructor(size: number) {
    this.buf = new Uint8Array(size);
    this.nbuf = Buffer.from(this.buf.buffer);
  }

  ensure(n: number): void {
    const need = this.pos + n;
    if (need > this.buf.length) {
      const next = new Uint8Array(Math.max(this.buf.length * 2, need));
      next.set(this.buf.subarray(0, this.pos));
      this.buf = next;
      this.nbuf = Buffer.from(next.buffer);
    }
  }

  u8(v: number): void {
    this.ensure(1);
    this.buf[this.pos++] = v;
  }

  u16(v: number): void {
    this.ensure(2);
    this.buf[this.pos++] = v;
    this.buf[this.pos++] = v >>> 8;
  }

  u32(v: number): void {
    this.ensure(4);
    const b = this.buf;
    b[this.pos++] = v;
    b[this.pos++] = v >>> 8;
    b[this.pos++] = v >>> 16;
    b[this.pos++] = v >>> 24;
  }

  bytes(src: Uint8Array): void {
    this.ensure(src.length);
    this.buf.set(src, this.pos);
    this.pos += src.length;
  }

  /** Writes UTF-8 and returns the number of bytes written. */
  utf8(s: string): number {
    this.ensure(s.length * 3);
    const written = this.nbuf.utf8Write(s, this.pos);
    this.pos += written;
    return written;
  }

  setU16(at: number, v: number): void {
    this.buf[at] = v;
    this.buf[at + 1] = v >>> 8;
  }

  setU32(at: number, v: number): void {
    const b = this.buf;
    b[at] = v;
    b[at + 1] = v >>> 8;
    b[at + 2] = v >>> 16;
    b[at + 3] = v >>> 24;
  }

  /** Length-prefixed (u8/u16/u32) UTF-8 string. */
  str8(s: string): void {
    const at = this.pos;
    this.u8(0);
    this.buf[at] = this.utf8(s);
  }
  str32(s: string): void {
    const at = this.pos;
    this.u32(0);
    this.setU32(at, this.utf8(s));
  }
  str16(s: string): void {
    const at = this.pos;
    this.u16(0);
    this.setU16(at, this.utf8(s));
  }
}

export type HeaderInit = Record<string, string> | [string, string][];

/**
 * Headers encoded once, for a set a server sends on many responses (a security policy): a `Reply` given one as `block` writes its bytes as they are,
 * instead of encoding every name and value again for each response. Names are lower-cased; values should not change.
 */
export class HeaderBlock {
  readonly bytes: Uint8Array;
  readonly count: number;
  constructor(pairs: [string, string][]) {
    const w = new ByteWriter(512);
    for (const [name, value] of pairs) (w.str16(name.toLowerCase()), w.str16(value));
    this.bytes = w.buf.slice(0, w.pos);
    this.count = pairs.length;
  }
}

/** Body of a response that is constant for the lifetime of the server (answered without entering JS). */
export interface StaticEntry {
  method: string;
  path: string;
  status: number;
  headers: [string, string][];
  body: Uint8Array;
}

export interface TlsEntry {
  cert: string;
  key: string;
  serverName: string;
  ca: string;
  requestCert: boolean;
  rejectUnauthorized: boolean;
  noTls12: boolean;
  noTls13: boolean;
}

export interface NativeOptions {
  port: number;
  hostname: string;
  threads: number;
  maxBody: number;
  statics: StaticEntry[];
  wsRoutes: { kind: 0 | 1 | 2; path: string }[];
  wsMaxMessage: number;
  wsBackpressure: number;
  wsPingInterval: number;
  wsCloseOnBackpressure: boolean;
  /** Seconds without traffic before a connection is closed (0 = never); WebSockets use their own value. */
  idleTimeout: number;
  wsIdleTimeout: number;
  reusePort: boolean;
  ipv6Only: boolean;
  /** Offer HTTP/2 through ALPN on TLS connections. */
  http2: boolean;
  /** Listen on this unix-domain socket path instead of a TCP port. */
  unix: string;
  tls: TlsEntry[];
  wsDeflate: {
    enabled: boolean;
    compress: boolean;
    noContextTakeover: boolean;
    windowBits: number;
  };
  spinMicros: number;
  spinMaxConnections: number;
}

export function encodeOptions(o: NativeOptions): Uint8Array {
  const w = new ByteWriter(256);
  w.u16(o.port);
  w.u32(o.threads);
  w.u32(o.maxBody);
  w.str16(o.hostname);
  w.u32(o.statics.length);
  for (const s of o.statics) {
    w.str8(s.method);
    w.str16(s.path);
    w.u16(s.status);
    w.u16(s.headers.length);
    for (const [k, v] of s.headers) {
      w.str16(k);
      w.str16(v);
    }
    w.u32(s.body.length);
    w.bytes(s.body);
  }
  w.u16(o.wsRoutes.length);
  for (const r of o.wsRoutes) {
    w.u8(r.kind);
    w.str16(r.path);
  }
  w.u16(Math.min(65535, Math.max(0, Math.floor(o.idleTimeout))));
  w.u16(Math.min(65535, Math.max(0, Math.floor(o.wsIdleTimeout))));
  w.u32(Math.min(0xffffffff, Math.max(1, Math.floor(o.wsMaxMessage))));
  w.u32(Math.min(0xffffffff, Math.max(1, Math.floor(o.wsBackpressure))));
  w.u16(Math.min(65535, Math.max(0, Math.floor(o.wsPingInterval))));
  w.u8(o.wsCloseOnBackpressure ? 1 : 0);
  w.u8((o.reusePort ? 1 : 0) | (o.ipv6Only ? 2 : 0) | (o.http2 ? 0 : 4));
  w.str16(o.unix);
  w.u8(o.tls.length);
  for (const t of o.tls) {
    w.str32(t.cert);
    w.str32(t.key);
    w.str32(t.serverName);
    w.str32(t.ca);
    w.u8(
      (t.requestCert ? 1 : 0) |
        (t.rejectUnauthorized ? 2 : 0) |
        (t.noTls12 ? 4 : 0) |
        (t.noTls13 ? 8 : 0),
    );
  }
  w.u8(
    (o.wsDeflate.enabled ? 1 : 0) |
      (o.wsDeflate.compress ? 2 : 0) |
      (o.wsDeflate.noContextTakeover ? 4 : 0),
  );
  w.u8(o.wsDeflate.windowBits);
  w.u16(Math.min(65535, Math.max(0, Math.floor(o.spinMicros))));
  w.u8(Math.min(255, Math.max(0, Math.floor(o.spinMaxConnections))));
  return w.buf.slice(0, w.pos);
}

/** A request as read out of an inbox batch. Headers and body are decoded lazily. */
const NO_BYTES = new Uint8Array(0);
const NEVER_ABORTED = new AbortController().signal;

export interface SignalHost {
  signalFor(id: number): AbortSignal;
  /** Seconds the connection of request `id` may stay idle until it completes (0 = no limit). */
  timeout(id: number, seconds: number): void;
}

export class RawRequest {
  id = 0;
  method = "GET";
  /** Path plus query string, exactly as received. */
  url = "";
  headerCount = 0;
  ipKind = 0;
  ipAt = 0;
  /** True when the client asked for a WebSocket upgrade on a path that offers one. */
  upgradeable = false;
  /** The request came in over TLS. */
  secure = false;
  /** For a ws-open event: the id of the upgrade request it belongs to. */
  reqId = 0;
  /** Set by `server.upgrade()`: the handlers and data to attach once the upgrade is accepted. */
  /** The request body continues as a stream (it was larger than the inline limit); `body` holds only its start. */
  bodyStreamed = false;
  bodyStream: ReadableStream<Uint8Array> | null = null;
  accepted: {
    handlers: unknown;
    data: unknown;
    headers?: HeaderInit;
    protocol?: string;
  } | null = null;
  /** Set by the lane that owns the request; supplies `signal`. */
  host: SignalHost | null = null;
  /** The batch this request was decoded from; owned by the batch, never reused, so views into it stay valid. */
  src: Uint8Array = NO_BYTES;
  hStart = 0;
  hEnd = 0;
  bStart = 0;
  bEnd = 0;

  /** The raw header block, or null when there are none (a view: no copy is made unless headers are read). */
  get headerBytes(): Uint8Array | null {
    return this.hEnd > this.hStart
      ? this.src.subarray(this.hStart, this.hEnd)
      : null;
  }

  get body(): Uint8Array | null {
    return this.bEnd > this.bStart
      ? this.src.subarray(this.bStart, this.bEnd)
      : null;
  }

  /** Client address as text, or null when unknown. */
  get ip(): string | null {
    if (this.ipKind === 0) return null;
    const b = this.src;
    const o = this.ipAt;
    if (this.ipKind === 4) return `${b[o]}.${b[o + 1]}.${b[o + 2]}.${b[o + 3]}`;
    const g: number[] = [];
    for (let i = 0; i < 8; i++) g.push((b[o + 2 * i] << 8) | b[o + 2 * i + 1]);
    let best = -1,
      bestLen = 0;
    for (let i = 0; i < 8;) {
      if (g[i] !== 0) {
        i++;
        continue;
      }
      let j = i;
      while (j < 8 && g[j] === 0) j++;
      if (j - i > bestLen) {
        best = i;
        bestLen = j - i;
      }
      i = j;
    }
    const hex = (x: number[]) => x.map((v) => v.toString(16)).join(":");
    if (bestLen < 2) return hex(g);
    return `${hex(g.slice(0, best))}::${hex(g.slice(best + bestLen))}`;
  }

  get port(): number | null {
    if (this.ipKind === 0) return null;
    const o = this.ipAt + (this.ipKind === 4 ? 4 : 16);
    return this.src[o] | (this.src[o + 1] << 8);
  }

  /** Aborted when the client disconnects before the response is sent. */
  get signal(): AbortSignal {
    return this.host ? this.host.signalFor(this.id) : NEVER_ABORTED;
  }

  /** Overrides the idle timeout of this request's connection until the request completes (0 disables it). */
  setTimeout(seconds: number): void {
    this.host?.timeout(this.id, seconds);
  }

  get path(): string {
    const q = this.url.indexOf("?");
    return q === -1 ? this.url : this.url.slice(0, q);
  }

  get search(): string {
    const q = this.url.indexOf("?");
    return q === -1 ? "" : this.url.slice(q);
  }

  private pairs: string[] | null = null;

  /** Flat [name, value, name, value, ...]; names are lower-case. Decoded once: the same array every time, which callers only read. */
  headerPairs(): string[] {
    return (this.pairs ??= this.decodeHeaders());
  }

  private decodeHeaders(): string[] {
    const out: string[] = [];
    if (this.hEnd <= this.hStart) return out;
    const b = Buffer.from(
      this.src.buffer,
      this.src.byteOffset + this.hStart,
      this.hEnd - this.hStart,
    );
    // One native call for the whole block, then cheap substrings: the length prefixes stay inside the string but
    // are never part of a piece.
    const all = b.latin1Slice(0, b.length);
    let p = 0;
    for (let i = 0; i < this.headerCount; i++) {
      const nl = b[p] | (b[p + 1] << 8);
      out.push(all.substring(p + 2, p + 2 + nl));
      p += 2 + nl;
      const vl = b[p] | (b[p + 1] << 8);
      out.push(all.substring(p + 2, p + 2 + vl));
      p += 2 + vl;
    }
    return out;
  }

  header(name: string): string | null {
    const pairs = this.headerPairs();
    const n = name.toLowerCase();
    for (let i = 0; i < pairs.length; i += 2)
      if (pairs[i] === n) return pairs[i + 1];
    return null;
  }
}

export interface EventSink {
  request(r: RawRequest): void;
  wsOpen(id: number, r: RawRequest): void;
  wsMessage(id: number, binary: boolean, data: string | Uint8Array): void;
  wsClose(id: number, code: number, reason: string): void;
  wsPing(id: number, data: Uint8Array): void;
  wsPong(id: number, data: Uint8Array): void;
  wsDrain(id: number): void;
  streamClosed(id: number): void;
  streamAck(id: number, bytes: number): void;
  aborted(id: number): void;
  bodyChunk(id: number, data: Uint8Array): void;
  bodyEnd(id: number): void;
  bodyError(id: number): void;
  bodyTooLarge(id: number): void;
}

/**
 * Decodes a drained batch of `n` bytes, dispatching each event to `sink`. Requests keep views into `inbox`, so the
 * caller must hand over a buffer that is not reused while those requests are alive (`copyOnRequest` makes the decoder copy
 * the batch itself when it meets one).
 */
export function decodeEvents(
  inbox: Uint8Array,
  n: number,
  sink: EventSink,
  copyOnRequest = false,
): void {
  let buf = Buffer.from(inbox.buffer, inbox.byteOffset, n);
  const u32 = (p: number) =>
    (buf[p] | (buf[p + 1] << 8) | (buf[p + 2] << 16) | (buf[p + 3] << 24)) >>>
    0;
  // Requests and upgrades keep views into the batch: the first one in a batch moves the rest of the decoding onto a
  // private copy (batches of WebSocket messages, the hot ones, are decoded straight from the shared inbox).
  let copied = !copyOnRequest;
  const count = u32(0);
  let p = 4;
  for (let i = 0; i < count; i++) {
    const kind = buf[p++];
    const id = u32(p);
    p += 4;
    if (kind === 1 || kind === 2) {
      if (!copied) {
        copied = true;
        inbox = inbox.slice(0, n);
        buf = Buffer.from(inbox.buffer, inbox.byteOffset, n);
      }
      const r = new RawRequest();
      r.id = id;
      if (kind === 1) {
        const m = buf[p++];
        if (m === 255) {
          const ml = buf[p++];
          r.method = buf.latin1Slice(p, p + ml);
          p += ml;
        } else {
          r.method = METHODS[m];
        }
      }
      if (kind === 2) {
        r.reqId = u32(p);
        p += 4;
      } else {
        const flags = buf[p++];
        r.upgradeable = (flags & 1) !== 0;
        r.bodyStreamed = (flags & 2) !== 0;
        r.secure = (flags & 4) !== 0;
      }
      r.ipKind = buf[p];
      r.ipAt = p + 1;
      p += r.ipKind === 4 ? 7 : r.ipKind === 6 ? 19 : 1;
      const ul = u32(p);
      r.url = buf.latin1Slice(p + 4, p + 4 + ul);
      p += 4 + ul;
      r.src = inbox;
      r.headerCount = buf[p] | (buf[p + 1] << 8);
      const hl = u32(p + 2);
      p += 6;
      r.hStart = p;
      r.hEnd = p + hl;
      p += hl;
      if (kind === 1) {
        const bl = u32(p);
        p += 4;
        r.bStart = p;
        r.bEnd = p + bl;
        p += bl;
        sink.request(r);
      } else {
        sink.wsOpen(id, r);
      }
    } else if (kind === 3) {
      const type = buf[p++]; // 0 text, 1 binary, 2 text that is plain ASCII
      const len = u32(p);
      p += 4;
      sink.wsMessage(
        id,
        type === 1,
        type === 1
          ? inbox.slice(p, p + len)
          : type === 2
            ? buf.latin1Slice(p, p + len)
            : buf.utf8Slice(p, p + len),
      );
      p += len;
    } else if (kind === 4) {
      const code = buf[p] | (buf[p + 1] << 8);
      const rl = buf[p + 2] | (buf[p + 3] << 8);
      sink.wsClose(id, code, rl > 0 ? buf.utf8Slice(p + 4, p + 4 + rl) : "");
      p += 4 + rl;
    } else if (kind === 10 || kind === 11) {
      const len = u32(p);
      const data = inbox.slice(p + 4, p + 4 + len);
      if (kind === 10) sink.wsPing(id, data);
      else sink.wsPong(id, data);
      p += 4 + len;
    } else if (kind === 12) {
      sink.wsDrain(id);
    } else if (kind === 5) {
      sink.streamClosed(id);
    } else if (kind === 6) {
      sink.aborted(id);
    } else if (kind === 7) {
      const len = u32(p);
      sink.bodyChunk(id, inbox.slice(p + 4, p + 4 + len));
      p += 4 + len;
    } else if (kind === 8) {
      sink.bodyEnd(id);
    } else if (kind === 9) {
      sink.bodyError(id);
    } else if (kind === 13) {
      sink.bodyTooLarge(id);
    } else if (kind === 14) {
      sink.streamAck(id, u32(p));
      p += 4;
    } else {
      throw new Error(`corrupt event batch (kind ${kind})`);
    }
  }
}
