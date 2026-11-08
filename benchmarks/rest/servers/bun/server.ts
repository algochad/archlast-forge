import { create, get, idOf, limitOf, list, parse, remove, update } from "../shared/store";

const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: "not found" }, 404);
const invalid = () => json({ error: "invalid item" }, 400);

async function body(req: Request) {
  try {
    return parse(await req.json());
  } catch {
    return null;
  }
}

Bun.serve({
  port: Number(process.env.PORT ?? 3000),
  async fetch(req) {
    const url = new URL(req.url);
    const path = url.pathname;
    if (path === "/health") return new Response("ok");
    if (path === "/items") {
      if (req.method === "GET") return json(list(limitOf(url.searchParams.get("limit"))));
      if (req.method === "POST") {
        const input = await body(req);
        return input ? json(create(input), 201) : invalid();
      }
    } else if (path.startsWith("/items/")) {
      const id = idOf(path.slice(7));
      if (id === null) return notFound();
      if (req.method === "GET") {
        const item = get(id);
        return item ? json(item) : notFound();
      }
      if (req.method === "PUT") {
        const input = await body(req);
        if (!input) return invalid();
        const item = update(id, input);
        return item ? json(item) : notFound();
      }
      if (req.method === "DELETE") return remove(id) ? new Response(null, { status: 204 }) : notFound();
    }
    return notFound();
  },
});
