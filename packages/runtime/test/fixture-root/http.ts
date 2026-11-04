import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { TasksController } from "./tasks.controller";

// Served at the root as well as under /http.
const http = httpRouter({ root: true });

http.route({
  method: "GET",
  path: "/api/v1/hello",
  handler: httpAction(async (_ctx, req) => Response.json({ hello: "world", path: new URL(req.url).pathname })),
});
http.route({ method: "POST", path: "/webhooks/stripe", handler: httpAction(async (_ctx, req) => new Response(await req.text())) });
// Every path: in a backend it answers what the engine doesn't own, in a full-stack app it stays under /http so the pages keep theirs.
http.route({ method: "GET", pathPrefix: "/", handler: httpAction(async (_ctx, req) => new Response(`catch-all ${new URL(req.url).pathname}`)) });
nest(http, { prefix: "/api/v2/", controllers: [TasksController] });

export default http;
