import type { HttpRoute } from "../functions";

export type RouteMatch = { route: HttpRoute } | { status: 404 } | { status: 405; allow: string[] };

/** Exact paths win over prefixes, and the longest prefix wins. A path that exists under other methods answers 405. */
export function matchRoute(routes: HttpRoute[], method: string, path: string): RouteMatch {
  const here = routes.filter((r) => (r.path !== undefined ? r.path === path : path.startsWith(r.pathPrefix!)));
  if (!here.length) return { status: 404 };
  const ofMethod = here.filter((r) => r.method === method);
  const best = ofMethod.find((r) => r.path !== undefined) ?? ofMethod.sort((a, b) => b.pathPrefix!.length - a.pathPrefix!.length)[0];
  return best ? { route: best } : { status: 405, allow: [...new Set(here.map((r) => r.method))] };
}

/** The route as it appears in logs and metrics: patterns, not the paths callers sent. */
export const routeName = (r: HttpRoute) => `http ${r.method} ${r.path ?? `${r.pathPrefix}*`}`;
