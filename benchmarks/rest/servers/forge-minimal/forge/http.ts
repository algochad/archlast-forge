import { httpRouter, lightAction, lightJson, LightResponse, type LightRequest } from "@archlast/forge-runtime";
import { create, get, idOf, limitOf, list, parse, remove, update } from "./store";

// The same API on `forge/http.ts`'s own routes, written with lightAction: the handler is given the request's fields and answers with bytes, no Web `Request` or `Response`.
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
http.route({ method: "GET", path: "/items", handler: lightAction((_ctx, req) => lightJson(list(limitOf(new URLSearchParams(req.search).get("limit"))))) });
http.route({
  method: "POST",
  path: "/items",
  handler: lightAction((_ctx, req) => {
    const input = json(req);
    return input ? lightJson(create(input), 201) : invalid();
  }),
});
http.route({
  method: "GET",
  pathPrefix: "/items/",
  handler: lightAction((_ctx, req) => {
    const id = idIn(req);
    const item = id === null ? undefined : get(id);
    return item ? lightJson(item) : notFound();
  }),
});
http.route({
  method: "PUT",
  pathPrefix: "/items/",
  handler: lightAction((_ctx, req) => {
    const id = idIn(req);
    if (id === null) return notFound();
    const input = json(req);
    if (!input) return invalid();
    const item = update(id, input);
    return item ? lightJson(item) : notFound();
  }),
});
http.route({
  method: "DELETE",
  pathPrefix: "/items/",
  handler: lightAction((_ctx, req) => {
    const id = idIn(req);
    return id !== null && remove(id) ? new LightResponse(204, [], null) : notFound();
  }),
});
export default http;
