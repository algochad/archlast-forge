// Run as the main script of a child process: the workers re-run this same file.
import { appendFileSync } from "node:fs";
import { isMainThread, workerData } from "node:worker_threads";
import { App, sse } from "../../src/index.ts";

const lane: number = isMainThread ? 0 : workerData.__archlast.lane;
let closedStreams = 0;

const app = new App()
  .get("/lane", () => ({ lane }))
  .get("/busy", () => {
    const end = performance.now() + 5; // 5 ms of CPU, so one thread cannot keep up with a burst
    while (performance.now() < end) {}
    return { lane };
  })
  .get("/closed", () => ({ lane, closedStreams }))
  .get("/crash", () => {
    if (lane !== 0)
      setTimeout(() => {
        throw new Error("intentional worker crash");
      }, 0);
    return { lane };
  })
  .get("/burst", (c) =>
    sse((s) => {
      for (let i = 0; i < Number(c.query.n); i++) s.send(i);
      s.end();
    }),
  )
  .get("/events", () =>
    sse((s) => {
      let i = 0;
      const t = setInterval(() => s.send({ i: i++, lane }), 10);
      return () => {
        clearInterval(t);
        closedStreams++;
        if (process.env.CLOSED_FILE)
          appendFileSync(process.env.CLOSED_FILE, "x"); // one byte per closed stream, any thread
      };
    }),
  )
  .ws("/ws", {
    data: (c) => ({ name: c.query.name ?? "anon" }),
    open(ws) {
      ws.subscribe("room");
      ws.send(JSON.stringify({ hello: (ws.data as any).name, lane }));
    },
    message(ws, m) {
      if (typeof m === "string" && m.startsWith("pub:"))
        ws.publish("room", m.slice(4));
      else ws.send(m);
    },
  });

const server = app.listen({
  port: Number(process.env.PORT ?? 0),
  // WORKERS=default leaves the option out: the loops follow the I/O threads
  workers: process.env.WORKERS === "default" ? undefined : Number(process.env.WORKERS ?? 1),
  backend: process.env.BACKEND as any,
  threads: Number(process.env.THREADS ?? 2),
});
if (isMainThread) {
  await server.ready;
  console.log("READY " + server.port);
}
