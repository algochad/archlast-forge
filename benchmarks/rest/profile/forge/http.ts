import { httpAction, httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
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
nest(http, { controllers: [ItemsController] });
export default http;
