// The API on archlast-serve alone: its native App API (a light context instead of a Web Request, and Reply instead of Response), no framework around it.
// One JavaScript thread, because the store is in memory; the Rust I/O threads are what THREADS sets.
import { App, Reply } from "/engine/packages/serve/src/index.ts";
import { create, get, idOf, limitOf, list, parse, remove, update } from "./store.ts";

const headers = { "content-type": "application/json" };
const reply = (body: unknown, status = 200) => new Reply(JSON.stringify(body), { status, headers });
const notFound = () => reply({ error: "not found" }, 404);
const invalid = () => reply({ error: "invalid item" }, 400);

function input(text: string) {
  try {
    return parse(JSON.parse(text));
  } catch {
    return null;
  }
}

new App()
  .get("/health", "ok")
  .get("/items", (c) => reply(list(limitOf(c.query.limit))))
  .post("/items", (c) => {
    const item = input(c.text());
    return item ? reply(create(item), 201) : invalid();
  })
  .get("/items/:id", (c) => {
    const id = idOf(c.params.id);
    const item = id === null ? undefined : get(id);
    return item ? reply(item) : notFound();
  })
  .put("/items/:id", (c) => {
    const id = idOf(c.params.id);
    if (id === null) return notFound();
    const item = input(c.text());
    if (!item) return invalid();
    const updated = update(id, item);
    return updated ? reply(updated) : notFound();
  })
  .delete("/items/:id", (c) => {
    const id = idOf(c.params.id);
    return id !== null && remove(id) ? new Reply(null, { status: 204 }) : notFound();
  })
  .listen({
    port: Number(process.env.PORT ?? 3000),
    hostname: "0.0.0.0",
    threads: Number(process.env.THREADS ?? 2),
    backend: (process.env.ARCHLAST_BACKEND as never) ?? "napi",
  });
