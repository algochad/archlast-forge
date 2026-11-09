import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { MINIMAL, MinimalResponse } from "../../../../packages/runtime/src/server/minimal";
import { minimalAction, minimalJson } from "../../../../packages/runtime/src/index";
import { ItemsController } from "./items.controller";
import { get, idOf } from "./store";

const http = httpRouter();
// the same read, as a plain route
http.route({
  method: "GET",
  pathPrefix: "/plain/",
  handler: httpAction(async (_ctx, req) => {
    const id = idOf(new URL(req.url).pathname.split("/").pop());
    const item = id === null ? undefined : get(id);
    return item ? Response.json(item) : Response.json({ error: "not found" }, { status: 404 });
  }),
});
http.route({ method: "GET", path: "/ctx-only", handler: httpAction(async (_ctx) => new Response("ok")) });
http.route({ method: "GET", path: "/ping", handler: httpAction(async () => new Response("ok")) });
// a route that takes the minimal request and answers with bytes: what the pipeline costs without Web objects or Nest
const lite = httpAction((() => new MinimalResponse(200, [["content-type", "application/json"]], '{"ok":true}')) as unknown as () => Response);
(lite as unknown as Record<symbol, unknown>)[MINIMAL] = true;
http.route({ method: "GET", path: "/lite", handler: lite });
const liteAsync = httpAction((async () => new MinimalResponse(200, [["content-type", "application/json"]], '{"ok":true}')) as unknown as () => Response);
(liteAsync as unknown as Record<symbol, unknown>)[MINIMAL] = true;
http.route({ method: "GET", path: "/lite-async", handler: liteAsync });
// the benchmark API's read, as a minimal route (what benchmarks/rest/servers/forge-minimal does)
http.route({
  method: "GET",
  pathPrefix: "/li/",
  handler: minimalAction((_ctx, req) => {
    const id = idOf(req.path.slice(4));
    const item = id === null ? undefined : get(id);
    return item ? minimalJson(item) : minimalJson({ error: "not found" }, 404);
  }),
});
nest(http, { controllers: [ItemsController] });
export default http;
