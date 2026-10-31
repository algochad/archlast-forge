// Hash routes: `#/requests?kind=query&op=todos:list`. The page, then its details as query parameters, so every view has a link that
// can be shared or opened in a new tab. Older links (`#Data`) still land on their page.
import { useEffect, useState } from "react";

export type Route = { page: string; params: URLSearchParams };

const LEGACY: Record<string, string> = { Overview: "overview", Data: "data", Files: "files", Users: "users", Functions: "functions", Scheduled: "jobs", Logs: "logs", Metrics: "runtime", Cache: "cache", Audit: "audit", Settings: "settings" };

export function parse(hash = location.hash): Route {
  const raw = hash.replace(/^#\/?/, "");
  if (LEGACY[raw]) return { page: LEGACY[raw]!, params: new URLSearchParams() };
  const [path = "", query = ""] = raw.split("?");
  return { page: path || "overview", params: new URLSearchParams(query) };
}

export function href(page: string, params: Record<string, string | number | undefined | null> = {}) {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== "") q.set(k, String(v));
  const s = q.toString();
  return `#/${page}${s ? `?${s}` : ""}`;
}

export function navigate(page: string, params: Record<string, string | number | undefined | null> = {}) {
  const next = href(page, params);
  if (location.hash !== next) location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parse);
  useEffect(() => {
    const on = () => setRoute(parse());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  return route;
}
