import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { LIGHT, LightResponse } from "../../../../packages/runtime/src/server/light";
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
http.route({ method: "GET", path: "/ping", handler: httpAction(async () => new Response("ok")) });
// a route that takes the light request and answers with bytes: what the pipeline costs without Web objects or Nest
const lite = httpAction(async () => new LightResponse(200, [["content-type", "application/json"]], '{"ok":true}') as unknown as Response);
(lite as unknown as Record<symbol, unknown>)[LIGHT] = true;
http.route({ method: "GET", path: "/lite", handler: lite });
nest(http, { controllers: [ItemsController] });
export default http;
