Bun.serve({
  port: Number(process.env.PORT),
  routes: { "/json": Response.json({ ok: true, n: 42 }) },
  fetch: () => new Response("nf", { status: 404 }),
});
