// Bun.serve; with WORKERS > 1 every worker thread binds the same port with reusePort (the idiomatic multi-core Bun setup).
import { Worker, isMainThread } from "node:worker_threads";
const n = Number(process.env.WORKERS ?? 1);
Bun.serve({
    port: Number(process.env.PORT),
    reusePort: n > 1,
    fetch(req) {
        const { pathname } = new URL(req.url);
        if (pathname === "/") return new Response("hello", { headers: { "Content-Type": "text/plain;charset=utf-8" } });
        if (pathname === "/json") return Response.json({ ok: true, n: 42 });
        if (pathname === "/heavy") {
            const end = performance.now() + 0.1; // 100 us of CPU
            while (performance.now() < end) {}
            return Response.json({ ok: true, n: 42 });
        }
        return new Response("Not Found", { status: 404 });
    },
});
if (isMainThread) for (let i = 1; i < n; i++) new Worker(Bun.main);
