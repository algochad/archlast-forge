import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { App, type BackendName, type Server } from "../src/index.ts";

interface Frame {
  fin: boolean;
  rsv: number;
  op: number;
  payload: Buffer;
}

/** A raw WebSocket client: sends exactly the bytes it is told to, so malformed frames are possible. */
class Raw {
  sock!: net.Socket;
  buf = Buffer.alloc(0);
  frames: Frame[] = [];
  head = "";
  closed = false;
  waiters: (() => void)[] = [];

  static async open(port: number): Promise<Raw> {
    const r = new Raw();
    await new Promise<void>((res, rej) => {
      r.sock = net.connect(port, "127.0.0.1", () =>
        r.sock.write(
          `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${randomBytes(16).toString("base64")}\r\nSec-WebSocket-Version: 13\r\n\r\n`,
        ),
      );
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
        rsv: (b[0] >> 4) & 7,
        op: b[0] & 0xf,
        payload: Buffer.from(b.subarray(off, off + len)),
      });
      this.buf = b.subarray(off + len);
      this.wake();
    }
  }

  async next(ms = 2000): Promise<Frame> {
    const end = Date.now() + ms;
    while (this.frames.length === 0) {
      if (this.closed) throw new Error("socket closed");
      if (Date.now() > end) throw new Error("timed out");
      await new Promise<void>((r) => {
        this.waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return this.frames.shift()!;
  }

  /** Next data message (text or binary) or throws on a close. */
  async text(): Promise<string> {
    for (;;) {
      const f = await this.next();
      if (f.op === 1 || f.op === 2) return f.payload.toString();
      if (f.op === 8)
        throw new Error(
          `closed ${f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005}`,
        );
    }
  }

  async closeCode(): Promise<number> {
    for (;;) {
      const f = await this.next();
      if (f.op === 8)
        return f.payload.length >= 2 ? f.payload.readUInt16BE(0) : 1005;
    }
  }

  /** One frame; `mask` false sends it unmasked (a violation by a client). */
  frame(
    op: number,
    payload: Buffer | string,
    o: { fin?: boolean; mask?: boolean; rsv?: number } = {},
  ): Buffer {
    const p = Buffer.from(payload);
    const fin = o.fin ?? true,
      mask = o.mask ?? true;
    const n = p.length;
    const first = (fin ? 0x80 : 0) | ((o.rsv ?? 0) << 4) | op;
    const m = mask ? 0x80 : 0;
    const head =
      n < 126
        ? Buffer.from([first, m | n])
        : n < 65536
          ? Buffer.from([first, m | 126, n >> 8, n & 255])
          : (() => {
              const h = Buffer.alloc(10);
              h[0] = first;
              h[1] = m | 127;
              h.writeBigUInt64BE(BigInt(n), 2);
              return h;
            })();
    if (!mask) return Buffer.concat([head, p]);
    const key = randomBytes(4);
    const masked = Buffer.from(p);
    for (let i = 0; i < n; i++) masked[i] ^= key[i & 3];
    return Buffer.concat([head, key, masked]);
  }

  send(...bufs: Buffer[]) {
    this.sock.write(Buffer.concat(bufs));
  }
  destroy() {
    this.sock.destroy();
  }
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`WebSocket protocol (uWebSockets framing): ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const make = (max?: number) => {
      const events: string[] = [];
      const s = new App()
        .ws("/ws", {
          message: (ws, m) =>
            ws.send(
              `echo:${typeof m === "string" ? m : "bin" + (m as Uint8Array).length}`,
            ),
          ping: () => events.push("ping"),
          pong: () => events.push("pong"),
          close: (_ws, code) => events.push(`close:${code}`),
        })
        .listen({ port: 0, backend, wsMaxPayload: max, threads: 1 });
      servers.push(s);
      return { s, events };
    };

    test("text and binary messages, any size class, split into tiny TCP writes", async () => {
      const { s } = make();
      const c = await Raw.open(s.port);
      c.send(c.frame(1, "short"));
      expect(await c.text()).toBe("echo:short");
      c.send(c.frame(1, "x".repeat(300)));
      expect(await c.text()).toBe(`echo:${"x".repeat(300)}`);
      c.send(c.frame(2, Buffer.alloc(70_000, 1)));
      expect(await c.text()).toBe("echo:bin70000");
      // byte by byte
      const f = c.frame(1, "dribble");
      for (const b of f) {
        c.sock.write(Buffer.from([b]));
        await new Promise((r) => setTimeout(r, 1));
      }
      expect(await c.text()).toBe("echo:dribble");
      c.destroy();
    });

    test("fragmented messages, with a UTF-8 character split across fragments and pings in between", async () => {
      const { s } = make();
      const c = await Raw.open(s.port);
      const euro = Buffer.from("€"); // 3 bytes
      c.send(
        c.frame(1, Buffer.concat([Buffer.from("a"), euro.subarray(0, 1)]), {
          fin: false,
        }),
      );
      c.send(c.frame(9, "mid-ping"));
      c.send(c.frame(0, euro.subarray(1), { fin: false }));
      c.send(c.frame(0, "z", { fin: true }));
      const pong = await c.next();
      expect([pong.op, pong.payload.toString()]).toEqual([10, "mid-ping"]); // answered between fragments
      expect(await c.text()).toBe("echo:a€z");
      c.destroy();
    });

    test("a ping is answered with the same payload and reaches the handler; a pong reaches it too", async () => {
      const { s, events } = make();
      const c = await Raw.open(s.port);
      c.send(c.frame(9, "hello"), c.frame(10, "unsolicited"));
      const f = await c.next();
      expect([f.op, f.payload.toString()]).toEqual([10, "hello"]);
      await new Promise((r) => setTimeout(r, 100));
      expect(events).toEqual(["ping", "pong"]);
      c.destroy();
    });

    test("protocol violations close with the right code", async () => {
      const { s } = make();
      const cases: [string, (c: Raw) => void, number][] = [
        [
          "unmasked frame from the client",
          (c) => c.send(c.frame(1, "hi", { mask: false })),
          1002,
        ],
        [
          "invalid UTF-8 in a text message",
          (c) => c.send(c.frame(1, Buffer.from([0xff, 0xfe, 0xfd]))),
          1007,
        ],
        [
          "invalid UTF-8 completed by a later fragment",
          (c) =>
            c.send(
              c.frame(1, Buffer.from([0xe2, 0x82]), { fin: false }),
              c.frame(0, Buffer.from([0x41]), { fin: true }),
            ),
          1007,
        ],
        ["reserved opcode 3", (c) => c.send(c.frame(3, "x")), 1002],
        ["reserved opcode 11", (c) => c.send(c.frame(11, "x")), 1002],
        ["RSV2 set", (c) => c.send(c.frame(1, "x", { rsv: 2 })), 1002],
        [
          "RSV1 set without compression negotiated",
          (c) => c.send(c.frame(1, "x", { rsv: 4 })),
          1002,
        ],
        [
          "a fragmented control frame",
          (c) => c.send(c.frame(9, "x", { fin: false })),
          1002,
        ],
        [
          "a control frame over 125 bytes",
          (c) => c.send(c.frame(9, Buffer.alloc(126))),
          1002,
        ],
        [
          "a continuation with nothing to continue",
          (c) => c.send(c.frame(0, "x")),
          1002,
        ],
        [
          "a new message inside a fragmented one",
          (c) => c.send(c.frame(1, "a", { fin: false }), c.frame(1, "b")),
          1002,
        ],
        [
          "a close frame with a one-byte payload",
          (c) => c.send(c.frame(8, Buffer.from([0x03]))),
          1002,
        ],
        [
          "a close frame with the reserved code 1005",
          (c) => c.send(c.frame(8, Buffer.from([0x03, 0xed]))),
          1002,
        ],
        [
          "a close frame with a code in the reserved range",
          (c) => c.send(c.frame(8, Buffer.from([0x07, 0xd0]))),
          1002,
        ],
        [
          "a close frame with an invalid UTF-8 reason",
          (c) => c.send(c.frame(8, Buffer.from([0x03, 0xe8, 0xff, 0xfe]))),
          1007,
        ],
      ];
      for (const [name, run, code] of cases) {
        const c = await Raw.open(s.port);
        run(c);
        expect([name, await c.closeCode()]).toEqual([name, code]);
        c.destroy();
      }
    });

    test("a valid close frame is answered with the same code; with no status the reply is empty", async () => {
      const { s, events } = make();
      const a = await Raw.open(s.port);
      a.send(
        a.frame(
          8,
          Buffer.concat([Buffer.from([0x03, 0xe9]), Buffer.from("going")]),
        ),
      ); // 1001
      const f = await a.next();
      expect([f.op, f.payload.readUInt16BE(0)]).toEqual([8, 1001]);
      const b = await Raw.open(s.port);
      b.send(b.frame(8, Buffer.alloc(0)));
      const g = await b.next();
      expect([g.op, g.payload.length]).toEqual([8, 0]);
      await new Promise((r) => setTimeout(r, 150));
      expect(events).toContain("close:1001");
      expect(events).toContain("close:1005");
      a.destroy();
      b.destroy();
    });

    test("too big: one frame over the limit, and fragments that add up to more", async () => {
      const { s } = make(1000);
      const a = await Raw.open(s.port);
      a.send(a.frame(1, "y".repeat(1001)));
      expect(await a.closeCode()).toBe(1009);
      const b = await Raw.open(s.port);
      b.send(
        b.frame(1, "y".repeat(600), { fin: false }),
        b.frame(0, "y".repeat(600)),
      );
      expect(await b.closeCode()).toBe(1009);
      const ok = await Raw.open(s.port);
      ok.send(ok.frame(1, "y".repeat(1000)));
      expect(await ok.text()).toBe(`echo:${"y".repeat(1000)}`);
      a.destroy();
      b.destroy();
      ok.destroy();
    });

    test("a peer that disappears mid-frame is reported as 1006", async () => {
      const { s, events } = make();
      const c = await Raw.open(s.port);
      c.sock.write(c.frame(1, "never finished").subarray(0, 5));
      await new Promise((r) => setTimeout(r, 50));
      c.destroy();
      for (let i = 0; i < 40 && !events.includes("close:1006"); i++)
        await new Promise((r) => setTimeout(r, 25));
      expect(events).toContain("close:1006");
    });

    test("handshake errors: wrong version gets 426 with the supported version, a bad key 400", async () => {
      const { s } = make();
      const talk = (headers: string) =>
        new Promise<string>((res) => {
          const sock = net.connect(s.port, "127.0.0.1", () =>
            sock.write(
              `GET /ws HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n${headers}\r\n`,
            ),
          );
          let d = "";
          sock.on("data", (c) => {
            d += c;
            if (d.includes("\r\n\r\n")) {
              sock.destroy();
              res(d);
            }
          });
        });
      const v = await talk(
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 8\r\n",
      );
      expect(v.split("\r\n")[0]).toContain("426");
      expect(v.toLowerCase()).toContain("sec-websocket-version: 13");
      expect(
        (
          await talk(
            "Sec-WebSocket-Key: short\r\nSec-WebSocket-Version: 13\r\n",
          )
        ).split("\r\n")[0],
      ).toContain("400");
      expect(
        (await talk("Sec-WebSocket-Version: 13\r\n")).split("\r\n")[0],
      ).toContain("400");
      const ok = await talk(
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n",
      );
      expect(ok.split("\r\n")[0]).toContain("101");
      expect(ok).toContain("s3pPLMBiTxaQ9kYGzzhZRbK+xOo="); // the accept key from RFC 6455
    });
  });
}
