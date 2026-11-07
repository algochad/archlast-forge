import { afterAll, describe, expect, test } from "bun:test";
import { App, Reply, serve, sse, Stream, type BackendName, type Server } from "../src/index.ts";

const backends: BackendName[] = ["bun-ffi", "napi"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

for (const backend of backends) {
    describe(`SSE and streaming: ${backend}`, () => {
        const servers: Server[] = [];
        afterAll(() => servers.forEach((s) => s.stop()));
        const track = (s: Server) => (servers.push(s), s);
        const url = (s: Server, p: string) => `http://127.0.0.1:${s.port}${p}`;

        test("events arrive incrementally with SSE headers", async () => {
            const s = track(
                new App()
                    .get("/sse", () =>
                        sse((st) => {
                            let i = 0;
                            const t = setInterval(() => {
                                st.send({ i }, { event: "tick", id: i });
                                if (++i === 3) (clearInterval(t), st.end());
                            }, 80);
                            return () => clearInterval(t);
                        }),
                    )
                    .listen({ port: 0, backend }),
            );
            const t0 = performance.now();
            const r = await fetch(url(s, "/sse"));
            expect(r.headers.get("content-type")).toBe("text/event-stream;charset=utf-8");
            expect(r.headers.get("cache-control")).toBe("no-cache");
            const reader = r.body!.getReader();
            const first = await reader.read();
            const firstAt = performance.now() - t0;
            expect(new TextDecoder().decode(first.value)).toBe('event: tick\nid: 0\ndata: {"i":0}\n\n');
            expect(firstAt).toBeLessThan(200); // delivered as it was written, not buffered until the end
            let rest = "";
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                rest += new TextDecoder().decode(value);
            }
            expect(rest).toBe('event: tick\nid: 1\ndata: {"i":1}\n\nevent: tick\nid: 2\ndata: {"i":2}\n\n');
        });

        test("3000 events written in a loop arrive complete and in order", async () => {
            const s = track(
                new App()
                    .get("/burst", () => sse((st) => { for (let i = 0; i < 3000; i++) st.send(i); st.end(); }))
                    .listen({ port: 0, backend }),
            );
            const text = await (await fetch(url(s, "/burst"))).text();
            const events = text.split("\n\n").filter(Boolean);
            expect(events.length).toBe(3000);
            expect(events.every((e, i) => e === `data: ${i}`)).toBe(true);
        });

        test("multi-line data, comments, and writes before the handler returns", async () => {
            const s = track(
                new App()
                    .get("/m", () => sse((st) => { st.comment("hi"); st.send("a\nb"); st.end(); }))
                    .listen({ port: 0, backend }),
            );
            expect(await (await fetch(url(s, "/m"))).text()).toBe(": hi\n\ndata: a\ndata: b\n\n");
        });

        test("client disconnect fires onClose, and the server keeps working", async () => {
            let closed = 0;
            const s = track(
                new App()
                    .get("/forever", () => sse((st) => { const t = setInterval(() => st.send("x"), 10); return () => (clearInterval(t), closed++); }))
                    .get("/closed", () => ({ closed }))
                    .listen({ port: 0, backend }),
            );
            const ctrl = new AbortController();
            const r = await fetch(url(s, "/forever"), { signal: ctrl.signal });
            const reader = r.body!.getReader();
            await reader.read();
            ctrl.abort();
            let seen = 0;
            for (let i = 0; i < 40 && seen === 0; i++) {
                await sleep(25);
                seen = ((await (await fetch(url(s, "/closed"))).json()) as { closed: number }).closed;
            }
            expect(seen).toBe(1);
        });

        test("generic Stream: chunked body with custom status, ended by the server", async () => {
            const s = track(
                new App()
                    .get("/chunks", () => {
                        const st = new Stream({ status: 202, headers: { "content-type": "text/plain", "x-s": "1" } });
                        st.write("one,");
                        setTimeout(() => { st.write(new TextEncoder().encode("two,")); st.write("three"); st.end(); }, 30);
                        return st;
                    })
                    .listen({ port: 0, backend }),
            );
            const r = await fetch(url(s, "/chunks"));
            expect([r.status, r.headers.get("x-s"), await r.text()]).toEqual([202, "1", "one,two,three"]);
        });

        test("a Response with an event-stream body (Bun.serve style) is streamed, not buffered", async () => {
            const s = track(
                serve({
                    port: 0,
                    backend,
                    fetch() {
                        let i = 0, t: any;
                        const body = new ReadableStream({
                            start(c) { t = setInterval(() => { c.enqueue(new TextEncoder().encode(`data: ${i++}\n\n`)); if (i === 3) (clearInterval(t), c.close()); }, 60); },
                            cancel() { clearInterval(t); },
                        });
                        return new Response(body, { headers: { "content-type": "text/event-stream" } });
                    },
                }),
            );
            const t0 = performance.now();
            const r = await fetch(url(s, "/"));
            const reader = r.body!.getReader();
            const first = await reader.read();
            expect(performance.now() - t0).toBeLessThan(150);
            expect(new TextDecoder().decode(first.value)).toBe("data: 0\n\n");
        });

        test("async handlers can return streams, and plain routes still work alongside", async () => {
            const s = track(
                new App()
                    .get("/a", async () => { await sleep(10); return sse((st) => { st.send("late"); st.end(); }); })
                    .get("/plain", () => new Reply("p", { status: 201 }))
                    .listen({ port: 0, backend }),
            );
            expect(await (await fetch(url(s, "/a"))).text()).toBe("data: late\n\n");
            expect((await fetch(url(s, "/plain"))).status).toBe(201);
        });
    });
}
