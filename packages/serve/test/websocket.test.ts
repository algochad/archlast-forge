import { afterAll, describe, expect, test } from "bun:test";
import { App, type BackendName, type Server } from "../src/index.ts";

const backends: BackendName[] = ["bun-ffi", "napi"];
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Opens a client and queues everything it receives. */
function client(url: string) {
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const inbox: any[] = [];
    const waiters: (() => void)[] = [];
    let close: { code: number; reason: string } | null = null;
    ws.onmessage = (e) => (inbox.push(e.data), waiters.splice(0).forEach((w) => w()));
    ws.onclose = (e) => ((close = { code: e.code, reason: e.reason }), waiters.splice(0).forEach((w) => w()));
    const opened = new Promise<void>((res, rej) => ((ws.onopen = () => res()), (ws.onerror = () => rej(new Error("ws error")))));
    return {
        ws,
        opened,
        async next(timeout = 2000): Promise<any> {
            const end = Date.now() + timeout;
            while (inbox.length === 0 && !close) {
                if (Date.now() > end) throw new Error("timeout waiting for message");
                await new Promise<void>((r) => (waiters.push(r), setTimeout(r, 50)));
            }
            if (inbox.length === 0) throw new Error("closed");
            return inbox.shift();
        },
        get closed() { return close; },
        async waitClosed() { for (let i = 0; i < 60 && !close; i++) await sleep(25); return close; },
    };
}

for (const backend of backends) {
    describe(`WebSocket: ${backend}`, () => {
        const servers: Server[] = [];
        afterAll(() => servers.forEach((s) => s.stop()));
        const track = (s: Server) => (servers.push(s), s);

        test("text and binary echo, data(ctx) from the upgrade request, close code", async () => {
            const closes: number[] = [];
            const s = track(
                new App()
                    .ws<{ name: string }>("/ws", {
                        data: (c) => ({ name: c.query.name ?? "?" }),
                        open: (ws) => ws.send(`hello ${ws.data.name} ${ws.header("x-test")}`),
                        message: (ws, m) => ws.send(m),
                        close: (ws, code) => void closes.push(code),
                    })
                    .listen({ port: 0, backend }),
            );
            const c = client(`ws://127.0.0.1:${s.port}/ws?name=ada`);
            await c.opened;
            expect(await c.next()).toBe("hello ada null");
            c.ws.send("héllo ✓");
            expect(await c.next()).toBe("héllo ✓");
            c.ws.send(new Uint8Array([1, 2, 3, 255]));
            expect(Array.from(new Uint8Array(await c.next()))).toEqual([1, 2, 3, 255]);
            c.ws.close(1000);
            expect((await c.waitClosed())?.code).toBe(1000);
            for (let i = 0; i < 40 && closes.length === 0; i++) await sleep(25);
            expect(closes).toEqual([1000]);
        });

        test("server-initiated close carries code and reason", async () => {
            const s = track(new App().ws("/ws", { message: (ws, m) => ws.close(4001, `bye ${m}`) }).listen({ port: 0, backend }));
            const c = client(`ws://127.0.0.1:${s.port}/ws`);
            await c.opened;
            c.ws.send("now");
            expect(await c.waitClosed()).toEqual({ code: 4001, reason: "bye now" });
        });

        test("pub/sub: ws.publish excludes the sender, server.publish reaches everyone, unsubscribe works", async () => {
            const s: Server = track(
                new App()
                    .ws("/ws", {
                        open: (ws) => ws.subscribe("room"),
                        message: (ws, m) => {
                            if (m === "pub") ws.publish("room", "from-peer");
                            else if (m === "leave") ws.unsubscribe("room");
                            else if (m === "srv") s.publish("room", "from-server");
                            else if (m === "ping") ws.send("pong");
                        },
                    })
                    .listen({ port: 0, backend }),
            );
            const [a, b, c] = [1, 2, 3].map(() => client(`ws://127.0.0.1:${s.port}/ws`));
            await Promise.all([a.opened, b.opened, c.opened]);
            await sleep(100); // let the three subscriptions land
            a.ws.send("pub");
            expect(await b.next()).toBe("from-peer");
            expect(await c.next()).toBe("from-peer");
            a.ws.send("ping"); // a's own next message must be the pong: it did not get its own publish
            expect(await a.next()).toBe("pong");
            b.ws.send("srv");
            expect(await a.next()).toBe("from-server");
            expect(await b.next()).toBe("from-server");
            expect(await c.next()).toBe("from-server");
            c.ws.send("leave");
            await sleep(100);
            a.ws.send("pub");
            expect(await b.next()).toBe("from-peer");
            c.ws.send("ping");
            expect(await c.next()).toBe("pong"); // nothing from-peer was delivered to c
            [a, b, c].forEach((x) => x.ws.close());
        });

        test("unregistered path is not upgraded; HTTP routes keep working on the same server", async () => {
            const s = track(new App().get("/", "http-ok").ws("/ws", { message: (ws, m) => ws.send(m) }).listen({ port: 0, backend }));
            const bad = client(`ws://127.0.0.1:${s.port}/nope`);
            await expect(bad.opened).rejects.toThrow();
            expect(await (await fetch(`http://127.0.0.1:${s.port}/`)).text()).toBe("http-ok");
        });

        test("handler errors do not take the server down; 200 sockets echo concurrently", async () => {
            let errors = 0;
            const s = track(
                new App()
                    .ws("/ws", { message: (ws, m) => { if (m === "boom") throw new Error("boom"); ws.send(m); } })
                    .onError(() => void errors++)
                    .listen({ port: 0, backend }),
            );
            const many = Array.from({ length: 200 }, () => client(`ws://127.0.0.1:${s.port}/ws`));
            await Promise.all(many.map((c) => c.opened));
            many.forEach((c, i) => c.ws.send(`m${i}`));
            const got = await Promise.all(many.map((c) => c.next()));
            expect(got).toEqual(many.map((_, i) => `m${i}`));
            many[0].ws.send("boom");
            many[0].ws.send("after");
            expect(await many[0].next()).toBe("after");
            expect(errors).toBe(1);
            many.forEach((c) => c.ws.close());
        });
    });
}
