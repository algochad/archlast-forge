Bun.serve({
  port: Number(process.env.PORT),
  routes: {
    "/": new Response("hello", {
      headers: { "Content-Type": "text/html; charset=utf-8" },
    }),
    "/json": Response.json({ ok: true, n: 42 }),
  },
  fetch: () => new Response("Not Found", { status: 404 }),
});
console.log("listening", process.env.PORT);
