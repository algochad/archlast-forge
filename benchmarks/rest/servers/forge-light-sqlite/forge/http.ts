import { httpRouter, lightAction, lightJson, LightResponse, type LightRequest } from "@archlast/forge-runtime";
import { createItem, getItem, listItems, removeItem, seedItems, updateItem } from "./items";
import { idOf, limitOf, parse } from "./store";

// The same API on forge/http.ts's own routes, written with lightAction (no Web Request or Response), with the items in the engine's database, read and written directly with ctx.read and ctx.write (no function of the reactive system is called).
const notFound = () => lightJson({ error: "not found" }, 404);
const invalid = () => lightJson({ error: "invalid item" }, 400);
const json = (req: LightRequest) => {
  try {
    return parse(JSON.parse(new TextDecoder().decode(req.body)));
  } catch {
    return null;
  }
};
const idIn = (req: LightRequest) => idOf(req.path.slice("/items/".length));

const http = httpRouter();
http.route({ method: "GET", path: "/items", handler: lightAction(async (ctx, req) => lightJson(await ctx.read((c) => listItems(c.db, limitOf(new URLSearchParams(req.search).get("limit")))))) });
http.route({
  method: "POST",
  path: "/items",
  handler: lightAction(async (ctx, req) => {
    const input = json(req);
    return input ? lightJson(await ctx.write((c) => createItem(c.db, input)), 201) : invalid();
  }),
});
http.route({
  method: "GET",
  pathPrefix: "/items/",
  handler: lightAction(async (ctx, req) => {
    const id = idIn(req);
    const item = id === null ? null : await ctx.read((c) => getItem(c.db, id));
    return item ? lightJson(item) : notFound();
  }),
});
http.route({
  method: "PUT",
  pathPrefix: "/items/",
  handler: lightAction(async (ctx, req) => {
    const id = idIn(req);
    if (id === null) return notFound();
    const input = json(req);
    if (!input) return invalid();
    const item = await ctx.write((c) => updateItem(c.db, id, input));
    return item ? lightJson(item) : notFound();
  }),
});
http.route({
  method: "DELETE",
  pathPrefix: "/items/",
  handler: lightAction(async (ctx, req) => {
    const id = idIn(req);
    return id !== null && (await ctx.write((c) => removeItem(c.db, id))) ? new LightResponse(204, [], null) : notFound();
  }),
});
// Setup for the harness, not part of the measured API: puts items 1 to 1000 in the database when it is empty.
http.route({ method: "POST", path: "/seed", handler: lightAction(async (ctx) => lightJson({ seeded: await ctx.write((c) => seedItems(c.db)) })) });
export default http;
