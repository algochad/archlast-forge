import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { App, Reply, type BackendName, type Server } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A raw WebSocket client over node:net: does the handshake itself, so a test can then ignore pings or stop reading. */
function rawWs(
  port: number,
  path: string,
  extraHeaders = "",
): Promise<{
  sock: net.Socket;
  head: string;
  status: number;
  closed: () => boolean;
  received: () => number;
}> {
  return new Promise((resolve, reject) => {
    const key = randomBytes(16).toString("base64");
    const sock = net.connect(port, "127.0.0.1");
    let buf = "",
      done = false,
      isClosed = false,
      bytes = 0;
    sock.on("connect", () =>
      sock.write(
        `GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n${extraHeaders}\r\n`,
      ),
    );
    sock.on("data", (d) => {
      bytes += d.length;
      if (done) return;
      buf += d.toString("latin1");
      const i = buf.indexOf("\r\n\r\n");
      if (i === -1) return;
      done = true;
      const head = buf.slice(0, i);
      resolve({
        sock,
        head,
        status: Number(head.split(" ")[1]),
        closed: () => isClosed,
        received: () => bytes,
      });
    });
    sock.on("close", () => {
      isClosed = true;
      if (!done) reject(new Error("closed before handshake"));
    });
    sock.on("error", () => {});
  });
}

function client(url: string, protocols?: string[]) {
  const ws = new WebSocket(url, protocols);
  ws.binaryType = "arraybuffer";
  const inbox: any[] = [];
  let close: { code: number; reason: string } | null = null;
  ws.onmessage = (e) => inbox.push(e.data);
  ws.onclose = (e) => (close = { code: e.code, reason: e.reason });
  const opened = new Promise<void>(
    (res, rej) => (
      (ws.onopen = () => res()),
      (ws.onerror = () => rej(new Error("ws error")))
    ),
  );
  return {
    ws,
    opened,
    inbox,
    get closed() {
      return close;
    },
    async waitFor(n: number, ms = 3000) {
      for (let t = 0; inbox.length < n && t < ms; t += 10) await sleep(10);
      return inbox.length >= n;
    },
    async waitClosed(ms = 3000) {
      for (let t = 0; !close && t < ms; t += 10) await sleep(10);
      return close;
    },
  };
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`WebSocket parity: ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const track = (s: Server) => (servers.push(s), s);

    test("subprotocol negotiation: the first offered is echoed by default, a hook may choose another, none stays empty", async () => {
      const s = track(
        new App()
          .ws("/p", { open: (ws) => ws.send(`proto=${ws.subprotocol}`) })
          .ws("/p2", {
            upgrade: () => ({ protocol: "other" }),
            open: (ws) => ws.send(`proto=${ws.subprotocol}`),
          })
          .listen({ port: 0, backend }),
      );
      const a = client(`ws://127.0.0.1:${s.port}/p`, ["graphql-ws", "second"]);
      await a.opened;
      expect(a.ws.protocol).toBe("graphql-ws");
      await a.waitFor(1);
      expect(a.inbox[0]).toBe("proto=graphql-ws");
      const b = client(`ws://127.0.0.1:${s.port}/p2`, ["graphql-ws", "other"]);
      await b.opened;
      expect(b.ws.protocol).toBe("other");
      const c = client(`ws://127.0.0.1:${s.port}/p`);
      await c.opened;
      expect(c.ws.protocol).toBe("");
      [a, b, c].forEach((x) => x.ws.close());
    });

    test("an upgrade hook can refuse with its own response, accept asynchronously, attach data and add headers", async () => {
      const s = track(
        new App()
          .ws("/guard", {
            upgrade: async (c) => {
              await sleep(20);
              if (c.query.t === "no") return false;
              if (c.query.t === "429")
                return new Reply("slow down", {
                  status: 429,
                  headers: { "retry-after": "7" },
                });
              return {
                data: { user: c.query.u ?? "anon" },
                headers: { "x-welcome": "hi" },
              };
            },
            open: (ws) => ws.send(JSON.stringify(ws.data)),
          })
          .listen({ port: 0, backend }),
      );
      const ok = client(`ws://127.0.0.1:${s.port}/guard?u=ada`);
      await ok.opened;
      await ok.waitFor(1);
      expect(JSON.parse(ok.inbox[0])).toEqual({ user: "ada" });
      ok.ws.close();
      const h = await rawWs(s.port, "/guard?u=x");
      expect([
        h.status,
        h.head.toLowerCase().includes("x-welcome: hi"),
      ]).toEqual([101, true]);
      h.sock.destroy();
      for (const [t, status] of [
        ["no", 403],
        ["429", 429],
      ] as const) {
        const r = await rawWs(s.port, `/guard?t=${t}`);
        expect([t, r.status]).toEqual([t, status]);
        r.sock.destroy();
      }
      expect(
        (await rawWs(s.port, "/guard?t=429")).head.toLowerCase(),
      ).toContain("retry-after: 7");
      await expect(
        client(`ws://127.0.0.1:${s.port}/guard?t=no`).opened,
      ).rejects.toThrow();
    });

    test("prefix routes ('/gw/*') accept any path under the prefix and report the full url", async () => {
      const s = track(
        new App()
          .ws("/gw/*", { open: (ws) => ws.send(ws.url) })
          .listen({ port: 0, backend }),
      );
      for (const p of ["/gw/a", "/gw/a/b/c?x=1&y=2", "/gw/"]) {
        const c = client(`ws://127.0.0.1:${s.port}${p}`);
        await c.opened;
        await c.waitFor(1);
        expect([p, c.inbox[0]]).toEqual([p, p]);
        c.ws.close();
      }
      await expect(
        client(`ws://127.0.0.1:${s.port}/other`).opened,
      ).rejects.toThrow();
    });

    test("a message over wsMaxPayload closes the socket with 1009; smaller ones still work", async () => {
      const s = track(
        new App()
          .ws("/ws", {
            message: (ws, m) =>
              ws.send(
                `len=${typeof m === "string" ? m.length : (m as Uint8Array).length}`,
              ),
          })
          .listen({ port: 0, backend, wsMaxPayload: 1000 }),
      );
      const c = client(`ws://127.0.0.1:${s.port}/ws`);
      await c.opened;
      c.ws.send("x".repeat(900));
      await c.waitFor(1);
      expect(c.inbox[0]).toBe("len=900");
      c.ws.send("y".repeat(5000));
      expect((await c.waitClosed())?.code).toBe(1009);
    });

    test("close code and reason travel both ways", async () => {
      const seen: { code: number; reason: string }[] = [];
      const s = track(
        new App()
          .ws("/ws", {
            message: (ws, m) => m === "kick" && ws.close(4001, "kicked"),
            close: (_ws, code, reason) => void seen.push({ code, reason }),
          })
          .listen({ port: 0, backend }),
      );
      const a = client(`ws://127.0.0.1:${s.port}/ws`);
      await a.opened;
      a.ws.close(4000, "bye now");
      for (let i = 0; i < 100 && seen.length < 1; i++) await sleep(10);
      expect(seen[0]).toEqual({ code: 4000, reason: "bye now" });
      const b = client(`ws://127.0.0.1:${s.port}/ws`);
      await b.opened;
      b.ws.send("kick");
      expect(await b.waitClosed()).toEqual({ code: 4001, reason: "kicked" });
    });

    test("messages arrive in order in both directions", async () => {
      const s = track(
        new App()
          .ws("/ws", {
            open: (ws) => {
              for (let i = 0; i < 500; i++) ws.send(`s${i}`);
            },
            message: (ws, m) => ws.send(m),
          })
          .listen({ port: 0, backend }),
      );
      const c = client(`ws://127.0.0.1:${s.port}/ws`);
      await c.opened;
      for (let i = 0; i < 500; i++) c.ws.send(`c${i}`);
      expect(await c.waitFor(1000)).toBe(true);
      expect(c.inbox.slice(0, 500)).toEqual(
        Array.from({ length: 500 }, (_, i) => `s${i}`),
      );
      expect(c.inbox.slice(500)).toEqual(
        Array.from({ length: 500 }, (_, i) => `c${i}`),
      );
      c.ws.close();
    });

    test("server.sockets reaches a socket by id from outside any handler; readyState, remoteAddress and send() results", async () => {
      const ids: number[] = [];
      const info: unknown[] = [];
      const s = track(
        new App()
          .ws("/ws", {
            open: (ws) => {
              ids.push(ws.id);
              info.push({
                rs: ws.readyState,
                ra: ws.remoteAddress,
                n: ws.send("héllo"),
                b: ws.send(new Uint8Array([1, 2, 3]).buffer),
              });
            },
          })
          .listen({ port: 0, backend }),
      );
      const c = client(`ws://127.0.0.1:${s.port}/ws`);
      await c.opened;
      await c.waitFor(2);
      expect(info[0]).toEqual({ rs: 1, ra: "127.0.0.1", n: 6, b: 3 });
      s.sockets.send(ids[0], "pushed");
      await c.waitFor(3);
      expect(c.inbox[2]).toBe("pushed");
      s.sockets.close(ids[0], 4002, "server says bye");
      expect(await c.waitClosed()).toEqual({
        code: 4002,
        reason: "server says bye",
      });
    });

    test("transport pings keep a live client past wsIdleTimeout, while a client that never answers is reaped", async () => {
      const closed: number[] = [];
      const s = track(
        new App()
          .ws("/ws", { close: (_ws, code) => void closed.push(code) })
          .listen({ port: 0, backend, wsPingInterval: 1, wsIdleTimeout: 3 }),
      );
      const live = client(`ws://127.0.0.1:${s.port}/ws`); // the WebSocket client answers pings by itself
      await live.opened;
      const dead = await rawWs(s.port, "/ws"); // reads pings but never answers them
      await sleep(6000);
      expect(live.closed).toBeNull();
      expect(dead.closed()).toBe(true);
      expect(closed.length).toBe(1);
      live.ws.close();
    }, 20_000);

    test("a client that stops reading is dropped once its backlog exceeds wsBackpressureLimit, and others are unaffected", async () => {
      const closes: number[] = [];
      const big = "z".repeat(100_000);
      const s = track(
        new App()
          .ws("/flood", {
            open: (ws) => {
              for (let i = 0; i < 400; i++) ws.send(big);
            },
            close: (_ws, code) => void closes.push(code),
          })
          .ws("/echo", { message: (ws, m) => ws.send(m) })
          .listen({ port: 0, backend, wsBackpressureLimit: 500_000 }),
      );
      const slow = await rawWs(s.port, "/flood");
      slow.sock.pause(); // never read: the socket buffers fill and the server's backlog grows
      const fine = client(`ws://127.0.0.1:${s.port}/echo`);
      await fine.opened;
      for (let i = 0; i < 100 && closes.length === 0; i++) await sleep(50);
      expect(closes).toEqual([1006]); // dropped abruptly, not closed politely
      fine.ws.send("still here");
      await fine.waitFor(1);
      expect(fine.inbox[0]).toBe("still here");
      fine.ws.close();
      slow.sock.destroy();
    }, 20_000);
  });
}
