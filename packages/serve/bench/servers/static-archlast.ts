import { App } from "../../src/index.ts";
new App().get("/json", { ok: true, n: 42 }).listen({ port: Number(process.env.PORT), backend: process.env.BACKEND as any, threads: process.env.THREADS ? Number(process.env.THREADS) : undefined });
