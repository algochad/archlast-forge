import { afterAll, describe, expect, test } from "bun:test";
import { App, sse, type BackendName, type Server } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a raw connection; resolves with how long it stayed open (ms) and what it received, up to `maxMs`. */
function hold(port: number, send: string | null, maxMs: number): Promise<{ closedAfter: number | null; data: string }> {
    return new Promise((resolve) => {
        const t0 = performance.now();
        let data = "";
        let done = false;
        const finish = (closed: boolean) => { if (!done) { done = true; resolve({ closedAfter: closed ? performance.now() - t0 : null, data }); } };
        Bun.connect({
            hostname: "127.0.0.1", port,
            socket: { open: (s) => void (send && s.write(send)), data: (_s, d) => void (data += Buffer.from(d).toString("latin1")), close: () => finish(true), error: () => finish(true) },
        }).then((s) => setTimeout(() => { finish(false); s.end(); }, maxMs), () => finish(true));
    });
}

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`idle timeouts and graceful shutdown: ${backend}`, () => {
        const servers: Server[] = [];
        afterAll(() => servers.forEach((s) => s.stop()));
        const track = (s: Server) => (servers.push(s), s);

        test("a connection that stays silent is closed after idleTimeout", async () => {
            const s = track(new App().get("/", "ok").listen({ port: 0, backend, idleTimeout: 1 }));
            const r = await hold(s.port, null, 4500);
            expect(r.closedAfter).not.toBeNull();
            expect(r.closedAfter!).toBeGreaterThan(900);
            expect(r.closedAfter!).toBeLessThan(3200);
        });

        test("an idle keep-alive connection is closed after its last response", async () => {
            const s = track(new App().get("/", "ok").listen({ port: 0, backend, idleTimeout: 1 }));
            const r = await hold(s.port, "GET / HTTP/1.1\r\nHost: x\r\n\r\n", 4500);
            expect(r.data).toContain("200 OK");
            expect(r.closedAfter).not.toBeNull();
            expect(r.closedAfter!).toBeLessThan(3500);
        });

        test("traffic keeps a connection alive, and idleTimeout 0 means never", async () => {
            const s = track(new App().get("/", "ok").listen({ port: 0, backend, idleTimeout: 1 }));
            const sock = await new Promise<{ write(d: string): void; end(): void; closed: boolean }>((res) => {
                const state = { closed: false, write: (_: string) => {}, end: () => {} };
                Bun.connect({ hostname: "127.0.0.1", port: s.port, socket: { open: (k) => { state.write = (d) => void k.write(d); state.end = () => void k.end(); res(state); }, data() {}, close: () => void (state.closed = true), error: () => void (state.closed = true) } });
            });
            for (let i = 0; i < 6; i++) { sock.write("GET / HTTP/1.1\r\nHost: x\r\n\r\n"); await sleep(500); } // 3 s of traffic, gaps under the 1 s limit
            expect(sock.closed).toBe(false);
            sock.end();
            const never = track(new App().get("/", "ok").listen({ port: 0, backend, idleTimeout: 0 }));
            expect((await hold(never.port, null, 2500)).closedAfter).toBeNull();
        }, 20_000);

        test("SSE with a heartbeat outlives idleTimeout; a silent stream does not", async () => {
            const s = track(
                new App()
                    .get("/beat", () => sse((st) => { const t = setInterval(() => st.comment("hb"), 300); return () => clearInterval(t); }))
                    .get("/silent", () => sse((st) => { st.send("start"); }))
                    .listen({ port: 0, backend, idleTimeout: 1 }),
            );
            const beat = await hold(s.port, "GET /beat HTTP/1.1\r\nHost: x\r\n\r\n", 3000);
            expect(beat.closedAfter).toBeNull();
            expect(beat.data.split(": hb").length).toBeGreaterThan(5);
            const silent = await hold(s.port, "GET /silent HTTP/1.1\r\nHost: x\r\n\r\n", 4500);
            expect(silent.closedAfter).not.toBeNull();
        }, 20_000);

        test("ctx.timeout(0) lets one slow request outlive idleTimeout, and the limit applies again afterwards", async () => {
            const s = track(
                new App()
                    .get("/slow-optout", async (c) => { c.timeout(0); await sleep(2500); return "done"; })
                    .get("/slow", async () => { await sleep(2500); return "done"; })
                    .listen({ port: 0, backend, idleTimeout: 1 }),
            );
            const ok = await hold(s.port, "GET /slow-optout HTTP/1.1\r\nHost: x\r\n\r\n", 6500);
            expect(ok.data).toContain("done");
            // answered at ~2.5 s; the 1 s limit applies again afterwards (the reaper ticks once a second), so it closes at ~3.5-5 s
            expect(ok.closedAfter).not.toBeNull();
            expect(ok.closedAfter!).toBeGreaterThan(3000);
            expect(ok.closedAfter!).toBeLessThan(6000);
            const cut = await hold(s.port, "GET /slow HTTP/1.1\r\nHost: x\r\n\r\n", 3600);
            expect(cut.data).not.toContain("done"); // closed by the idle limit while the handler was still working
            expect(cut.closedAfter).not.toBeNull();
        }, 20_000);

        test("close(): requests in flight finish, new connections are refused, and the promise resolves when down", async () => {
            const s = new App().get("/slow", async () => { await sleep(600); return "finished"; }).get("/fast", "ok").listen({ port: 0, backend });
            const port = s.port;
            const inflight = fetch(`http://127.0.0.1:${port}/slow`).then((r) => r.text());
            await sleep(100);
            const t0 = performance.now();
            const closing = s.close({ timeoutMs: 5000 });
            await sleep(100);
            await expect(fetch(`http://127.0.0.1:${port}/fast`)).rejects.toThrow(); // no new connections
            expect(await inflight).toBe("finished");
            await closing;
            const took = performance.now() - t0;
            expect(took).toBeGreaterThan(400);
            expect(took).toBeLessThan(2500);
            await sleep(100);
            const again = track(new App().get("/", "new").listen({ port, backend })); // the port is free again
            expect(await (await fetch(`http://127.0.0.1:${port}/`)).text()).toBe("new");
        });

        test("close(): WebSockets get 1012, and a request that outlives the timeout gets 503 or is cut", async () => {
            const s = new App().ws("/ws", { message: (ws, m) => ws.send(m) }).get("/forever", async () => { await sleep(30_000); return "never"; }).listen({ port: 0, backend });
            const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
            await new Promise<void>((res) => (ws.onopen = () => res()));
            const closed = new Promise<number>((res) => (ws.onclose = (e) => res(e.code)));
            const hung = fetch(`http://127.0.0.1:${s.port}/forever`).then((r) => `${r.status} retry-after=${r.headers.get("retry-after")}`, () => "dropped");
            await sleep(100);
            const t0 = performance.now();
            await s.close({ timeoutMs: 700 });
            expect(await closed).toBe(1012);
            expect(["503 retry-after=1", "dropped"]).toContain(await hung); // told to retry, or the connection was cut first
            expect(performance.now() - t0).toBeLessThan(2500);
        });
    });
}
