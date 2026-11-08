import type { HttpRoute } from "../functions";
import { validate, validateFields, ValidationError, type Validator } from "../values";

type RoutePattern = Pick<HttpRoute, "method" | "path" | "pathPrefix">;
export type RouteMatch<R extends RoutePattern = HttpRoute> = { route: R } | { status: 404 } | { status: 405; allow: string[] };

/**
 * Exact paths win over prefixes, and the longest prefix wins (the first declared among equals). A path that exists under other methods answers 405.
 *
 * The routes are fixed once loaded, so they are indexed once: exact paths in a map, prefixes longest first. A request that finds its route never scans or allocates,
 * however many different paths (`/items/1`, `/items/2`, …) a server is asked for. A path that finds none (a 404 or a 405) is answered the long way, which lists
 * what matched it.
 */
interface RouteIndex<R extends RoutePattern> {
  size: number;
  exact: Map<string, R[]>;
  prefixes: R[];
}
const indexes = new WeakMap<object, RouteIndex<any>>();
let lastRoutes: object | undefined;
let lastIndex: RouteIndex<any> | undefined;

function indexOf<R extends RoutePattern>(routes: R[]): RouteIndex<R> {
  if (routes === lastRoutes && lastIndex!.size === routes.length) return lastIndex!;
  let index = indexes.get(routes) as RouteIndex<R> | undefined;
  if (!index || index.size !== routes.length) {
    index = { size: routes.length, exact: new Map(), prefixes: [] };
    for (const r of routes) {
      if (r.path !== undefined) {
        const list = index.exact.get(r.path);
        if (list) list.push(r);
        else index.exact.set(r.path, [r]);
      } else index.prefixes.push(r);
    }
    index.prefixes.sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length); // stable: equal lengths keep the order they were declared in
    indexes.set(routes, index);
  }
  lastRoutes = routes;
  lastIndex = index;
  return index;
}

export function matchRoute<R extends RoutePattern>(routes: R[], method: string, path: string): RouteMatch<R> {
  const index = indexOf(routes);
  const exact = index.exact.get(path);
  if (exact) for (const r of exact) if (r.method === method) return { route: r };
  for (const r of index.prefixes) if (r.method === method && path.startsWith(r.pathPrefix!)) return { route: r };
  return findRoute(routes, method, path);
}

function findRoute<R extends RoutePattern>(routes: R[], method: string, path: string): RouteMatch<R> {
  const here = routes.filter((r) => (r.path !== undefined ? r.path === path : path.startsWith(r.pathPrefix!)));
  if (!here.length) return { status: 404 };
  const ofMethod = here.filter((r) => r.method === method);
  const best = ofMethod.find((r) => r.path !== undefined) ?? ofMethod.sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length)[0];
  return best ? { route: best } : { status: 405, allow: [...new Set(here.map((r) => r.method))] };
}

const wants = new WeakMap<Function, boolean>();

/**
 * Whether an HTTP action's handler can use the `Request` it is called with: false only for a function that declares nothing but `ctx` (`async (ctx) => …`, a
 * health check), which has no way to reach it. Then none is made. A function with a second parameter (even one with a default), a rest parameter or a use of
 * `arguments` gets one, as does anything this cannot read.
 */
export function takesRequest(fn: Function): boolean {
  let known = wants.get(fn);
  if (known !== undefined) return known;
  known = true;
  if (fn.length === 1) {
    const source = Function.prototype.toString.call(fn);
    // the parameter list: from the first "(" (or none, for `ctx => …`) to its ")" or to the arrow
    const arrow = source.indexOf("=>");
    const open = source.indexOf("(");
    let params: string | undefined;
    if (open >= 0 && (arrow < 0 || open < arrow)) {
      let depth = 0;
      for (let i = open; i < source.length; i++) {
        const c = source[i];
        if (c === "(" || c === "[" || c === "{") depth++;
        else if (c === ")" || c === "]" || c === "}") {
          depth--;
          if (depth === 0) {
            params = source.slice(open + 1, i);
            break;
          }
        }
      }
    } else if (arrow >= 0) params = source.slice(0, arrow).replace(/^\s*async\s+/, "");
    if (params !== undefined && !/[,=.]/.test(params) && !/\barguments\b/.test(source)) known = false;
  }
  wants.set(fn, known);
  return known;
}

/** The route as it appears in logs and metrics: patterns, not the paths callers sent. */
const names = new WeakMap<HttpRoute, string>();
export const routeName = (r: HttpRoute) => {
  let name = names.get(r);
  if (name === undefined) names.set(r, (name = `http ${r.method} ${r.path ?? `${r.pathPrefix}*`}`));
  return name;
};

/** Query parameters arrive as text: converted to what each validator expects, so the same validators check them and describe them. */
export function queryValue(validator: Validator, values: string[]): unknown {
  if (!values.length) return undefined;
  const one = (raw: string, v: Validator): unknown => {
    if (v.kind === "number") return raw.trim() !== "" && Number.isFinite(Number(raw)) ? Number(raw) : raw;
    if (v.kind === "boolean") return raw === "true" || raw === "1" ? true : raw === "false" || raw === "0" ? false : raw;
    // A literal (or a union with one) is whichever of its values the text spells: `?status=1` for v.literal(1), `?all=true` for v.literal(true).
    if (v.kind === "literal") return typeof v.value === "string" ? raw : String(v.value) === raw ? v.value : raw;
    if (v.kind === "union") {
      const literal = v.members!.find((m) => m.kind === "literal" && String(m.value) === raw);
      if (literal) return literal.value;
      if (v.members!.some((m) => m.kind === "null") && raw === "null") return null;
      return v.members!.some((m) => m.kind === "number") && Number.isFinite(Number(raw)) && raw.trim() !== "" ? Number(raw) : raw;
    }
    return raw;
  };
  return validator.kind === "array" ? values.map((raw) => one(raw, validator.element!)) : one(values.at(-1)!, validator);
}

/**
 * Checks a request against its route's `query` and `body` validators, before the handler runs. Returns why it doesn't match, or nothing.
 * The handler still gets the request as it came (the body unread).
 */
export function checkHttpRequest(route: HttpRoute, url: string, body: ArrayBuffer | undefined): string | undefined {
  try {
    if (route.query) {
      const params = new URL(url).searchParams;
      validateFields(route.query, Object.fromEntries(Object.entries(route.query).map(([name, v]) => [name, queryValue(v, params.getAll(name))])), "query");
    }
    if (route.body) {
      const text = body ? new TextDecoder().decode(body) : "";
      let value: unknown;
      try {
        value = text === "" ? undefined : JSON.parse(text);
      } catch {
        return "The body must be JSON";
      }
      if (value === undefined && !route.body.optional) return "The body must be JSON";
      if (value !== undefined) validate(route.body, value, "body");
    }
  } catch (e) {
    if (e instanceof ValidationError) return e.message;
    throw e;
  }
}
