import { App, serve } from "../src/index.ts";
const s = serve({
  port: Number(process.env.PORT),
  threads: Number(process.env.THREADS ?? 0),
  fetch(req) {
    const { pathname } = new URL(req.url);
    if (pathname === "/")
      return new Response("hello", {
        headers: { "Content-Type": "text/html; charset=utf-8" },
      });
    if (pathname === "/json") return Response.json({ ok: true, n: 42 });
    return new Response("Not Found", { status: 404 });
  },
});
console.log(
  "listening",
  s.port,
  s.backend,
  "threads=" + (process.env.THREADS ?? 0),
);
