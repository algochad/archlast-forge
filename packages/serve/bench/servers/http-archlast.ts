import { App } from "../../src/index.ts";
new App()
    .get("/", () => "hello")
    .get("/json", () => ({ ok: true, n: 42 }))
    .get("/heavy", () => {
        const end = performance.now() + 0.1; // 100 us of CPU
        while (performance.now() < end) {}
        return { ok: true, n: 42 };
    })
    .listen({ port: Number(process.env.PORT), workers: Number(process.env.WORKERS ?? 1), backend: process.env.BACKEND as any, threads: process.env.THREADS ? Number(process.env.THREADS) : undefined });

if (process.env.EXIT_AFTER) setTimeout(() => process.exit(0), Number(process.env.EXIT_AFTER) * 1000); // for --cpu-prof runs
