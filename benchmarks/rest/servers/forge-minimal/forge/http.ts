import { httpRouter, minimalAction, minimalJson, MinimalResponse, type MinimalRequest } from "@archlast/forge-runtime";
import { create, get, idOf, limitOf, list, parse, remove, update } from "./store";

// The same API on `forge/http.ts`'s own routes, written with minimalAction: the handler is given the request's fields and answers with bytes, no Web `Request` or `Response`.
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
http.route({ method: "GET", path: "/items", handler: minimalAction((_ctx, req) => minimalJson(list(limitOf(new URLSearchParams(req.search).get("limit"))))) });
http.route({
  method: "POST",
  path: "/items",
  handler: minimalAction((_ctx, req) => {
    const input = json(req);
    return input ? minimalJson(create(input), 201) : invalid();
  }),
});
http.route({
  method: "GET",
  pathPrefix: "/items/",
  handler: minimalAction((_ctx, req) => {
    const id = idIn(req);
    const item = id === null ? undefined : get(id);
    return item ? minimalJson(item) : notFound();
  }),
});
http.route({
  method: "PUT",
  pathPrefix: "/items/",
  handler: minimalAction((_ctx, req) => {
    const id = idIn(req);
    if (id === null) return notFound();
    const input = json(req);
    if (!input) return invalid();
    const item = update(id, input);
    return item ? minimalJson(item) : notFound();
  }),
});
http.route({
  method: "DELETE",
  pathPrefix: "/items/",
  handler: minimalAction((_ctx, req) => {
    const id = idIn(req);
    return id !== null && remove(id) ? new MinimalResponse(204, [], null) : notFound();
  }),
});
export default http;
