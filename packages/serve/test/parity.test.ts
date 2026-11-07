import { afterAll, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import net from "node:net";
import { serveCompat, type CompatServer } from "../src/compat.ts";
import { App, type BackendName, Reply, type Server } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Minimal client-side WebSocket frames over node:net: sees control frames and can send masked ones. */
function rawWs(port: number, path: string) {
    return new Promise<{ sock: net.Socket; frames: { op: number; data: Buffer }[]; closedSock: () => boolean; send(op: number, payload?: Buffer | string): void }>((resolve, reject) => {
        const key = randomBytes(16).toString("base64");
        const sock = net.connect(port, "127.0.0.1");
        const frames: { op: number; data: Buffer }[] = [];
        let buf = Buffer.alloc(0), upgraded = false, closed = false;
        const parse = () => {
            for (;;) {
                if (buf.length < 2) return;
                let len = buf[1] & 0x7f, off = 2;
                if (len === 126) { if (buf.length < 4) return; len = buf.readUInt16BE(2); off = 4; }
                else if (len === 127) { if (buf.length < 10) return; len = Number(buf.readBigUInt64BE(2)); off = 10; }
                if (buf.length < off + len) return;
                frames.push({ op: buf[0] & 0x0f, data: Buffer.from(buf.subarray(off, off + len)) });
                buf = buf.subarray(off + len);
            }
        };
        sock.on("connect", () => sock.write(`GET ${path} HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ${key}\r\nSec-WebSocket-Version: 13\r\n\r\n`));
        sock.on("data", (d) => {
            buf = Buffer.concat([buf, d as Buffer]);
            if (!upgraded) {
                const i = buf.indexOf("\r\n\r\n");
                if (i === -1) return;
                upgraded = true;
                buf = buf.subarray(i + 4);
                resolve({
                    sock, frames, closedSock: () => closed,
                    send(op, payload = "") {
                        const p = Buffer.from(payload), mask = randomBytes(4);
                        const head = Buffer.from([0x80 | op, 0x80 | p.length]);
                        sock.write(Buffer.concat([head, mask, Buffer.from(p.map((b, i) => b ^ mask[i % 4]))]));
                    },
                });
            }
            parse();
        });
        sock.on("close", () => { closed = true; if (!upgraded) reject(new Error("closed")); });
        sock.on("error", () => {});
    });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`Bun.serve parity: WebSocket API, ${backend}`, () => {
        const servers: Server[] = [];
        afterAll(() => servers.forEach((s) => s.stop()));
        const track = (s: Server) => (servers.push(s), s);

        test("ping/pong/terminate: control frames both ways, auto-pong, handlers, and an abrupt drop without a close frame", async () => {
            const got: string[] = [];
            const s = track(new App().ws("/ws", {
                open: (ws) => { ws.ping("hello"); },
                ping: (_ws, d) => void got.push(`ping:${d.toString()}`),
                pong: (_ws, d) => void got.push(`pong:${d.toString()}`),
                message: (ws, m) => { if (m === "bye") ws.terminate(); },
            }).listen({ port: 0, backend, wsPingInterval: 0 }));
            const c = await rawWs(s.port, "/ws");
            await sleep(100);
            expect(c.frames.some((f) => f.op === 0x9 && f.data.toString() === "hello")).toBe(true); // server ping arrived
            c.send(0xa, "back"); // our pong
            c.send(0x9, "yo"); // our ping: the engine answers it and tells the handler
            await sleep(150);
            expect(c.frames.some((f) => f.op === 0xa && f.data.toString() === "yo")).toBe(true);
            expect(got).toEqual(["pong:back", "ping:yo"]);
            c.send(0x1, "bye");
            await sleep(200);
            expect(c.closedSock()).toBe(true);
            expect(c.frames.some((f) => f.op === 0x8)).toBe(false); // terminate = no closing handshake
        });

        test("send status codes, sendText/sendBinary with every buffer type, publishText/Binary, cork, readyState, subscriptions", async () => {
            const results: Record<string, unknown> = {};
            const s = track(new App().ws("/ws", {
                open(ws) {
                    results.text = ws.sendText("héllo");
                    results.bin = [ws.sendBinary(new Uint8Array([1, 2])), ws.sendBinary(new Uint8Array([3, 4, 5]).buffer), ws.sendBinary(new DataView(new Uint8Array([6]).buffer)), ws.send(Buffer.from([7, 8]))];
                    results.subs = [ws.subscribe("a"), ws.subscribe("a"), ws.subscribe("b"), ws.isSubscribed("a"), ws.isSubscribed("zz"), ws.subscriptions, ws.unsubscribe("b"), ws.unsubscribe("b"), ws.subscriptions];
                    results.cork = ws.cork((w) => w.readyState);
                    results.state = ws.readyState;
                },
                message(ws, m) {
                    if (m === "publish") { ws.publishText("a", "T!"); ws.publishBinary("a", new Uint8Array([9, 9])); }
                    if (m === "close") { ws.close(1000, "x"); results.closing = ws.readyState; results.afterClose = ws.send("late"); }
                },
            }).listen({ port: 0, backend }));
            const c1 = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); c1.binaryType = "arraybuffer";
            const c2 = new WebSocket(`ws://127.0.0.1:${s.port}/ws`); c2.binaryType = "arraybuffer";
            const got1: any[] = [], got2: any[] = [];
            c1.onmessage = (e) => got1.push(e.data); c2.onmessage = (e) => got2.push(e.data);
            await Promise.all([new Promise((r) => (c1.onopen = r)), new Promise((r) => (c2.onopen = r))]);
            await sleep(200);
            expect(results.text).toBe(6);
            expect(results.bin).toEqual([2, 3, 1, 2]);
            expect(results.subs).toEqual([true, true, true, true, false, ["a", "b"], true, false, ["a"]]); // subscribing again is still "true", as in Bun
            expect([results.cork, results.state]).toEqual([1, 1]);
            c1.send("publish"); // c1's publish reaches c2 (subscribed to "a") but not c1 itself (publishToSelf is off)
            await sleep(250);
            expect(got2.filter((m) => m === "T!").length).toBe(1);
            expect(got2.some((m) => m instanceof ArrayBuffer && new Uint8Array(m).join() === "9,9")).toBe(true);
            expect(got1.filter((m) => m === "T!").length).toBe(0);
            c1.send("close");
            await sleep(150);
            expect(results.closing).toBe(2);
            expect(results.afterClose).toBe(0);
            c2.close();
        });

        test("publishToSelf, subscriberCount and pendingWebSockets", async () => {
            const s = track(new App().ws("/ws", { open: (ws) => void ws.subscribe("room"), message: (ws, m) => void ws.publish("room", `echo:${m}`) }).listen({ port: 0, backend, wsPublishToSelf: true }));
            const a = new WebSocket(`ws://127.0.0.1:${s.port}/ws`), b = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
            const ga: string[] = [];
            a.onmessage = (e) => ga.push(String(e.data));
            await Promise.all([new Promise((r) => (a.onopen = r)), new Promise((r) => (b.onopen = r))]);
            await sleep(150);
            expect([s.subscriberCount("room"), s.subscriberCount("nobody"), s.pendingWebSockets]).toEqual([2, 0, 2]);
            a.send("x");
            await sleep(150);
            expect(ga).toEqual(["echo:x"]); // delivered to the sender as well
            a.close(); b.close();
            await sleep(300);
            expect([s.subscriberCount("room"), s.pendingWebSockets]).toEqual([0, 0]);
        });

        test("binaryType decides what binary messages look like", async () => {
            const seen: string[] = [];
            const s = track(new App().ws("/ws", { open: (ws) => { ws.binaryType = (ws.data as any); }, data: (c) => c.query.t as any, message: (_ws, m) => void seen.push(typeof m === "string" ? "string" : m instanceof Buffer ? "Buffer" : m instanceof ArrayBuffer ? "ArrayBuffer" : m instanceof Uint8Array ? "Uint8Array" : m instanceof Blob ? "Blob" : "?") }).listen({ port: 0, backend }));
            for (const t of ["nodebuffer", "arraybuffer", "uint8array", "blob"]) {
                const c = new WebSocket(`ws://127.0.0.1:${s.port}/ws?t=${t}`);
                await new Promise((r) => (c.onopen = r));
                c.send(new Uint8Array([1, 2, 3]));
                await sleep(120);
                c.close();
            }
            await sleep(100);
            expect(seen).toEqual(["Buffer", "ArrayBuffer", "Uint8Array", "Blob"]);
        });

        test("pause() stops reading until resume(); getBufferedAmount() is a number; handler errors reach error() and the socket survives", async () => {
            const log: string[] = [];
            const s = track(new App().ws("/ws", {
                message(ws, m) {
                    if (m === "first") { ws.pause(); setTimeout(() => ws.resume(), 500); return; }
                    if (m === "boom") throw new Error("kaboom");
                    log.push(`msg:${m}`);
                    ws.send(`buffered:${typeof ws.getBufferedAmount()}:${ws.isPaused}`);
                },
                error(err, ws) { log.push(`error:${err.message}`); ws.send("still alive"); },
            }).listen({ port: 0, backend }));
            const c = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
            const got: string[] = [];
            c.onmessage = (e) => got.push(String(e.data));
            await new Promise((r) => (c.onopen = r));
            c.send("first");
            await sleep(150); // the pause command has reached the engine
            const t0 = performance.now();
            c.send("one"); c.send("boom"); c.send("two");
            await sleep(250);
            expect(log).toEqual([]); // nothing is read while paused
            for (let i = 0; i < 60 && log.length < 3; i++) await sleep(20);
            expect(performance.now() - t0).toBeGreaterThan(200); // delivered only after resume()
            expect(log).toEqual(["msg:one", "error:kaboom", "msg:two"]);
            expect(got).toContain("still alive");
            expect(got).toContain("buffered:number:false");
            c.close();
        });

        test("closeOnBackpressureLimit:false: send reports -1 past the limit, nothing is dropped, and drain fires once the client reads", async () => {
            const returns: number[] = [];
            let drained = 0, closedCode = -1;
            const chunk = "d".repeat(100_000);
            const s = track(new App().ws("/flood", {
                open(ws) { for (let i = 0; i < 120; i++) returns.push(ws.send(chunk)); },
                drain: () => void drained++,
                close: (_ws, code) => void (closedCode = code),
            }).listen({ port: 0, backend, wsBackpressureLimit: 400_000, wsCloseOnBackpressureLimit: false }));
            const c = await rawWs(s.port, "/flood");
            c.sock.pause(); // not reading: kernel buffers fill, the backlog grows
            await sleep(600);
            expect(returns.includes(-1)).toBe(true);
            expect(returns[0]).toBe(100_000);
            expect(closedCode).toBe(-1); // still connected: the slow client was NOT dropped
            c.sock.resume(); // now read everything
            for (let i = 0; i < 150 && drained === 0; i++) await sleep(20);
            expect(drained).toBeGreaterThan(0);
            c.sock.destroy();
        }, 20_000);
    });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`Bun.serve parity: server object and routes, ${backend}`, () => {
        const servers: CompatServer<any>[] = [];
        afterAll(() => servers.forEach((s) => void s.stop(true)));
        const track = <T extends CompatServer<any>>(s: T) => (servers.push(s), s);

        test("routes: exact, :params, wildcards, method maps, precedence, false, and fall-through to fetch; req.params and req.cookies", async () => {
            const s = track(serveCompat({
                port: 0, backend,
                routes: {
                    "/": () => new Response("home"),
                    "/users/:id": (req) => Response.json({ id: req.params.id, cookie: req.cookies.get("sid") }),
                    "/users/me": () => new Response("me"),
                    "/files/*": (req) => new Response(`file:${new URL(req.url).pathname.slice("/files/".length)}`), // wildcard routes have no params, as in Bun
                    "/api/items/:id/parts/:part": (req) => Response.json(req.params),
                    "/m": { GET: () => new Response("get"), POST: () => new Response("post") },
                    "/off": false,
                },
                fetch: (req) => new Response(`fallback:${new URL(req.url).pathname}:${req.method}`),
            }));
            const u = (p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, init);
            expect(await (await u("/")).text()).toBe("home");
            expect(await (await u("/users/42", { headers: { cookie: "sid=abc; x=1" } })).json()).toEqual({ id: "42", cookie: "abc" });
            expect(await (await u("/users/me")).text()).toBe("me"); // exact beats :param
            expect(await (await u("/users/a%20b")).json()).toEqual({ id: "a b", cookie: null });
            expect(await (await u("/files/a/b/c.txt")).text()).toBe("file:a/b/c.txt");
            expect(await (await u("/api/items/7/parts/x")).json()).toEqual({ id: "7", part: "x" });
            expect(await (await u("/m")).text()).toBe("get");
            expect(await (await u("/m", { method: "POST" })).text()).toBe("post");
            expect(await (await u("/m", { method: "DELETE" })).text()).toBe("fallback:/m:DELETE"); // unmapped method falls through
            expect(await (await u("/off")).text()).toBe("fallback:/off:GET");
            expect(await (await u("/users/42/extra")).text()).toBe("fallback:/users/42/extra:GET");
            expect(await (await u("/m", { method: "HEAD" })).text()).toBe(""); // HEAD uses the GET handler
        });

        test("static Response routes get an ETag and 304; BunFile routes stream natively with ranges", async () => {
            await Bun.write("/tmp/archlast-parity.txt", "0123456789");
            const s = track(serveCompat({
                port: 0, backend,
                routes: { "/static": new Response("fixed body", { headers: { "content-type": "text/plain", "x-a": "1" } }), "/file": Bun.file("/tmp/archlast-parity.txt") },
                fetch: () => new Response("nf", { status: 404 }),
            }));
            const base = `http://127.0.0.1:${s.port}`;
            const r1 = await fetch(`${base}/static`);
            const etag = r1.headers.get("etag")!;
            expect([r1.status, await r1.text(), r1.headers.get("x-a"), !!etag]).toEqual([200, "fixed body", "1", true]);
            const r2 = await fetch(`${base}/static`, { headers: { "if-none-match": etag } });
            expect([r2.status, (await r2.text()).length]).toEqual([304, 0]);
            const f = await fetch(`${base}/file`, { headers: { range: "bytes=2-5" } });
            expect([f.status, await f.text(), f.headers.get("content-range")]).toEqual([206, "2345", "bytes 2-5/10"]);
        });

        test("reload() swaps handlers live; fetch(req) runs a request in-process; protocol, id, pending counters, closeIdleConnections, dispose", async () => {
            let version = 1;
            const s = track(serveCompat({ port: 0, backend, id: "my-server", fetch: () => new Response("v1"), routes: { "/slow": async () => { await sleep(300); return new Response("slow"); } } }));
            const base = `http://127.0.0.1:${s.port}`;
            expect(await (await fetch(`${base}/`)).text()).toBe("v1");
            expect(s.reload({ fetch: () => new Response(`v${++version}`), routes: { "/new": () => new Response("new route") } })).toBe(s);
            expect(await (await fetch(`${base}/`)).text()).toBe("v2");
            expect(await (await fetch(`${base}/new`)).text()).toBe("new route");
            expect(await (await fetch(`${base}/slow`)).text()).toBe("v3"); // the old route is gone
            expect(await (await s.fetch(new Request("http://x/new"))).text()).toBe("new route"); // in-process, no socket
            expect(await (await s.fetch("http://x/anything")).text()).toBe("v4");
            expect([s.protocol, s.id, s.pendingRequests]).toEqual(["http", "my-server", 0]);
            s.reload({ routes: { "/slow": async () => { await sleep(400); return new Response("slow"); } } });
            const inflight = fetch(`${base}/slow`).then((r) => r.text());
            await sleep(120);
            expect(s.pendingRequests).toBe(1);
            const idle1 = net.connect(s.port, "127.0.0.1"), idle2 = net.connect(s.port, "127.0.0.1");
            await new Promise<void>((r) => idle1.on("connect", () => idle1.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n", () => r())));
            await new Promise<void>((r) => idle2.on("connect", () => idle2.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n", () => r())));
            await sleep(150);
            const closedIdle = s.closeIdleConnections();
            expect(closedIdle).toBeGreaterThanOrEqual(2); // the two keep-alive leftovers
            expect(await inflight).toBe("slow"); // the request in flight was not touched
            idle1.destroy(); idle2.destroy();
            const port = s.port;
            {
                using disposable = serveCompat({ port: 0, backend, fetch: () => new Response("scoped") });
                expect(await (await fetch(`http://127.0.0.1:${disposable.port}/`)).text()).toBe("scoped");
            }
            await expect(fetch(`http://127.0.0.1:${port + 0}/`)).resolves.toBeDefined(); // the first server is still up
        });
    });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`native static ETag: ${backend}`, () => {
        test("a constant route with an etag answers If-None-Match with 304 from Rust", async () => {
            let handled = 0;
            const s = new App()
                .get("/v", new Reply("payload", { headers: { etag: '"abc"', "cache-control": "max-age=60" } }))
                .get("/h", () => (handled++, "js"))
                .listen({ port: 0, backend });
            try {
                const u = `http://127.0.0.1:${s.port}/v`;
                const ok = await fetch(u);
                expect([ok.status, await ok.text(), ok.headers.get("etag")]).toEqual([200, "payload", '"abc"']);
                for (const inm of ['"abc"', 'W/"abc"', '"x", "abc"', "*"]) {
                    const r = await fetch(u, { headers: { "if-none-match": inm } });
                    expect([inm, r.status, (await r.text()).length]).toEqual([inm, 304, 0]);
                    expect(r.headers.get("etag")).toBe('"abc"');
                }
                expect((await fetch(u, { headers: { "if-none-match": '"other"' } })).status).toBe(200);
                expect(handled).toBe(0);
            } finally {
                s.stop();
            }
        });
    });
}

// ---- behaviours audited against Bun.serve 1.4.4 ----
for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`Bun.serve audit parity: ${backend}`, () => {
        const servers: CompatServer<any>[] = [];
        afterAll(() => servers.forEach((s) => void s.stop(true)));
        const start = (o: Parameters<typeof serveCompat>[0]) => (servers.push(serveCompat({ port: 0, backend, ...o })), servers[servers.length - 1]);
        const get = (s: CompatServer<any>, p: string, init?: RequestInit) => fetch(`http://127.0.0.1:${s.port}${p}`, init);

        test("responses without a Content-Type get one from the body: text, images, binary; static routes too", async () => {
            const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
            const s = start({
                fetch(req) {
                    const p = new URL(req.url).pathname;
                    if (p === "/text") return new Response("hello");
                    if (p === "/png") return new Response(png);
                    if (p === "/bin") return new Response(new Uint8Array([0xff, 0xfe, 0, 1]));
                    if (p === "/json") return Response.json({ a: 1 });
                    if (p === "/own") return new Response("x", { headers: { "content-type": "text/x-custom" } });
                    if (p === "/redirect") return Response.redirect("http://example.com/", 302);
                    return new Response("nf", { status: 404 });
                },
                routes: { "/static": new Response("static text"), "/static-redirect": new Response(null, { status: 301, headers: { location: "/x" } }) },
            });
            const ct = async (p: string) => (await get(s, p, { redirect: "manual" })).headers.get("content-type");
            expect(await ct("/text")).toBe("text/plain;charset=utf-8");
            expect(await ct("/png")).toBe("image/png");
            expect(await ct("/bin")).toBe("application/octet-stream");
            expect(await ct("/json")).toContain("application/json");
            expect(await ct("/own")).toBe("text/x-custom");
            expect(await ct("/static")).toBe("text/plain;charset=utf-8");
            expect(await ct("/static-redirect")).toBeNull();
            expect(await ct("/redirect")).toBeNull();
        });

        test("`this` is the server in fetch, route handlers and error", async () => {
            const seen: unknown[] = [];
            const s = start({
                fetch(this: unknown, req) { seen.push(this); if (new URL(req.url).pathname === "/boom") throw new Error("boom"); return new Response("ok"); },
                routes: { "/r": function (this: unknown) { seen.push(this); return new Response("r"); } },
                error(this: unknown, e) { seen.push(this); return new Response(`handled ${(e as Error).message}`, { status: 500 }); },
            });
            await get(s, "/x"); await get(s, "/r");
            expect(await (await get(s, "/boom")).text()).toBe("handled boom");
            expect(seen.length).toBe(4);
            expect(seen.every((x) => x === s)).toBe(true);
        });

        test("WebSocket upgrade: first offered subprotocol is echoed, Headers objects work, a second upgrade() is refused", async () => {
            let second: boolean | null = null;
            const s = start({
                fetch(req, server) {
                    if (new URL(req.url).pathname === "/h") {
                        const first = server.upgrade(req, { headers: new Headers({ "x-extra": "1" }) });
                        second = server.upgrade(req);
                        return first ? undefined : new Response("no", { status: 400 });
                    }
                    return server.upgrade(req) ? undefined : new Response("no", { status: 400 });
                },
                websocket: { message(ws) { ws.send("pong"); } },
            });
            const ws = new WebSocket(`ws://127.0.0.1:${s.port}/`, ["chat", "other"]);
            await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("no upgrade")); });
            expect(ws.protocol).toBe("chat");
            ws.close();
            const raw = await new Promise<string>((res) => {
                const sock = net.connect(s.port, "127.0.0.1", () => sock.write("GET /h HTTP/1.1\r\nHost: x\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n"));
                let d = ""; sock.on("data", (c) => { d += c; if (d.includes("\r\n\r\n")) { sock.destroy(); res(d); } });
            });
            expect(raw.toLowerCase()).toContain("x-extra: 1");
            expect(raw).not.toContain("function");
            expect(second as unknown).toBe(false);
        });

        test("req.cookies.set() becomes Set-Cookie", async () => {
            const s = start({ routes: { "/c": (req) => { req.cookies.set("sid", "42", { path: "/" }); return new Response("ok"); } } });
            const r = await get(s, "/c");
            expect(r.headers.get("set-cookie")).toContain("sid=42");
            expect(r.headers.get("set-cookie")).toContain("Path=/");
        });

        test("errors: logged, then Bun's body; Response.error() and non-responses are errors", async () => {
            const logged: string[] = [];
            const orig = console.error;
            console.error = (...a: unknown[]) => void logged.push(a.map(String).join(" "));
            try {
                const s = start({
                    development: false,
                    fetch(req) {
                        const p = new URL(req.url).pathname;
                        if (p === "/throw") throw new Error("kaput");
                        if (p === "/err") return Response.error();
                        if (p === "/obj") return { not: "a response" } as never;
                        return new Response("ok");
                    },
                });
                const t = await get(s, "/throw");
                expect([t.status, await t.text()]).toEqual([500, "Something went wrong!"]);
                expect((await get(s, "/err")).status).toBe(500);
                expect((await get(s, "/obj")).status).toBe(204);
                expect(logged.join("\n")).toContain("kaput");
            } finally {
                console.error = orig;
            }
        });

        test("req.signal aborts when the client disconnects mid-handler", async () => {
            let aborted: boolean | null = null;
            const s = start({
                async fetch(req) { await new Promise<void>((res) => req.signal.addEventListener("abort", () => res())); aborted = req.signal.aborted; return new Response("late"); },
            });
            const sock = net.connect(s.port, "127.0.0.1", () => sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"));
            await sleep(150);
            sock.destroy();
            for (let i = 0; i < 40 && aborted === null; i++) await sleep(25);
            expect(aborted as unknown).toBe(true);
        });

        test("a handler's own Content-Length or Transfer-Encoding cannot desynchronize the connection", async () => {
            const s = start({ fetch: () => new Response("hello", { headers: { "content-length": "2", "x-keep": "1" } }) });
            const sock = net.connect(s.port, "127.0.0.1");
            const data = await new Promise<string>((res) => {
                let d = ""; sock.on("data", (c) => (d += c));
                sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\nGET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n");
                sock.on("close", () => res(d));
            });
            expect((data.match(/HTTP\/1\.1 200/g) ?? []).length).toBe(2);
            expect((data.match(/hello/g) ?? []).length).toBe(2);
            expect(data.toLowerCase()).not.toContain("content-length: 2");
        });

        test("route rules: /a and /a/ differ, `false` skips to fetch, /z/:a/* works, bad escapes decode to U+FFFD, wildcards carry no params", async () => {
            const s = start({
                routes: {
                    "/a": () => new Response("a"),
                    "/a/": () => new Response("a-slash"),
                    "/off": false,
                    "/z/:a/*": (req) => new Response(`z:${req.params.a}`),
                    "/p/:v": (req) => new Response(`p:${req.params.v}`),
                    "/*": (req) => new Response(`wild:${JSON.stringify(req.params)}`),
                },
                fetch: () => new Response("fetch"),
            });
            expect(await (await get(s, "/a")).text()).toBe("a");
            expect(await (await get(s, "/a/")).text()).toBe("a-slash");
            expect(await (await get(s, "/off")).text()).toBe("fetch");
            expect(await (await get(s, "/z/q/rest/of/it")).text()).toBe("z:q");
            expect(await (await get(s, "/p/%ff")).text()).toBe("p:\uFFFD");
            expect(await (await get(s, "/anything")).text()).toBe("wild:{}");
        });

        test("option validation: nothing to serve, bad port or idleTimeout, port in use", async () => {
            expect(() => serveCompat({ port: 0, backend } as never)).toThrow(/needs either/);
            expect(() => serveCompat({ port: 70000, backend, fetch: () => new Response("") })).toThrow(/port/);
            expect(() => serveCompat({ port: 0, backend, idleTimeout: 300, fetch: () => new Response("") })).toThrow(/idleTimeout/);
            expect(() => serveCompat({ port: 0, backend, fetch: 5 as never })).toThrow(/fetch/);
            const a = start({ fetch: () => new Response("") });
            try {
                serveCompat({ port: a.port, backend, fetch: () => new Response("") });
                throw new Error("should not bind");
            } catch (e) {
                expect((e as { code?: string }).code).toBe("EADDRINUSE");
                expect((e as Error).message).toContain(`Is port ${a.port} in use`);
            }
        });

        test("a streamed response is held back by a client that does not read (bounded memory), and finishes when it does", async () => {
            let produced = 0;
            const chunk = new Uint8Array(1024 * 1024).fill(7);
            const s = start({
                fetch: () => new Response(new ReadableStream({
                    async pull(c) { if (produced >= 300) return c.close(); produced++; c.enqueue(chunk); },
                }), { headers: { "content-type": "application/octet-stream" } }),
            });
            const sock = net.connect(s.port, "127.0.0.1");
            sock.pause(); // the client reads nothing
            sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n");
            await sleep(1200);
            const whileStalled = produced;
            expect(whileStalled).toBeLessThan(60); // a few MiB of window plus kernel and connection buffers, not 300 MiB
            let got = 0;
            await new Promise<void>((res) => {
                sock.on("data", (d) => { got += d.length; if (got >= 300 * 1024 * 1024) res(); });
                sock.resume();
            });
            expect(produced).toBe(300);
            sock.destroy();
        }, 30_000);

        test("a static route of new Response(Bun.file()) is sent natively (length, Range, ETag); handler responses and streams are untouched; a missing file is a 404", async () => {
            const { writeFileSync, mkdtempSync, rmSync } = await import("node:fs");
            const { tmpdir } = await import("node:os");
            const { join } = await import("node:path");
            const dir = mkdtempSync(join(tmpdir(), "archlast-file-"));
            try {
                const path = join(dir, "data.bin");
                writeFileSync(path, Buffer.alloc(3_000_000, 66));
                let tick = 0;
                const s = start({
                    routes: {
                        "/file": new Response(Bun.file(path)),
                        "/missing": new Response(Bun.file(join(dir, "nope.bin"))),
                        "/slice": new Response(Bun.file(path).slice(0, 10)),
                    },
                    fetch(req) {
                        const p = new URL(req.url).pathname;
                        if (p === "/dynamic") return new Response(Bun.file(path)); // a handler's Response is streamed through JS: correct, but no Range
                        if (p === "/stream") return new Response(new ReadableStream({ async pull(c) { await sleep(40); if (++tick > 3) return c.close(); c.enqueue(new TextEncoder().encode(`part${tick};`)); } }));
                        return new Response("nf", { status: 404 });
                    },
                });
                const full = await get(s, "/file");
                expect([full.status, full.headers.get("content-length"), full.headers.get("transfer-encoding")]).toEqual([200, "3000000", null]);
                expect(full.headers.get("etag")).toBeTruthy();
                const part = await get(s, "/file", { headers: { range: "bytes=5-14" } });
                expect([part.status, part.headers.get("content-range"), (await part.arrayBuffer()).byteLength]).toEqual([206, "bytes 5-14/3000000", 10]);
                expect((await get(s, "/missing")).status).toBe(404);
                expect((await (await get(s, "/slice")).arrayBuffer()).byteLength).toBe(10);
                expect((await (await get(s, "/dynamic")).arrayBuffer()).byteLength).toBe(3_000_000);
                const t0 = performance.now();
                expect(await (await get(s, "/stream")).text()).toBe("part1;part2;part3;");
                expect(performance.now() - t0).toBeGreaterThan(100); // it really streamed over time
            } finally {
                rmSync(dir, { recursive: true, force: true });
            }
        });

        test("spinMicros (latency mode) serves HTTP and WebSocket and goes quiet again when traffic stops", async () => {
            const s = start({ spinMicros: 80, fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("http ok")), websocket: { message(ws, m) { ws.send(`echo:${m}`); } } });
            expect(await (await get(s, "/")).text()).toBe("http ok");
            const ws = new WebSocket(`ws://127.0.0.1:${s.port}/`);
            await new Promise<void>((res) => (ws.onopen = () => res()));
            const answers: string[] = [];
            ws.onmessage = (e) => answers.push(String(e.data));
            for (let i = 0; i < 200; i++) { ws.send(String(i)); await sleep(1); }
            for (let i = 0; i < 40 && answers.length < 200; i++) await sleep(25);
            expect(answers.length).toBe(200);
            ws.close();
            await sleep(300); // the spin window is over
            const t0 = process.cpuUsage();
            await sleep(500);
            const used = process.cpuUsage(t0);
            expect((used.user + used.system) / 1000).toBeLessThan(150); // ms of CPU in half a second of silence: it is not spinning
        });

        test("stop(true) closes open WebSockets with 1001 and runs their close handlers", async () => {
            const closes: [number, string][] = [];
            const s = start({ fetch: (req, server) => (server.upgrade(req) ? undefined : new Response("no")), websocket: { open() {}, message() {}, close(_ws, code, reason) { closes.push([code, reason]); } } });
            const clients = await Promise.all([0, 1].map(() => new Promise<WebSocket>((res) => { const w = new WebSocket(`ws://127.0.0.1:${s.port}/`); w.onopen = () => res(w); })));
            await sleep(50);
            await s.stop(true);
            expect(closes).toEqual([[1001, "Server closed"], [1001, "Server closed"]]);
            clients.forEach((w) => w.close());
        });

        test("a plain Blob route is refused at startup instead of killing the server later", () => {
            expect(() => serveCompat({ port: 0, backend, routes: { "/b": new Blob(["x"]) as never } })).toThrow(/Blob/);
        });

        test("request heads over 16 KiB get 431", async () => {
            const s = start({ fetch: () => new Response("ok") });
            const r = await get(s, "/", { headers: { "x-big": "a".repeat(20_000) } });
            expect(r.status).toBe(431);
        });

        test("abstract unix sockets", async () => {
            const name = `\0archlast-test-${process.pid}-${backend}`;
            const s = start({ unix: name, fetch: () => new Response("abstract ok") });
            expect(s.unix).toBe(name);
            expect(await (await fetch("http://localhost/", { unix: name } as RequestInit)).text()).toBe("abstract ok");
        });
    });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`HEAD keeps the handler's Content-Length: ${backend}`, () => {
        test("a HEAD answer carries the entity's length, a GET answer's own length header is still ignored", async () => {
            const s = serveCompat({
                port: 0,
                backend,
                fetch: (req) => (req.method === "HEAD" ? new Response(null, { headers: { "content-length": "11", "x-k": "v" } }) : new Response("hello", { headers: { "content-length": "2" } })),
            });
            try {
                const head = await fetch(`http://127.0.0.1:${s.port}/`, { method: "HEAD" });
                expect([head.status, head.headers.get("content-length"), head.headers.get("x-k")]).toEqual([200, "11", "v"]);
                const get = await fetch(`http://127.0.0.1:${s.port}/`);
                expect([await get.text(), get.headers.get("content-length")]).toEqual(["hello", "5"]);
            } finally {
                await s.stop(true);
            }
        });
    });
}
