import { anyApi, ForgeError, httpAction, httpRouter, lightAction, lightJson, LightResponse, v } from "../../src/index";

const api = anyApi;
const http = httpRouter();
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

http.route({ method: "GET", path: "/hello", handler: httpAction(async () => new Response("hello", { headers: { "x-custom": "yes" } })) });
// lightAction: given the request's fields, answering without a Web Request or Response
http.route({
  method: "POST",
  path: "/light",
  handler: lightAction(async (ctx, req) => {
    if (new URLSearchParams(req.search).has("empty")) return new LightResponse(204, [["x-light", "1"]], null);
    if (new URLSearchParams(req.search).has("web")) return new Response("from a Response", { headers: { "x-light": "web" } });
    const who = await ctx.auth.getUserIdentity();
    return lightJson({ method: req.method, path: req.path, search: req.search, text: new TextDecoder().decode(req.body), host: new Headers(req.headers).get("host") !== null, who: who ? "someone" : null }, 201, [["x-light", "1"]]);
  }),
});
http.route({
  method: "OPTIONS",
  path: "/hello",
  handler: httpAction(async () => new Response(null, { status: 204, headers: { "access-control-allow-origin": "*" } })),
});
// Echoes the bytes it was sent, to prove bodies cross untouched.
http.route({
  method: "POST",
  path: "/echo",
  handler: httpAction(async (_ctx, req) => new Response(await req.arrayBuffer(), { headers: { "content-type": req.headers.get("content-type") ?? "", "x-url": new URL(req.url).pathname + new URL(req.url).search } })),
});
http.route({
  method: "POST",
  path: "/lists",
  handler: httpAction(async (ctx, req) => json({ id: await ctx.runMutation(api.todos.createList, (await req.json()) as { name: string }) })),
});
http.route({ method: "GET", path: "/lists", handler: httpAction(async (ctx) => json(await ctx.runQuery(api.todos.listCounts))) });
http.route({ method: "GET", path: "/whoami", handler: httpAction(async (ctx) => json(await ctx.auth.getUserIdentity())) });
http.route({ method: "GET", pathPrefix: "/files/", handler: httpAction(async (_ctx, req) => new Response(`prefix:${new URL(req.url).pathname}`)) });
http.route({ method: "GET", path: "/files/special", handler: httpAction(async () => new Response("exact")) });
http.route({ method: "GET", path: "/plain", handler: httpAction(async () => new Response("just text")) });
http.route({ method: "GET", path: "/nothing", handler: httpAction(async () => new Response(null, { status: 204 })) });
http.route({
  method: "GET",
  path: "/cookies",
  handler: httpAction(async () => {
    const h = new Headers();
    h.append("set-cookie", "a=1; Path=/");
    h.append("set-cookie", "b=2; Path=/");
    return new Response("ok", { headers: h });
  }),
});
http.route({ method: "GET", path: "/boom", handler: httpAction(async () => { throw new Error("secret internal detail"); }) });
http.route({ method: "GET", path: "/forge-fail", handler: httpAction(async () => { throw new ForgeError({ code: "NOPE" }); }) });
http.route({ method: "GET", path: "/not-a-response", handler: httpAction((async () => "text") as any) });
// A route with a contract: the engine checks the query and body before the handler runs, and the OpenAPI document describes all three.
http.route({
  method: "POST",
  path: "/orders",
  summary: "Place an order",
  tags: ["Orders"],
  query: { dryRun: v.optional(v.boolean()), limit: v.optional(v.number()) },
  body: v.object({ sku: v.string(), qty: v.number(), note: v.optional(v.string()) }),
  returns: v.object({ sku: v.string(), qty: v.number(), dryRun: v.boolean() }),
  handler: httpAction(async (_ctx, req) => {
    const body = (await req.json()) as { sku: string; qty: number };
    return json({ sku: body.sku, qty: body.qty, dryRun: new URL(req.url).searchParams.get("dryRun") === "true" });
  }),
});

export default http;
