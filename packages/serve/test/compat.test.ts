import { afterAll, describe, expect, test } from "bun:test";
import { serveCompat, type CompatServer } from "../src/compat.ts";
import type { BackendName } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`Bun.serve-shaped facade: ${backend}`, () => {
        const servers: CompatServer<any>[] = [];
        afterAll(() => servers.forEach((s) => void s.stop(true)));
        const track = <T extends CompatServer<any>>(s: T) => (servers.push(s), s);

        test("fetch gets a standard Request with an absolute URL, headers, body, and port/url/hostname are reported", async () => {
            const seen: any[] = [];
            const s = track(
                serveCompat({
                    port: 0, hostname: "127.0.0.1", backend,
                    async fetch(req) {
                        seen.push({ url: req.url, method: req.method, ct: req.headers.get("Content-Type"), x: req.headers.get("X-Thing") });
                        const body = req.method === "GET" ? "" : await req.text();
                        return Response.json({ path: new URL(req.url).pathname, search: new URL(req.url).search, body }, { status: 201, headers: { "x-out": "1" } });
                    },
                }),
            );
            expect([s.hostname, s.url.href]).toEqual(["127.0.0.1", `http://127.0.0.1:${s.port}/`]);
            const r = await fetch(`http://127.0.0.1:${s.port}/a/b?c=1`, { method: "POST", body: "hello", headers: { "Content-Type": "text/plain", "X-Thing": "yes" } });
            expect([r.status, r.headers.get("x-out"), await r.json()]).toEqual([201, "1", { path: "/a/b", search: "?c=1", body: "hello" }]);
            expect(seen[0]).toEqual({ url: `http://127.0.0.1:${s.port}/a/b?c=1`, method: "POST", ct: "text/plain", x: "yes" });
        });

        test("duplicate Set-Cookie, arrays of headers, 204/304, HEAD and all methods behave like Bun.serve", async () => {
            const s = track(
                serveCompat({
                    port: 0, backend,
                    fetch(req) {
                        const p = new URL(req.url).pathname;
                        if (p === "/cookies") { const h = new Headers(); h.append("set-cookie", "a=1"); h.append("set-cookie", "b=2"); return new Response("c", { headers: h }); }
                        if (p === "/nc") return new Response(null, { status: 204 });
                        if (p === "/nm") return new Response(null, { status: 304, headers: { etag: '"x"' } });
                        if (p === "/m") return new Response(req.method);
                        return new Response("nf", { status: 404 });
                    },
                }),
            );
            const base = `http://127.0.0.1:${s.port}`;
            expect((await fetch(`${base}/cookies`)).headers.getSetCookie()).toEqual(["a=1", "b=2"]);
            expect((await fetch(`${base}/nc`)).status).toBe(204);
            const nm = await fetch(`${base}/nm`);
            expect([nm.status, nm.headers.get("etag")]).toEqual([304, '"x"']);
            const head = await fetch(`${base}/m`, { method: "HEAD" });
            expect([head.status, (await head.arrayBuffer()).byteLength]).toEqual([200, 0]);
            for (const m of ["PUT", "PATCH", "DELETE", "OPTIONS"]) expect(await (await fetch(`${base}/m`, { method: m })).text()).toBe(m);
            expect((await fetch(`${base}/zzz`)).status).toBe(404);
        });

        test("server.requestIP(req) reports the peer; server.timeout(req, 0) keeps a slow request alive past idleTimeout", async () => {
            const s = track(
                serveCompat({
                    port: 0, backend, idleTimeout: 1,
                    async fetch(req, server) {
                        const p = new URL(req.url).pathname;
                        if (p === "/ip") return Response.json(server.requestIP(req));
                        if (p === "/slow") { server.timeout(req, 0); await sleep(2300); return new Response("done"); }
                        return new Response("nf", { status: 404 });
                    },
                }),
            );
            const ip = (await (await fetch(`http://127.0.0.1:${s.port}/ip`)).json()) as { address: string; family: string; port: number };
            expect([ip.address, ip.family]).toEqual(["127.0.0.1", "IPv4"]);
            expect(ip.port).toBeGreaterThan(1023);
            expect(await (await fetch(`http://127.0.0.1:${s.port}/slow`)).text()).toBe("done");
        }, 15_000);

        test("an exception in fetch goes through the error handler; without one the client gets a 500", async () => {
            const withHandler = track(serveCompat({ port: 0, backend, fetch() { throw new Error("boom"); }, error: (e) => new Response(`handled: ${(e as Error).message}`, { status: 502 }) }));
            const r = await fetch(`http://127.0.0.1:${withHandler.port}/`);
            expect([r.status, await r.text()]).toEqual([502, "handled: boom"]);
            const bare = track(serveCompat({ port: 0, backend, fetch() { throw new Error("boom"); } }));
            const origErr = console.error;
            console.error = () => {};
            try { expect((await fetch(`http://127.0.0.1:${bare.port}/`)).status).toBe(500); } finally { console.error = origErr; }
        });

        test("routes with a static Response (Forge's /_dashboard redirect) are answered before fetch", async () => {
            let reached = 0;
            const s = track(serveCompat({ port: 0, backend, routes: { "/_dashboard": Response.redirect("http://dash.example/", 302) }, fetch() { reached++; return new Response("app"); } }));
            const r = await fetch(`http://127.0.0.1:${s.port}/_dashboard`, { redirect: "manual" });
            expect([r.status, r.headers.get("location"), reached]).toEqual([302, "http://dash.example/", 0]);
            expect(await (await fetch(`http://127.0.0.1:${s.port}/other`)).text()).toBe("app");
        });

        test("WebSocket: upgrade() with data and headers, open/message/close handlers, text and Buffer frames, close codes", async () => {
            const log: string[] = [];
            const s = track(
                serveCompat<{ user: string }>({
                    port: 0, backend,
                    fetch(req, server) {
                        const u = new URL(req.url);
                        if (u.pathname === "/rpc" && req.headers.get("upgrade")?.toLowerCase() === "websocket") {
                            if (u.searchParams.get("deny")) return new Response("origin not allowed", { status: 403 });
                            const proto = req.headers.get("sec-websocket-protocol")?.split(",")[0].trim();
                            return server.upgrade(req, { data: { user: u.searchParams.get("u") ?? "anon" }, headers: proto ? { "sec-websocket-protocol": proto } : undefined }) ? undefined : new Response("upgrade failed", { status: 400 });
                        }
                        return new Response("http");
                    },
                    websocket: {
                        open(ws) { log.push(`open:${ws.data.user}`); },
                        message(ws, m) {
                            if (typeof m === "string") ws.send(`text:${m}`);
                            else ws.send(new Uint8Array([...(m as Uint8Array)].reverse()).buffer); // binary frames arrive as a Buffer; send an ArrayBuffer back
                        },
                        close(ws, code, reason) { log.push(`close:${ws.data.user}:${code}:${reason}`); },
                    },
                }),
            );
            const ws = new WebSocket(`ws://127.0.0.1:${s.port}/rpc?u=ada`, ["graphql-ws"]);
            ws.binaryType = "arraybuffer";
            const got: any[] = [];
            ws.onmessage = (e) => got.push(e.data);
            await new Promise<void>((res, rej) => { ws.onopen = () => res(); ws.onerror = () => rej(new Error("ws error")); });
            expect(ws.protocol).toBe("graphql-ws"); // echoed through the headers option, as Forge does
            ws.send("hi");
            ws.send(new Uint8Array([1, 2, 3]));
            for (let i = 0; i < 100 && got.length < 2; i++) await sleep(10);
            expect(got[0]).toBe("text:hi");
            expect(Array.from(new Uint8Array(got[1]))).toEqual([3, 2, 1]);
            ws.close(4000, "bye");
            for (let i = 0; i < 100 && log.length < 2; i++) await sleep(10);
            expect(log).toEqual(["open:ada", "close:ada:4000:bye"]);
            await expect(new Promise((res, rej) => { const w = new WebSocket(`ws://127.0.0.1:${s.port}/rpc?deny=1`); w.onopen = () => res(1); w.onerror = () => rej(new Error("refused")); })).rejects.toThrow("refused");
            const plain = await fetch(`http://127.0.0.1:${s.port}/rpc`); // not an upgrade request
            expect(await plain.text()).toBe("http");
        });

        test("server.upgrade() on a request that is not a WebSocket handshake returns false; fetch returning nothing gets Bun's answer (a welcome text in development, 204 in production)", async () => {
            let upgraded: boolean | null = null;
            const s = track(serveCompat({ port: 0, backend, fetch(req, server) { const p = new URL(req.url).pathname; if (p === "/up") { upgraded = server.upgrade(req); return new Response("no"); } return undefined; } }));
            await fetch(`http://127.0.0.1:${s.port}/up`);
            expect(upgraded as unknown).toBe(false);
            const log = console.error; console.error = () => {}; // Bun logs the missing Response; keep the test output clean
            const nothing = await fetch(`http://127.0.0.1:${s.port}/nothing`).finally(() => { console.error = log; });
            expect(nothing.status).toBe(process.env.NODE_ENV === "production" ? 204 : 200);
            if (process.env.NODE_ENV !== "production") expect(await nothing.text()).toContain("return a Response object");
        });

        test("ReadableStream responses (SSE) stream and cancel() runs when the client leaves", async () => {
            let cancelled = 0;
            const s = track(
                serveCompat({
                    port: 0, backend,
                    fetch() {
                        let t: any, i = 0;
                        return new Response(new ReadableStream({ start(c) { t = setInterval(() => c.enqueue(new TextEncoder().encode(`data: ${i++}\n\n`)), 30); }, cancel() { clearInterval(t); cancelled++; } }), { headers: { "content-type": "text/event-stream" } });
                    },
                }),
            );
            const ctrl = new AbortController();
            const r = await fetch(`http://127.0.0.1:${s.port}/`, { signal: ctrl.signal });
            const reader = r.body!.getReader();
            expect(new TextDecoder().decode((await reader.read()).value)).toStartWith("data: 0");
            ctrl.abort();
            for (let i = 0; i < 60 && cancelled === 0; i++) await sleep(20);
            expect(cancelled).toBe(1);
        });

        test("stop(false) lets a request in flight finish; stop(true) drops immediately; both return promises", async () => {
            const s = serveCompat({ port: 0, backend, async fetch() { await sleep(500); return new Response("finished"); } });
            const port = s.port;
            const inflight = fetch(`http://127.0.0.1:${port}/`).then((r) => r.text());
            await sleep(100);
            const stopped = s.stop(false);
            expect(stopped).toBeInstanceOf(Promise);
            expect(await inflight).toBe("finished");
            await stopped;
            await sleep(100);
            const again = track(serveCompat({ port, backend, fetch: () => new Response("rebound") })); // fast rebind of the same port
            expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("rebound");
            const t0 = performance.now();
            await again.stop(true);
            expect(performance.now() - t0).toBeLessThan(500);
        });

        test("maxRequestBodySize gives a 413 and the connection stays usable", async () => {
            const s = track(serveCompat({ port: 0, backend, maxRequestBodySize: 1000, async fetch(req) { return new Response(String((await req.arrayBuffer()).byteLength)); } }));
            expect(await (await fetch(`http://127.0.0.1:${s.port}/`, { method: "POST", body: "x".repeat(500) })).text()).toBe("500");
            expect((await fetch(`http://127.0.0.1:${s.port}/`, { method: "POST", body: "x".repeat(5000) })).status).toBe(413);
            expect(await (await fetch(`http://127.0.0.1:${s.port}/`, { method: "POST", body: "ok" })).text()).toBe("2");
        });
    });
}
