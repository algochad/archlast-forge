import { httpRouter, lightAction, lightJson, lightRaw } from "@archlast/forge-runtime";
import { createItem, getItem, listItems, seedItems, updateItem } from "./items";
import { nest } from "@archlast/forge-runtime/nest";
import { ItemsDb, NestItemsController } from "./nest.controller";
import { idOf, limitOf } from "./store";

// ctx.db read and write, directly from a light route: what a request costs in the database layer
const http = httpRouter();
http.route({ method: "POST", path: "/seed", handler: lightAction(async (ctx) => lightJson({ seeded: await ctx.write((c) => seedItems(c.db)) })) });
http.route({
  method: "GET",
  pathPrefix: "/db/",
  handler: lightAction(async (ctx, req) => {
    const id = idOf(req.path.slice(4));
    const item = id === null ? null : await ctx.read((c) => getItem(c.db, id));
    return item ? lightJson(item) : lightJson({ error: "not found" }, 404);
  }),
});
http.route({ method: "GET", path: "/dblist", handler: lightAction(async (ctx, req) => lightJson(await ctx.read((c) => listItems(c.db, limitOf(new URLSearchParams(req.search).get("limit")))))) });
http.route({
  method: "PUT",
  pathPrefix: "/db/",
  handler: lightAction(async (ctx, req) => {
    const id = idOf(req.path.slice(4)) ?? 1;
    return lightJson(await ctx.write((c) => updateItem(c.db, id, { name: "renamed", quantity: 3 })));
  }),
});
http.route({ method: "POST", path: "/dbc", handler: lightAction(async (ctx) => lightJson(await ctx.write((c) => createItem(c.db, { name: "w", quantity: 1 })), 201)) });
// the document as the database keeps it: objects made and written out again, or the text passed on
const byItem = (db: any, n: number) => db.query("items").withIndex("by_item", (q: any) => q.eq("itemId", n));
http.route({
  method: "GET",
  pathPrefix: "/dbo/",
  handler: lightAction(async (ctx, req) => {
    const n = idOf(req.path.slice(5)) ?? 1;
    const doc = await ctx.read((c) => byItem(c.db, n).first());
    return doc ? lightJson(doc) : lightJson({ error: "not found" }, 404);
  }),
});
http.route({
  method: "GET",
  pathPrefix: "/dbj/",
  handler: lightAction(async (ctx, req) => {
    const n = idOf(req.path.slice(5)) ?? 1;
    const text = await ctx.read((c) => byItem(c.db, n).firstJson());
    return text === "null" ? lightJson({ error: "not found" }, 404) : lightRaw(text);
  }),
});
http.route({ method: "GET", path: "/empty", handler: lightAction(async (ctx) => lightJson(await ctx.read(async () => ({ ok: true })))) });
http.route({ method: "GET", path: "/emptyw", handler: lightAction(async (ctx) => lightJson(await ctx.write(async () => ({ ok: true })))) });
nest(http, { controllers: [NestItemsController], providers: [ItemsDb] });
export default http;