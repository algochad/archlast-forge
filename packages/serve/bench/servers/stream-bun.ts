// The same three endpoints on Bun.serve; with WORKERS > 1 each worker thread binds the port with reusePort.
// (Fan-out is only meaningful with WORKERS=1: Bun's pub/sub does not cross threads.)
import { Worker, isMainThread } from "node:worker_threads";
const n = Number(process.env.WORKERS ?? 1);
const enc = new TextEncoder();
const server = Bun.serve<{ kind: string }>({
    port: Number(process.env.PORT),
    reusePort: n > 1,
    fetch(req, srv) {
        const url = new URL(req.url);
        if (url.pathname === "/ws" || url.pathname === "/fanout") {
            return srv.upgrade(req, { data: { kind: url.pathname } }) ? undefined : new Response("upgrade failed", { status: 400 });
        }
        if (url.pathname === "/sse") {
            const count = Number(url.searchParams.get("n") ?? 1000);
            const body = new ReadableStream({
                start(c) {
                    for (let i = 0; i < count; i++) c.enqueue(enc.encode("data: x\n\n"));
                    c.close();
                },
            });
            return new Response(body, { headers: { "content-type": "text/event-stream;charset=utf-8", "cache-control": "no-cache" } });
        }
        return new Response("Not Found", { status: 404 });
    },
    websocket: {
        open(ws) {
            if (ws.data.kind === "/fanout") ws.subscribe("room");
        },
        message(ws, m) {
            if (ws.data.kind === "/fanout") server.publish("room", m);
            else ws.send(m);
        },
    },
});
if (isMainThread) for (let i = 1; i < n; i++) new Worker(Bun.main);
