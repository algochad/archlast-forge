// SSE burst + WebSocket echo + WebSocket fan-out on archlast-serve.
import { App, type Server, sse } from "../../src/index.ts";

const app: App = new App()
    .get("/sse", (c) =>
        sse((s) => {
            const n = Number(c.query.n ?? 1000);
            for (let i = 0; i < n; i++) s.send("x");
            s.end();
        }),
    )
    .ws("/ws", { message: (ws, m) => ws.send(m) })
    .ws("/fanout", {
        open: (ws) => ws.subscribe("room"),
        message: (_ws, m) => server.publish("room", m as string), // to every subscriber, sender included
    });
const server: Server = app.listen({ port: Number(process.env.PORT), workers: Number(process.env.WORKERS ?? 1), backend: process.env.BACKEND as any, threads: process.env.THREADS ? Number(process.env.THREADS) : undefined });
