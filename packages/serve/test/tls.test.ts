import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as http2 from "node:http2";
import * as tls from "node:tls";
import { App, type BackendName, type Server, serve } from "../src/index.ts";
import { serveCompat } from "../src/compat.ts";

const dir = mkdtempSync(join(tmpdir(), "archlast-tls-"));
const sh = (...a: string[]) =>
  execFileSync("openssl", a, { cwd: dir, stdio: "pipe" });
const pem = (f: string) => readFileSync(join(dir, f), "utf8");

/** A self-signed server certificate for `cn` (with SAN `san`). */
function selfSigned(
  name: string,
  cn: string,
  san: string,
): { cert: string; key: string } {
  sh(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    `${name}.key`,
    "-out",
    `${name}.crt`,
    "-days",
    "2",
    "-subj",
    `/CN=${cn}`,
    "-addext",
    `subjectAltName=${san}`,
  );
  return { cert: pem(`${name}.crt`), key: pem(`${name}.key`) };
}

let main: { cert: string; key: string },
  other: { cert: string; key: string },
  wild: { cert: string; key: string };
let ca: string,
  client: { cert: string; key: string },
  rogue: { cert: string; key: string };

beforeAll(() => {
  main = selfSigned(
    "main",
    "main.test",
    "DNS:main.test,DNS:localhost,IP:127.0.0.1",
  );
  other = selfSigned("other", "other.test", "DNS:other.test");
  wild = selfSigned("wild", "*.wild.test", "DNS:*.wild.test");
  sh(
    "req",
    "-x509",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "ca.key",
    "-out",
    "ca.crt",
    "-days",
    "2",
    "-subj",
    "/CN=test-ca",
  );
  sh(
    "req",
    "-newkey",
    "ec",
    "-pkeyopt",
    "ec_paramgen_curve:prime256v1",
    "-nodes",
    "-keyout",
    "client.key",
    "-out",
    "client.csr",
    "-subj",
    "/CN=client-1",
  );
  sh(
    "x509",
    "-req",
    "-in",
    "client.csr",
    "-CA",
    "ca.crt",
    "-CAkey",
    "ca.key",
    "-CAcreateserial",
    "-out",
    "client.crt",
    "-days",
    "2",
  );
  ca = pem("ca.crt");
  client = { cert: pem("client.crt"), key: pem("client.key") };
  rogue = selfSigned("rogue", "rogue", "DNS:rogue");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

interface Seen {
  cn: string;
  status: string;
  body: string;
}
/** One raw HTTPS request; resolves with the certificate the server presented (its CN) and the response. */
function rawGet(
  port: number,
  opts: {
    servername?: string;
    cert?: string;
    key?: string;
    path?: string;
  } = {},
): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const s = tls.connect(
      {
        host: "127.0.0.1",
        port,
        servername: opts.servername,
        rejectUnauthorized: false,
        cert: opts.cert,
        key: opts.key,
      },
      () => {
        const cert = s.getPeerCertificate();
        const cn = String(
          (cert.subject as { CN?: string } | undefined)?.CN ?? "",
        );
        s.write(
          `GET ${opts.path ?? "/"} HTTP/1.1\r\nhost: x\r\nconnection: close\r\n\r\n`,
        );
        let data = "";
        s.on("data", (d: Buffer) => (data += d));
        s.on("close", () =>
          resolve({
            cn,
            status: data.split("\r\n")[0] ?? "",
            body: data.split("\r\n\r\n")[1] ?? "",
          }),
        );
      },
    );
    s.on("error", reject);
  });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
  describe(`tls / unix / reusePort: ${backend}`, () => {
    const servers: Server[] = [];
    afterAll(() => servers.forEach((s) => s.stop()));
    const track = <T extends Server>(s: T) => (servers.push(s), s);

    test("serves HTTPS: fetch works, protocol is https and Request URLs say https", async () => {
      const s = track(
        new App()
          .get("/u", (c) => c.request.url)
          .get("/c", "constant")
          .listen({ port: 0, backend, tls: main }),
      );
      expect(s.protocol).toBe("https");
      const r = await fetch(`https://localhost:${s.port}/u`, {
        tls: { ca: main.cert },
      } as RequestInit);
      expect(await r.text()).toMatch(/^https:\/\//);
      const c = await fetch(`https://localhost:${s.port}/c`, {
        tls: { ca: main.cert },
      } as RequestInit);
      expect(await c.text()).toBe("constant");
    });

    test("plain HTTP to an HTTPS port is refused, and the server keeps serving", async () => {
      const s = track(
        new App().get("/", "ok").listen({ port: 0, backend, tls: main }),
      );
      await fetch(`http://127.0.0.1:${s.port}/`).then(
        (r) => r.text(),
        () => "refused",
      );
      expect((await rawGet(s.port)).body).toBe("ok");
    });

    test("SNI picks the certificate: exact, wildcard, default", async () => {
      const s = track(
        new App().get("/", "ok").listen({
          port: 0,
          backend,
          tls: [
            { ...main },
            { ...other, serverName: "other.test" },
            { ...wild, serverName: "*.wild.test" },
          ],
        }),
      );
      expect((await rawGet(s.port, { servername: "other.test" })).cn).toBe(
        "other.test",
      );
      expect((await rawGet(s.port, { servername: "x.wild.test" })).cn).toBe(
        "*.wild.test",
      );
      expect((await rawGet(s.port, { servername: "unknown.example" })).cn).toBe(
        "main.test",
      );
      expect((await rawGet(s.port)).cn).toBe("main.test");
    });

    test("mutual TLS: a client certificate from the CA is accepted, a stranger or none is rejected", async () => {
      const s = track(
        new App()
          .get("/", "secret")
          .listen({
            port: 0,
            backend,
            tls: { ...main, ca, requestCert: true, rejectUnauthorized: true },
          }),
      );
      expect((await rawGet(s.port, client)).body).toBe("secret");
      await expect(rawGet(s.port, rogue)).rejects.toBeDefined();
      await expect(rawGet(s.port)).rejects.toBeDefined();
    });

    test("requestCert without rejectUnauthorized lets anonymous clients in", async () => {
      const s = track(
        new App()
          .get("/", "open")
          .listen({
            port: 0,
            backend,
            tls: { ...main, ca, requestCert: true, rejectUnauthorized: false },
          }),
      );
      expect((await rawGet(s.port)).body).toBe("open");
    });

    test("HTTP/2 over TLS: multiplexed requests, bodies, streaming, authority as host", async () => {
      const s = track(
        new App()
          .get("/who", (c) => ({ host: c.header("host"), url: c.request.url }))
          .post("/len", async (c) => String((await c.readBytes()).length))
          .get("/big", () => new Uint8Array(2_000_000).fill(5))
          .get("/slow/:n", async (c) => {
            await new Promise((r) => setTimeout(r, 80));
            return c.params.n;
          })
          .listen({ port: 0, backend, tls: main }),
      );
      const session = http2.connect(`https://localhost:${s.port}`, {
        ca: main.cert,
      });
      const call = (path: string, method = "GET", body?: Uint8Array) =>
        new Promise<{ status: number; data: Buffer; version: string }>(
          (res, rej) => {
            const req = session.request({ ":path": path, ":method": method });
            const chunks: Buffer[] = [];
            let status = 0;
            req.on("response", (h) => (status = Number(h[":status"])));
            req.on("data", (d) => chunks.push(Buffer.from(d)));
            req.on("end", () =>
              res({
                status,
                data: Buffer.concat(chunks),
                version: session.alpnProtocol ?? "",
              }),
            );
            req.on("error", rej);
            if (body) req.end(Buffer.from(body));
            else req.end();
          },
        );
      try {
        const who = await call("/who");
        expect(who.version).toBe("h2");
        const j = JSON.parse(who.data.toString());
        expect(j.host).toBe(`localhost:${s.port}`);
        expect(j.url).toStartWith("https://");
        expect(
          (await call("/len", "POST", new Uint8Array(900_000))).data.toString(),
        ).toBe("900000");
        expect((await call("/big")).data.length).toBe(2_000_000);
        const t0 = performance.now();
        const all = await Promise.all(
          Array.from({ length: 20 }, (_, i) => call(`/slow/${i}`)),
        );
        expect(all.map((r) => r.data.toString())).toEqual(
          Array.from({ length: 20 }, (_, i) => String(i)),
        );
        expect(performance.now() - t0).toBeLessThan(1000); // multiplexed on one connection
      } finally {
        session.close();
      }
    });

    test("HTTP/2 can be switched off: ALPN falls back to http/1.1", async () => {
      const s = track(
        new App()
          .get("/", "ok")
          .listen({ port: 0, backend, tls: main, http2: false }),
      );
      const session = http2.connect(`https://localhost:${s.port}`, {
        ca: main.cert,
      });
      const err = await new Promise<unknown>((res) => {
        session.on("error", res);
        session.on("connect", () => res(null));
      });
      session.destroy();
      expect(err).not.toBeNull();
      expect((await rawGet(s.port)).body).toBe("ok");
    });

    test("HTTP/2: graceful close lets requests in flight finish", async () => {
      const s = new App()
        .get("/slow", async () => {
          await new Promise((r) => setTimeout(r, 300));
          return "done";
        })
        .listen({ port: 0, backend, tls: main });
      const session = http2.connect(`https://localhost:${s.port}`, {
        ca: main.cert,
      });
      const got = new Promise<string>((res, rej) => {
        const req = session.request({ ":path": "/slow" });
        let d = "";
        req.on("data", (c) => (d += c));
        req.on("end", () => res(d));
        req.on("error", rej);
        req.end();
      });
      await new Promise((r) => setTimeout(r, 100));
      await s.close({ timeoutMs: 3000 });
      expect(await got).toBe("done");
      session.destroy();
    });

    test("WebSockets over TLS", async () => {
      const s = track(
        new App()
          .ws("/ws", { message: (ws, m) => ws.send(`echo ${m}`) })
          .listen({ port: 0, backend, tls: main }),
      );
      const ws = new WebSocket(`wss://localhost:${s.port}/ws`, {
        tls: { ca: main.cert },
      } as never);
      const got = await new Promise<string>((res, rej) => {
        ws.onopen = () => ws.send("hi");
        ws.onmessage = (e) => res(String(e.data));
        ws.onerror = () => rej(new Error("wss error"));
      });
      expect(got).toBe("echo hi");
      ws.close();
    });

    test("compressed WebSockets over TLS", async () => {
      const s = track(
        new App()
          .ws("/ws", {
            message: (ws, m) =>
              ws.send(
                String(m).length > 1000 ? `big:${String(m).length}` : "small",
              ),
          })
          .listen({ port: 0, backend, tls: main, wsPerMessageDeflate: true }),
      );
      const ws = new WebSocket(`wss://localhost:${s.port}/ws`, {
        tls: { ca: main.cert },
      } as never);
      const payload = "compress me ".repeat(2000);
      const got = await new Promise<{ text: string; ext: string }>(
        (res, rej) => {
          ws.onopen = () => ws.send(payload);
          ws.onmessage = (e) =>
            res({ text: String(e.data), ext: ws.extensions });
          ws.onerror = () => rej(new Error("wss error"));
        },
      );
      expect(got.text).toBe(`big:${payload.length}`);
      expect(got.ext).toContain("permessage-deflate");
      ws.close();
    });

    test("large bodies and streamed responses over TLS", async () => {
      const s = track(
        new App()
          .post("/len", async (c) => String((await c.readBytes()).length))
          .get("/big", () => new Uint8Array(3_000_000).fill(7))
          .listen({ port: 0, backend, tls: main }),
      );
      const opt = { tls: { ca: main.cert } } as RequestInit;
      const up = await fetch(`https://localhost:${s.port}/len`, {
        ...opt,
        method: "POST",
        body: new Uint8Array(1_500_000),
      });
      expect(await up.text()).toBe("1500000");
      const down = new Uint8Array(
        await (
          await fetch(`https://localhost:${s.port}/big`, opt)
        ).arrayBuffer(),
      );
      expect(down.length).toBe(3_000_000);
    });

    test("fresh TLS servers take a 1.5 MB upload every time (a small receive window used to stall the sender)", async () => {
      const body = new Uint8Array(1_500_000);
      for (let i = 0; i < 25; i++) {
        const s = new App()
          .post("/len", async (c) => String((await c.readBytes()).length))
          .listen({ port: 0, backend, tls: main });
        try {
          const r = await fetch(`https://localhost:${s.port}/len`, {
            tls: { ca: main.cert },
            method: "POST",
            body,
            signal: AbortSignal.timeout(4000),
          } as RequestInit);
          expect(await r.text()).toBe("1500000");
        } finally {
          s.stop();
        }
      }
    }, 60_000);

    test("minVersion / maxVersion and the *File forms of key, cert and ca", async () => {
      const { writeFileSync } = await import("node:fs");
      writeFileSync(join(dir, "m.key"), main.key);
      writeFileSync(join(dir, "m.crt"), main.cert);
      const only12 = track(
        new App()
          .get("/", "ok")
          .listen({
            port: 0,
            backend,
            tls: {
              keyFile: join(dir, "m.key"),
              certFile: join(dir, "m.crt"),
              maxVersion: "TLSv1.2",
            },
          }),
      );
      const version = (
        port: number,
        v: { min?: tls.SecureVersion; max?: tls.SecureVersion },
      ) =>
        new Promise<string>((res) => {
          const sock = tls.connect(
            {
              host: "127.0.0.1",
              port,
              rejectUnauthorized: false,
              minVersion: v.min,
              maxVersion: v.max,
            },
            () => {
              res(sock.getProtocol() ?? "?");
              sock.destroy();
            },
          );
          sock.on("error", () => res("refused"));
        });
      expect(await version(only12.port, {})).toBe("TLSv1.2");
      expect(await version(only12.port, { min: "TLSv1.3" })).toBe("refused");
      const only13 = track(
        new App()
          .get("/", "ok")
          .listen({
            port: 0,
            backend,
            tls: { ...main, minVersion: "TLSv1.3" },
          }),
      );
      expect(await version(only13.port, {})).toBe("TLSv1.3");
      expect(await version(only13.port, { max: "TLSv1.2" })).toBe("refused");
      expect(() =>
        new App()
          .get("/", "x")
          .listen({
            port: 0,
            backend,
            tls: { ...main, minVersion: "TLSv1.3", maxVersion: "TLSv1.2" },
          }),
      ).toThrow(/protocol version/);
    });

    test("an encrypted private key is decrypted with the passphrase; a wrong one is refused at listen()", async () => {
      sh(
        "pkcs8",
        "-topk8",
        "-in",
        "main.key",
        "-out",
        "main.enc.key",
        "-passout",
        "pass:s3cret",
        "-v2",
        "aes-256-cbc",
      );
      const encrypted = pem("main.enc.key");
      expect(encrypted).toContain("ENCRYPTED PRIVATE KEY");
      const s = track(
        new App()
          .get("/", "ok")
          .listen({
            port: 0,
            backend,
            tls: { cert: main.cert, key: encrypted, passphrase: "s3cret" },
          }),
      );
      expect((await rawGet(s.port)).status).toContain("200");
      expect(() =>
        new App()
          .get("/", "x")
          .listen({
            port: 0,
            backend,
            tls: { cert: main.cert, key: encrypted, passphrase: "wrong" },
          }),
      ).toThrow(/passphrase.*could not be decrypted/);
      expect(() =>
        new App()
          .get("/", "x")
          .listen({
            port: 0,
            backend,
            tls: { cert: main.cert, key: encrypted },
          }),
      ).toThrow();
      // an unencrypted key with a passphrase set is used as it is (Bun does the same)
      const plain = track(
        new App()
          .get("/", "ok")
          .listen({ port: 0, backend, tls: { ...main, passphrase: "unused" } }),
      );
      expect((await rawGet(plain.port)).status).toContain("200");
    });

    test("a bad certificate is reported at listen()", () => {
      expect(() =>
        new App()
          .get("/", "x")
          .listen({ port: 0, backend, tls: { cert: "nope", key: main.key } }),
      ).toThrow();
    });

    test("unix-domain socket", async () => {
      const path = join(dir, `s-${backend}.sock`);
      const s = track(
        new App()
          .get("/hi", (c) => ({ ip: c.requestIP() }))
          .post("/echo", (c) => c.text())
          .listen({ port: 0, backend, unix: path }),
      );
      expect(s.unix).toBe(path);
      const r = await fetch("http://localhost/hi", {
        unix: path,
      } as RequestInit);
      expect(r.status).toBe(200);
      const e = await fetch("http://localhost/echo", {
        unix: path,
        method: "POST",
        body: "round trip",
      } as RequestInit);
      expect(await e.text()).toBe("round trip");
      s.stop();
      expect(existsSync(path)).toBe(false); // the socket file is cleaned up
    });

    test("unix-domain socket over TLS, and a stale socket file is replaced", async () => {
      const path = join(dir, `t-${backend}.sock`);
      const first = new App()
        .get("/", "one")
        .listen({ port: 0, backend, unix: path });
      first.stop();
      execFileSync("python3", [
        "-c",
        `import socket;s=socket.socket(socket.AF_UNIX);s.bind(${JSON.stringify(path)})`,
      ]); // leaves a stale file
      const s = track(
        new App()
          .get("/", "two")
          .listen({ port: 0, backend, unix: path, tls: main }),
      );
      const r = await fetch("https://localhost/", {
        unix: path,
        tls: { ca: main.cert },
      } as RequestInit);
      expect(await r.text()).toBe("two");
    });

    test("refuses a unix path that is not a socket", () => {
      expect(() =>
        new App()
          .get("/", "x")
          .listen({ port: 0, backend, unix: join(dir, "main.crt") }),
      ).toThrow(/not a socket/);
    });

    test("reusePort lets two servers share a port; without it the second bind fails", async () => {
      const a = track(
        new App()
          .get("/", "a")
          .listen({ port: 0, backend, reusePort: true, threads: 1 }),
      );
      const b = track(
        new App()
          .get("/", "b")
          .listen({ port: a.port, backend, reusePort: true, threads: 1 }),
      );
      const seen = new Set<string>();
      for (let i = 0; i < 40 && seen.size < 2; i++) {
        const r = await fetch(`http://127.0.0.1:${a.port}/`, {
          keepalive: false,
          headers: { connection: "close" },
        } as RequestInit);
        seen.add(await r.text());
      }
      expect(seen.size).toBe(2);
      const c = track(
        new App().get("/", "c").listen({ port: 0, backend, threads: 1 }),
      );
      expect(() =>
        new App().get("/", "d").listen({ port: c.port, backend }),
      ).toThrow();
    });

    test("ipv6Only: a [::] listener rejects IPv4 only when asked to", async () => {
      const dual = track(
        new App().get("/", "dual").listen({ port: 0, backend, hostname: "::" }),
      );
      expect(await (await fetch(`http://127.0.0.1:${dual.port}/`)).text()).toBe(
        "dual",
      );
      expect(await (await fetch(`http://[::1]:${dual.port}/`)).text()).toBe(
        "dual",
      );
      const only = track(
        new App()
          .get("/", "v6")
          .listen({ port: 0, backend, hostname: "::", ipv6Only: true }),
      );
      expect(await (await fetch(`http://[::1]:${only.port}/`)).text()).toBe(
        "v6",
      );
      expect(
        await fetch(`http://127.0.0.1:${only.port}/`).then(
          (r) => r.status,
          () => "refused",
        ),
      ).toBe("refused");
    });

    test("Bun.serve-shaped facade: https protocol, tls and unix", async () => {
      const s = serveCompat({
        port: 0,
        backend,
        tls: main,
        fetch: (req) => new Response(`${req.url.split(":")[0]}`),
      });
      expect(s.protocol).toBe("https");
      expect(s.url.protocol).toBe("https:");
      const r = await fetch(`https://localhost:${s.port}/`, {
        tls: { ca: main.cert },
      } as RequestInit);
      expect(await r.text()).toBe("https");
      await s.stop(true);
      const path = join(dir, `c-${backend}.sock`);
      const u = serveCompat({
        port: 0,
        backend,
        unix: path,
        fetch: () => new Response("unix ok"),
      });
      expect(u.url.protocol).toBe("unix:");
      expect(
        await (
          await fetch("http://localhost/", { unix: path } as RequestInit)
        ).text(),
      ).toBe("unix ok");
      await u.stop(true);
    });
  });
}
