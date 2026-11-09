import { App, serve } from "../src/index.ts";
const s = new App()
  .get("/", () => "hello")
  .get("/json", () => ({ ok: true, n: 42 }))
  .listen({
    port: Number(process.env.PORT),
    threads: Number(process.env.THREADS ?? 0),
    workers: Number(process.env.WORKERS ?? 1), // one loop unless asked: these keep state in memory
  });
console.log(
  "listening",
  s.port,
  s.backend,
  "threads=" + (process.env.THREADS ?? 0),
);
