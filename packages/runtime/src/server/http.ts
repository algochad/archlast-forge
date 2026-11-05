import type { HttpRoute } from "../functions";
import { validate, validateFields, ValidationError, type Validator } from "../values";

type RoutePattern = Pick<HttpRoute, "method" | "path" | "pathPrefix">;
export type RouteMatch<R extends RoutePattern = HttpRoute> = { route: R } | { status: 404 } | { status: 405; allow: string[] };

/** Exact paths win over prefixes, and the longest prefix wins. A path that exists under other methods answers 405. */
export function matchRoute<R extends RoutePattern>(routes: R[], method: string, path: string): RouteMatch<R> {
  const here = routes.filter((r) => (r.path !== undefined ? r.path === path : path.startsWith(r.pathPrefix!)));
  if (!here.length) return { status: 404 };
  const ofMethod = here.filter((r) => r.method === method);
  const best = ofMethod.find((r) => r.path !== undefined) ?? ofMethod.sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length)[0];
  return best ? { route: best } : { status: 405, allow: [...new Set(here.map((r) => r.method))] };
}

/** The route as it appears in logs and metrics: patterns, not the paths callers sent. */
export const routeName = (r: HttpRoute) => `http ${r.method} ${r.path ?? `${r.pathPrefix}*`}`;

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
