import { anyApi, ForgeError, httpAction, httpRouter } from "../../src/index";

const api = anyApi;
const http = httpRouter();
const json = (body: unknown, init?: ResponseInit) => Response.json(body, init);

http.route({ method: "GET", path: "/hello", handler: httpAction(async () => new Response("hello", { headers: { "x-custom": "yes" } })) });
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

export default http;
