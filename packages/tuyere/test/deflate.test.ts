import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { createInflateRaw, deflateRawSync, inflateRawSync } from "node:zlib";
import { App, type BackendName, type Server } from "../src/index.ts";

const TAIL = Buffer.from([0, 0, 0xff, 0xff]);

interface Frame {
  fin: boolean;
  rsv1: boolean;
  op: number;
  payload: Buffer;
}

/** A bare-bones WebSocket client so the test sees the raw frames (RSV1 bit, sizes). */
class Raw {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  frames: Frame[] = [];
  waiters: (() => void)[] = [];
  head = "";
  closed = false;
  /** One inflater for the whole connection: with context takeover a message may refer back to earlier ones. */
  private z = createInflateRaw();
  private async inflate(payload: Buffer): Promise<Buffer> {
    const out: Buffer[] = [];
    const take = (d: Buffer) => out.push(d);
    this.z.on("data", take);
    await new Promise<void>((res, rej) => {
      this.z.once("error", rej);
      this.z.write(Buffer.concat([payload, TAIL]));
      this.z.flush(2 /* Z_SYNC_FLUSH */, () => res());
    });
    this.z.off("data", take);
    return Buffer.concat(out);
  }

  static async open(
    port: number,
    extensions: string | null,
    path = "/ws",
    protocols?: string,
  ): Promise<Raw> {
    const r = new Raw();
    await new Promise<void>((res, rej) => {
      r.sock = net.connect(port, "127.0.0.1", () => {
        const lines = [
          `GET ${path} HTTP/1.1`,
          "Host: x",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${randomBytes(16).toString("base64")}`,
          "Sec-WebSocket-Version: 13",
        ];
        if (extensions) lines.push(`Sec-WebSocket-Extensions: ${extensions}`);
        if (protocols) lines.push(`Sec-WebSocket-Protocol: ${protocols}`);
        r.sock.write(lines.join("\r\n") + "\r\n\r\n");
      });
      r.sock.on("error", rej);
      r.sock.on("close", () => {
        r.closed = true;
        r.wake();
      });
      r.sock.on("data", (d) => {
        r.buf = Buffer.concat([r.buf, d as Buffer]);
        if (!r.head) {
          const at = r.buf.indexOf("\r\n\r\n");
          if (at < 0) return;
          r.head = r.buf.subarray(0, at).toString();
          r.buf = r.buf.subarray(at + 4);
          res();
        }
        r.parse();
      });
    });
    return r;
  }

  header(name: string): string | undefined {
    return this.head
      .split("\r\n")
      .find((l) => l.toLowerCase().startsWith(name.toLowerCase() + ":"))
      ?.split(":")
      .slice(1)
      .join(":")
      .trim();
  }

  wake() {
    this.waiters.splice(0).forEach((w) => w());
  }

  parse() {
    for (;;) {
      const b = this.buf;
      if (b.length < 2) return;
      let len = b[1] & 0x7f,
        off = 2;
      if (len === 126) {
        if (b.length < 4) return;
        len = b.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (b.length < 10) return;
        len = Number(b.readBigUInt64BE(2));
        off = 10;
      }
      if (b.length < off + len) return;
      this.frames.push({
        fin: !!(b[0] & 0x80),
        rsv1: !!(b[0] & 0x40),
        op: b[0] & 0xf,
        payload: Buffer.from(b.subarray(off, off + len)),
      });
      this.buf = b.subarray(off + len);
      this.wake();
    }
  }

  async next(): Promise<Frame> {
    while (this.frames.length === 0) {
      if (this.closed) throw new Error("socket closed");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 2000);
      });
      if (this.frames.length === 0 && !this.closed)
        throw new Error("timed out waiting for a frame");
    }
    return this.frames.shift()!;
  }

  /** Next data frame, inflated when it has RSV1. */
  async message(): Promise<{ text: string; rsv1: boolean; wire: number }> {
    for (;;) {
      const f = await this.next();
      if (f.op !== 1 && f.op !== 2) continue;
      const data = f.rsv1 ? await this.inflate(f.payload) : f.payload;
      return { text: data.toString(), rsv1: f.rsv1, wire: f.payload.length };
    }
  }

  send(op: number, payload: Buffer, rsv1 = false) {
    const key = randomBytes(4);
    const n = payload.length;
    const head =
      n < 126
        ? Buffer.from([0x80 | (rsv1 ? 0x40 : 0) | op, 0x80 | n])
        : n < 65536
          ? Buffer.from([
              0x80 | (rsv1 ? 0x40 : 0) | op,
              0x80 | 126,
              n >> 8,
              n & 255,
            ])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = 0x80 | (rsv1 ? 0x40 : 0) | op;
              h[1] = 0x80 | 127;
              h.writeBigUInt64BE(BigInt(n), 2);
              return h;
            })();
    const masked = Buffer.from(payload);
    for (let i = 0; i < n; i++) masked[i] ^= key[i & 3];
    this.sock.write(Buffer.concat([head, key, masked]));
  }
  sendText(s: string) {
    this.send(1, Buffer.from(s));
  }
  /** A compressed text message (raw deflate without the sync tail). */
  sendCompressed(s: string) {
    const z = deflateRawSync(Buffer.from(s), {
      finishFlush: 2 /* Z_SYNC_FLUSH */,
    });
    this.send(1, z.subarray(0, z.length - 4), true);
  }
  close() {
    this.sock.destroy();
  }
}

const BIG = "the quick brown fox jumps over the lazy dog ".repeat(200); // ~8.8 KB, very compressible

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`permessage-deflate: ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const make = (
      deflate: Parameters<App["listen"]>[0] extends infer O
        ? O extends { wsPerMessageDeflate?: infer D }
          ? D
          : never
        : never,
      max?: number,
    ) => {
      const s = new App()
        .ws("/ws", {
          open: (ws) => ws.subscribe("room"),
          message: (ws, m) => {
            const t = String(m);
            if (t === "big") ws.send(BIG);
            else if (t === "bigtwice") {
              ws.send(BIG);
              ws.send(BIG);
            } else if (t === "small") ws.send("tiny");
            else if (t === "close") ws.close(1000, "bye");
            else if (t === "pub") ws.publish("room", BIG);
            else ws.send(`echo:${t.length}`);
          },
        })
        .listen({
          port: 0,
          backend,
          wsPerMessageDeflate: deflate,
          wsMaxPayload: max,
          threads: 1,
        });
      servers.push(s);
      return s;
    };

    test("negotiates the extension and compresses what the server sends", async () => {
      const s = make(true);
      const c = await Raw.open(
        s.port,
        "permessage-deflate; client_max_window_bits",
      );
      expect(c.header("sec-websocket-extensions")).toContain(
        "permessage-deflate",
      );
      c.sendText("big");
      const m = await c.message();
      expect(m.rsv1).toBe(true);
      expect(m.text).toBe(BIG);
      expect(m.wire).toBeLessThan(BIG.length / 5);
      c.close();
    });

    test("inflates what the client sends compressed, big and small", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate");
      c.sendCompressed(BIG);
      expect((await c.message()).text).toBe(`echo:${BIG.length}`);
      c.sendCompressed("hello there");
      expect((await c.message()).text).toBe("echo:11");
      c.sendText("plain still works");
      expect((await c.message()).text).toBe("echo:17");
      c.close();
    });

    test("small messages are sent as they are", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate");
      c.sendText("small");
      const m = await c.message();
      expect([m.text, m.rsv1]).toEqual(["tiny", false]);
      c.close();
    });

    test("no extension without the option, or when the client does not offer it", async () => {
      const off = make(false);
      const a = await Raw.open(off.port, "permessage-deflate");
      expect(a.header("sec-websocket-extensions")).toBeUndefined();
      a.sendText("big");
      expect((await a.message()).rsv1).toBe(false);
      a.close();
      const on = make(true);
      const b = await Raw.open(on.port, null);
      expect(b.header("sec-websocket-extensions")).toBeUndefined();
      b.sendText("big");
      expect((await b.message()).rsv1).toBe(false);
      b.close();
    });

    test("shared mode keeps no context between messages; dedicated does", async () => {
      const shared = make(true);
      const a = await Raw.open(shared.port, "permessage-deflate");
      expect(a.header("sec-websocket-extensions")).toContain(
        "server_no_context_takeover",
      );
      a.sendText("bigtwice");
      const [a1, a2] = [await a.message(), await a.message()];
      expect(a1.wire).toBe(a2.wire);
      a.close();

      const ded = make({ compress: "dedicated" });
      const b = await Raw.open(ded.port, "permessage-deflate");
      expect(b.header("sec-websocket-extensions")).not.toContain(
        "server_no_context_takeover",
      );
      b.sendText("bigtwice");
      const [m1, m2] = [await b.message(), await b.message()];
      expect([m1.text, m2.text]).toEqual([BIG, BIG]); // decoded by one inflater that carries its window over
      expect(m2.wire).toBeLessThan(m1.wire); // the second copy is a back-reference
      b.close();
    });

    test("honours the client's no-context-takeover and window limits", async () => {
      const s = make({ compress: "dedicated" });
      const c = await Raw.open(
        s.port,
        "permessage-deflate; server_no_context_takeover; server_max_window_bits=10; client_no_context_takeover",
      );
      const ext = c.header("sec-websocket-extensions")!;
      expect(ext).toContain("server_no_context_takeover");
      expect(ext).toContain("client_no_context_takeover");
      expect(ext).toContain("server_max_window_bits=10");
      c.sendText("bigtwice");
      const [m1, m2] = [await c.message(), await c.message()];
      expect(m1.text).toBe(BIG);
      expect(m1.wire).toBe(m2.wire);
      c.close();
    });

    test("an offer the server cannot honour is declined and the socket still works uncompressed", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate; unknown_param=1");
      expect(c.header("sec-websocket-extensions")).toBeUndefined();
      c.sendText("big");
      const m = await c.message();
      expect([m.rsv1, m.text]).toEqual([false, BIG]);
      c.close();
      // The second offer in the list is taken when the first is unusable.
      const d = await Raw.open(
        s.port,
        "permessage-deflate; server_max_window_bits=8, permessage-deflate",
      );
      expect(d.header("sec-websocket-extensions")).toBe(
        "permessage-deflate; server_no_context_takeover",
      );
      d.close();
    });

    test("a decompression bomb is refused with 1009", async () => {
      const s = make(true, 100_000);
      const c = await Raw.open(s.port, "permessage-deflate");
      const z = deflateRawSync(Buffer.alloc(5_000_000, 97), { finishFlush: 2 });
      expect(z.length).toBeLessThan(20_000); // tiny on the wire
      c.send(2, z.subarray(0, z.length - 4), true);
      const f = await c.next();
      expect(f.op).toBe(8);
      expect(f.payload.readUInt16BE(0)).toBe(1009);
      c.close();
    });

    test("corrupt compressed data closes with 1007", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate");
      c.send(1, Buffer.from("this is not deflate data at all"), true);
      const f = await c.next();
      expect(f.op).toBe(8);
      expect(f.payload.readUInt16BE(0)).toBe(1007);
      c.close();
    });

    test("fragmented compressed messages are reassembled", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate");
      const z = deflateRawSync(Buffer.from(BIG), { finishFlush: 2 });
      const body = z.subarray(0, z.length - 4);
      const half = body.length >> 1;
      const frame = (fin: boolean, op: number, rsv1: boolean, p: Buffer) => {
        const key = randomBytes(4);
        const m = Buffer.from(p);
        for (let i = 0; i < m.length; i++) m[i] ^= key[i & 3];
        const h =
          m.length < 126
            ? Buffer.from([
                (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | op,
                0x80 | m.length,
              ])
            : Buffer.from([
                (fin ? 0x80 : 0) | (rsv1 ? 0x40 : 0) | op,
                0x80 | 126,
                m.length >> 8,
                m.length & 255,
              ]);
        return Buffer.concat([h, key, m]);
      };
      c.sock.write(frame(false, 1, true, body.subarray(0, half)));
      // a ping may arrive between fragments
      c.sock.write(frame(true, 9, false, Buffer.from("p")));
      c.sock.write(frame(true, 0, false, body.subarray(half)));
      expect((await c.message()).text).toBe(`echo:${BIG.length}`);
      c.close();
    });

    test("ping, pong and the close handshake work through the bridge", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate");
      c.send(9, Buffer.from("hi"));
      let f = await c.next();
      expect([f.op, f.payload.toString()]).toEqual([10, "hi"]);
      c.sendText("close");
      f = await c.next();
      expect(f.op).toBe(8);
      expect(f.payload.readUInt16BE(0)).toBe(1000);
      c.send(8, Buffer.from([0x03, 0xe8]));
      for (let i = 0; i < 40 && !c.closed; i++)
        await new Promise((r) => setTimeout(r, 100));
      expect(c.closed).toBe(true);
    });

    test("pub/sub reaches compressed and plain sockets alike, each in its own encoding", async () => {
      const s = make(true);
      const z = await Raw.open(s.port, "permessage-deflate");
      const p = await Raw.open(s.port, null);
      const sender = await Raw.open(s.port, null); // a sender does not receive its own publish
      await new Promise((r) => setTimeout(r, 50));
      sender.sendText("pub");
      const [mz, mp] = [await z.message(), await p.message()];
      sender.close();
      expect([mz.text, mz.rsv1]).toEqual([BIG, true]);
      expect([mp.text, mp.rsv1]).toEqual([BIG, false]);
      expect(mz.wire).toBeLessThan(mp.wire / 5);
      z.close();
      p.close();
    });

    test("works with Bun's own WebSocket client, both directions, and the subprotocol survives", async () => {
      const s = new App()
        .ws("/ws", { message: (ws, m) => ws.send(String(m).toUpperCase()) })
        .listen({ port: 0, backend, wsPerMessageDeflate: true });
      servers.push(s);
      const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
      const got = await new Promise<{ text: string; ext: string }>(
        (res, rej) => {
          ws.onopen = () => ws.send(BIG);
          ws.onmessage = (e) =>
            res({ text: String(e.data), ext: ws.extensions });
          ws.onerror = () => rej(new Error("ws error"));
        },
      );
      expect(got.text).toBe(BIG.toUpperCase());
      expect(got.ext).toContain("permessage-deflate");
      ws.close();

      const sub = await Raw.open(s.port, "permessage-deflate", "/ws", "chat");
      expect(sub.header("sec-websocket-extensions")).toContain(
        "permessage-deflate",
      );
      sub.close();
    });

    test("a megabyte message in each direction", async () => {
      const s = make(true);
      const c = await Raw.open(s.port, "permessage-deflate");
      const big = "0123456789abcdef".repeat(65536); // 1 MiB
      c.sendCompressed(big);
      expect((await c.message()).text).toBe(`echo:${big.length}`);
      c.close();
    });
  });
}
