import { httpRouter, minimalAction, minimalJson, MinimalResponse, type MinimalRequest } from "@archlast/forge-runtime";
import { createItem, getItem, listItems, removeItem, seedItems, updateItem } from "./items";
import { idOf, limitOf, parse } from "./store";

// The same API on forge/http.ts's own routes, written with minimalAction (no Web Request or Response), with the items in the engine's database, read and written directly with ctx.read and ctx.write (no function of the reactive system is called).
const notFound = () => minimalJson({ error: "not found" }, 404);
const invalid = () => minimalJson({ error: "invalid item" }, 400);
const json = (req: MinimalRequest) => {
  try {
    return parse(JSON.parse(new TextDecoder().decode(req.body)));
  } catch {
    return null;
  }
};
const idIn = (req: MinimalRequest) => idOf(req.path.slice("/items/".length));

const http = httpRouter();
http.route({ method: "GET", path: "/items", handler: minimalAction(async (ctx, req) => minimalJson(await ctx.read((c) => listItems(c.db, limitOf(new URLSearchParams(req.search).get("limit")))))) });
http.route({
  method: "POST",
  path: "/items",
  handler: minimalAction(async (ctx, req) => {
    const input = json(req);
    return input ? minimalJson(await ctx.write((c) => createItem(c.db, input)), 201) : invalid();
  }),
});
http.route({
  method: "GET",
  pathPrefix: "/items/",
  handler: minimalAction(async (ctx, req) => {
    const id = idIn(req);
    const item = id === null ? null : await ctx.read((c) => getItem(c.db, id));
    return item ? minimalJson(item) : notFound();
  }),
});
http.route({
  method: "PUT",
  pathPrefix: "/items/",
  handler: minimalAction(async (ctx, req) => {
    const id = idIn(req);
    if (id === null) return notFound();
    const input = json(req);
    if (!input) return invalid();
    const item = await ctx.write((c) => updateItem(c.db, id, input));
    return item ? minimalJson(item) : notFound();
  }),
});
http.route({
  method: "DELETE",
  pathPrefix: "/items/",
  handler: minimalAction(async (ctx, req) => {
    const id = idIn(req);
    return id !== null && (await ctx.write((c) => removeItem(c.db, id))) ? new MinimalResponse(204, [], null) : notFound();
  }),
});
// Setup for the harness, not part of the measured API: puts items 1 to 1000 in the database when it is empty.
http.route({ method: "POST", path: "/seed", handler: minimalAction(async (ctx) => minimalJson({ seeded: await ctx.write((c) => seedItems(c.db)) })) });
export default http;
