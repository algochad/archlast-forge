import { afterAll, describe, expect, test } from "bun:test";
import { App, type BackendName, type Server } from "../src/index.ts";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const backend of ["bun-ffi", "napi"] as BackendName[]) {
    describe(`connection metadata: ${backend}`, () => {
        const servers: Server[] = [];
        afterAll(() => servers.forEach((s) => s.stop()));
        const track = (s: Server) => (servers.push(s), s);

        test("requestIP gives the client address and port; WebSocket gets the address too", async () => {
            const s = track(new App().get("/ip", (c) => c.requestIP()).ws("/ws", { open: (ws) => ws.send(String(ws.ip)) }).listen({ port: 0, backend }));
            const r = (await (await fetch(`http://127.0.0.1:${s.port}/ip`)).json()) as { address: string; family: string; port: number };
            expect([r.address, r.family]).toEqual(["127.0.0.1", "IPv4"]);
            expect(r.port).toBeGreaterThan(1023);
            const ws = new WebSocket(`ws://127.0.0.1:${s.port}/ws`);
            const first = await new Promise<string>((res, rej) => { ws.onmessage = (e) => res(String(e.data)); ws.onerror = () => rej(new Error("ws error")); });
            expect(first).toBe("127.0.0.1");
            ws.close();
        });

        test("req.signal fires when the client disconnects, and stays quiet for completed requests", async () => {
            let aborts = 0, lateAborted: boolean | null = null, finished = 0;
            const s = track(
                new App()
                    .get("/listen", async (c) => { c.signal.addEventListener("abort", () => void aborts++); await sleep(400); return "late"; })
                    .get("/late", async (c) => { await sleep(300); lateAborted = c.signal.aborted; return "x"; }) // first read of `signal` happens after the disconnect
                    .get("/ok", (c) => { void c.signal; finished++; return "ok"; })
                    .get("/state", () => ({ aborts, lateAborted, finished }))
                    .listen({ port: 0, backend }),
            );
            const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
            for (const path of ["/listen", "/late"]) {
                const ctrl = new AbortController();
                const p = fetch(url(path), { signal: ctrl.signal }).catch(() => "aborted");
                await sleep(80);
                ctrl.abort();
                expect(await p).toBe("aborted");
            }
            for (let i = 0; i < 40 && (await (await fetch(url("/state"))).json() as any).lateAborted === null; i++) await sleep(25);
            const st = (await (await fetch(url("/state"))).json()) as { aborts: number; lateAborted: boolean | null };
            expect(st.aborts).toBe(1);
            expect(st.lateAborted).toBe(true);
            for (let i = 0; i < 20; i++) expect(await (await fetch(url("/ok"))).text()).toBe("ok");
            expect(((await (await fetch(url("/state"))).json()) as { aborts: number }).aborts).toBe(1); // completed requests never abort
        });

        test("HEAD is answered from GET routes (static and dynamic) with the length and no body", async () => {
            const s = track(new App().get("/static", { a: 1 }).get("/dyn", () => ({ b: [1, 2, 3] })).head("/own", () => new Response(null, { headers: { "x-head": "own" } })).get("/own", "get").listen({ port: 0, backend }));
            const url = (p: string) => `http://127.0.0.1:${s.port}${p}`;
            for (const [p, len] of [["/static", 7], ["/dyn", 13]] as const) {
                const r = await fetch(url(p), { method: "HEAD" });
                expect([p, r.status, r.headers.get("content-length"), (await r.arrayBuffer()).byteLength]).toEqual([p, 200, String(len), 0]);
            }
            expect((await fetch(url("/own"), { method: "HEAD" })).headers.get("x-head")).toBe("own"); // an explicit HEAD route wins
            expect((await fetch(url("/missing"), { method: "HEAD" })).status).toBe(404);
        });

        test("a burst of immediately-aborted requests leaves the server healthy", async () => {
            let ran = 0;
            const s = track(new App().get("/work", async () => { ran++; await sleep(5); return "w"; }).get("/ping", "pong").listen({ port: 0, backend }));
            await Promise.all(Array.from({ length: 300 }, () => { const c = new AbortController(); const p = fetch(`http://127.0.0.1:${s.port}/work`, { signal: c.signal }).catch(() => null); c.abort(); return p; }));
            await sleep(200);
            expect(await (await fetch(`http://127.0.0.1:${s.port}/ping`)).text()).toBe("pong");
            expect(await (await fetch(`http://127.0.0.1:${s.port}/work`)).text()).toBe("w");
            expect(ran).toBeLessThanOrEqual(301);
        });
    });
}
