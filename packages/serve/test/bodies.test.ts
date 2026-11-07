import { afterAll, describe, expect, test } from "bun:test";
import { createHash, randomBytes } from "node:crypto";
import net from "node:net";
import { serveCompat } from "../src/compat.ts";
import { App, Reply, type BackendName, type Server } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

/** Raw HTTP upload over node:net. `write` is called until it returns false; resolves with the response head and body. */
function upload(port: number, head: string, produce: (write: (b: Buffer) => Promise<void>, sock: net.Socket) => Promise<void>): Promise<{ response: string; sent: () => number; sock: net.Socket }> {
    return new Promise((resolve, reject) => {
        const sock = net.connect(port, "127.0.0.1");
        let response = "", sent = 0;
        sock.on("data", (d) => (response += d.toString("latin1")));
        sock.on("error", () => {});
        sock.on("close", () => resolve({ response, sent: () => sent, sock }));
        sock.on("connect", async () => {
            sock.write(head);
            const write = (b: Buffer) => new Promise<void>((res) => { if (sock.destroyed) return res(); sock.write(b, () => { sent += b.length; res(); }); });
            try { await produce(write, sock); } catch (e) { reject(e); }
        });
        setTimeout(() => resolve({ response, sent: () => sent, sock }), 8000);
    });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`request body streaming: ${backend}`, () => {
        const servers: Server[] = [];
        afterAll(() => servers.forEach((s) => s.stop()));
        const track = (s: Server) => (servers.push(s), s);

        test("small bodies arrive whole; big ones stream; both are byte-exact (webhook signatures), and sync readers refuse streams", async () => {
            const s = track(
                new App()
                    .post("/hash", async (c) => ({ streamed: c.bodyStreamed, sha: sha(await c.readBytes()), len: (await c.readBytes()).length }))
                    .post("/sync", (c) => ({ len: c.bytes().length }))
                    .onError(() => {})
                    .listen({ port: 0, backend }),
            );
            const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
            const allBytes = new Uint8Array(1024 * 1024); // every byte value, so no re-encoding can hide
            for (let i = 0; i < allBytes.length; i++) allBytes[i] = (i * 7 + (i >> 8)) & 255;
            for (const [bytes, streamed] of [[allBytes.subarray(0, 10_000), false], [allBytes, true], [new Uint8Array(randomBytes(6 * 1024 * 1024)), true]] as const) {
                const r = (await (await fetch(url("/hash"), { method: "POST", body: bytes })).json()) as { streamed: boolean; sha: string; len: number };
                expect([r.streamed, r.len, r.sha]).toEqual([streamed, bytes.length, sha(bytes)]);
            }
            expect(await (await fetch(url("/sync"), { method: "POST", body: new Uint8Array(1000) })).json()).toEqual({ len: 1000 });
            expect((await fetch(url("/sync"), { method: "POST", body: new Uint8Array(2 * 1024 * 1024) })).status).toBe(500); // sync read of a streamed body
        });

        test("the handler starts before the upload finishes", async () => {
            let firstChunkAt = -1;
            let startedAt = 0;
            const s = track(new App().post("/up", async (c) => { startedAt = performance.now(); let n = 0; for await (const ch of c.bodyStream!) { if (firstChunkAt < 0) firstChunkAt = performance.now(); n += ch.length; } return `got ${n}`; }).listen({ port: 0, backend }));
            const t0 = performance.now();
            const total = 4_000_000;
            const r = await upload(s.port, `POST /up HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`, async (write) => {
                for (let i = 0; i < 40; i++) { await write(Buffer.alloc(total / 40, 1)); await sleep(25); } // ~1 s in all
            });
            expect(r.response).toContain(`got ${total}`);
            expect(startedAt - t0).toBeLessThan(300); // long before the 1 s upload ended
        }, 15_000);

        test("backpressure: a slow handler holds the client back instead of buffering the upload", async () => {
            let consumed = 0;
            const s = track(
                new App().post("/slow", async (c) => {
                    for await (const ch of c.bodyStream!) { consumed += ch.length; await sleep(Math.max(2, Math.ceil((ch.length / (4 * 1024 * 1024)) * 1000))); } // ~4 MB/s whatever the frame size
                    return "done";
                }).listen({ port: 0, backend, maxRequestBodySize: 1 << 30 }),
            );
            const total = 300 * 1024 * 1024;
            let sentLive = 0, stop = false;
            const up = upload(s.port, `POST /slow HTTP/1.1\r\nHost: x\r\nContent-Length: ${total}\r\nConnection: close\r\n\r\n`, async (write, sock) => {
                const block = Buffer.alloc(256 * 1024, 2);
                for (let i = 0; i < total / block.length && !stop && !sock.destroyed; i++) { await write(block); sentLive += block.length; }
            });
            await sleep(1800);
            const consumedAt = consumed, sentAt = sentLive;
            stop = true;
            (await Promise.race([up, sleep(50).then(() => null)]))?.sock.destroy();
            expect(consumedAt).toBeGreaterThan(2 * 1024 * 1024); // the handler really was reading, slowly
            expect(sentAt).toBeLessThan(consumedAt + 48 * 1024 * 1024); // the client was held back: kernel buffers + a few MiB of window, not the upload
            expect(sentAt).toBeLessThan(total / 2);
        }, 25_000);

        test("a declared Content-Length over the limit is refused with 413 before any body is sent", async () => {
            const s = track(new App().post("/x", () => "should not run").listen({ port: 0, backend, maxRequestBodySize: 1_000_000 }));
            const t0 = performance.now();
            const r = await new Promise<string>((res) => {
                const sock = net.connect(s.port, "127.0.0.1");
                let data = "";
                sock.on("data", (d) => { data += d.toString(); if (data.includes("\r\n\r\n")) { res(data); sock.destroy(); } });
                sock.on("connect", () => sock.write("POST /x HTTP/1.1\r\nHost: x\r\nContent-Length: 999999999\r\n\r\n")); // and no body at all
                setTimeout(() => res(data), 2000);
            });
            expect(r).toContain("413");
            expect(performance.now() - t0).toBeLessThan(1000);
        });

        test("a chunked upload that outgrows the limit errors the stream; the handler can answer 413", async () => {
            let sawError = false;
            const s = track(
                new App().post("/x", async (c) => {
                    try { for await (const _ of c.bodyStream!) { /* drain */ } return "ok"; } catch { sawError = true; return new Reply("too big", { status: 413 }); }
                }).listen({ port: 0, backend, maxRequestBodySize: 2 * 1024 * 1024 }),
            );
            const r = await upload(s.port, "POST /x HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n", async (write) => {
                const chunk = Buffer.alloc(64 * 1024, 3);
                for (let i = 0; i < 80; i++) await write(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]));
                await write(Buffer.from("0\r\n\r\n"));
            });
            expect(sawError).toBe(true);
            expect(r.response === "" || r.response.includes("413")).toBe(true); // answered 413, or the connection was cut first
        }, 15_000);

        test("a chunked upload over the limit is answered 413 even when the handler fails or ignores the error", async () => {
            const s = track(
                new App()
                    .post("/throws", async (c) => { for await (const _ of c.bodyStream!) { /* drain */ } return "ok"; }) // the read error escapes
                    .post("/swallows", async (c) => { try { for await (const _ of c.bodyStream!) { /* drain */ } } catch { /* ignored */ } return "fine"; })
                    .listen({ port: 0, backend, maxRequestBodySize: 1024 * 1024 }),
            );
            for (const path of ["/throws", "/swallows"]) {
                const r = await upload(s.port, `POST ${path} HTTP/1.1\r\nHost: x\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n`, async (write) => {
                    const chunk = Buffer.alloc(64 * 1024, 3);
                    for (let i = 0; i < 40; i++) await write(Buffer.concat([Buffer.from(`${chunk.length.toString(16)}\r\n`), chunk, Buffer.from("\r\n")]));
                    await write(Buffer.from("0\r\n\r\n"));
                });
                expect([path, r.response.split("\r\n")[0]]).toEqual([path, "HTTP/1.1 413 Payload Too Large"]);
            }
        }, 15_000);

        test("answering without reading a big body is fine, cancel() works, an aborted upload errors the reader, and the server stays healthy", async () => {
            let abortSeen = false;
            const s = track(
                new App()
                    .post("/early", () => "early answer")
                    .post("/cancel", async (c) => { const r = c.bodyStream!.getReader(); await r.read(); await r.cancel(); return "cancelled"; })
                    .post("/abort", async (c) => { try { for await (const _ of c.bodyStream!) { /* read */ } } catch { abortSeen = true; } return "x"; })
                    .get("/ping", "pong")
                    .listen({ port: 0, backend }),
            );
            const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
            const big = new Uint8Array(8 * 1024 * 1024);
            expect(await (await fetch(url("/early"), { method: "POST", body: big })).text()).toBe("early answer");
            expect(await (await fetch(url("/cancel"), { method: "POST", body: big })).text()).toBe("cancelled");
            await upload(s.port, "POST /abort HTTP/1.1\r\nHost: x\r\nContent-Length: 50000000\r\n\r\n", async (write, sock) => {
                await write(Buffer.alloc(1_500_000, 4)); // more than the inline limit, then the client vanishes
                await sleep(100);
                sock.destroy();
            });
            for (let i = 0; i < 100 && !abortSeen; i++) await sleep(20);
            expect(abortSeen).toBe(true);
            expect(await (await fetch(url("/ping"))).text()).toBe("pong");
        }, 20_000);

        test("the Bun.serve-shaped facade gives fetch a Request whose body is a stream for big uploads", async () => {
            const s = serveCompat({ port: 0, backend, async fetch(req) {
                let n = 0, chunks = 0;
                for await (const ch of req.body as unknown as AsyncIterable<Uint8Array>) { n += ch.length; chunks++; }
                return Response.json({ n, multiple: chunks > 1 });
            } });
            try {
                const r = await fetch(`http://127.0.0.1:${s.port}/`, { method: "POST", body: new Uint8Array(10 * 1024 * 1024) });
                expect(await r.json()).toEqual({ n: 10 * 1024 * 1024, multiple: true });
            } finally { await s.stop(true); }
        });
    });
}
