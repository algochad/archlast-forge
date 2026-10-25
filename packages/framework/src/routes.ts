import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** A file route. `file` is relative to the app directory. */
export interface RouteFile {
  id: string;
  file: string;
  /** Relative to the parent route. Missing on index routes and pathless layouts. */
  path?: string;
  index?: boolean;
  children?: RouteFile[];
}

export interface RouteTree {
  /** app/root.tsx, when it exists. */
  root?: string;
  routes: RouteFile[];
}

const EXT = /\.(tsx|ts|jsx|js)$/;
const NOT_A_ROUTE = /\.(test|spec|d)\.(tsx|ts|jsx|js)$/;

/** `[id]` → `:id`, `[...rest]` → `*`, `(group)` → nothing, anything else as written. */
function segmentOf(name: string, where: string, dir: boolean): string {
  if (dir && /^\(.+\)$/.test(name)) return "";
  const splat = /^\[\.\.\.([A-Za-z_]\w*)\]$/.exec(name);
  if (splat) {
    if (dir) throw new Error(`${where}: a splat ([...${splat[1]}]) must be a file, because nothing can come after it`);
    return "*";
  }
  const param = /^\[([A-Za-z_]\w*)\]$/.exec(name);
  if (param) return `:${param[1]}`;
  if (/[[\]()]/.test(name)) throw new Error(`${where}: "${name}" mixes a dynamic part with other text. Name the whole segment [param], or use only plain characters.`);
  if (!/^[\w.~-]+$/.test(name)) throw new Error(`${where}: "${name}" can't be part of a URL path. Use letters, digits, - _ . ~`);
  return name;
}

const withoutExt = (name: string) => name.replace(EXT, "");

function collect(appDir: string, relDir: string, prefix: string[]): RouteFile[] {
  const entries = readdirSync(join(appDir, relDir), { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  const out: RouteFile[] = [];
  for (const e of entries) {
    if (e.name.startsWith(".")) continue;
    const rel = `${relDir}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name.startsWith("_")) continue; // _components and the like
      const segment = segmentOf(e.name, `app/${rel}`, true);
      const path = [...prefix, ...(segment ? [segment] : [])];
      const layout = readdirSync(join(appDir, rel)).find((f) => EXT.test(f) && withoutExt(f) === "_layout" && !NOT_A_ROUTE.test(f));
      if (layout) out.push({ id: `${rel}/_layout`, file: `${rel}/${layout}`, ...(path.length && { path: path.join("/") }), children: collect(appDir, rel, []) });
      else out.push(...collect(appDir, rel, path));
    } else if (e.isFile() && EXT.test(e.name) && !NOT_A_ROUTE.test(e.name)) {
      const base = withoutExt(e.name);
      if (base.startsWith("_")) continue; // _layout is handled with its directory; other _files are private
      const id = `${relDir}/${base}`;
      if (base === "index") out.push(prefix.length ? { id, file: rel, path: prefix.join("/") } : { id, file: rel, index: true });
      else out.push({ id, file: rel, path: [...prefix, segmentOf(base, `app/${rel}`, false)].join("/") });
    }
  }
  return out;
}

/** The URL every non-layout route answers, to catch two files claiming the same one. */
function checkConflicts(routes: RouteFile[], base: string, seen = new Map<string, { file: string; url: string }>()) {
  for (const r of routes) {
    const here = [base, r.path].filter(Boolean).join("/");
    if (r.children) checkConflicts(r.children, here, seen);
    else {
      const url = `/${here}`;
      // [id] and [slug] are different names for the same URLs, so parameter names don't count.
      const key = url.replace(/:[A-Za-z_]\w*/g, ":");
      const other = seen.get(key);
      if (other) throw new Error(`app/${other.file} and app/${r.file} both answer ${other.url === url ? url : `the same URLs (${other.url} and ${url}: parameter names don't tell routes apart)`}. Keep one.`);
      seen.set(key, { file: r.file, url });
    }
  }
}

export function scanRoutes(appDir: string): RouteTree {
  const routesDir = join(appDir, "routes");
  if (!existsSync(routesDir)) throw new Error(`No routes directory at ${routesDir}. Create app/routes/index.tsx for the home page.`);
  const root = ["root.tsx", "root.jsx", "root.ts", "root.js"].find((f) => existsSync(join(appDir, f)));
  const routes = collect(appDir, "routes", []);
  if (!routes.length) throw new Error(`${routesDir} has no routes. Create index.tsx for the home page.`);
  checkConflicts(routes, "");
  return { ...(root && { root }), routes };
}
