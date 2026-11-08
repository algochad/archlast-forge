import { ArchlastForgeClient, queryKey } from "@archlast/forge-client";
import { getFunctionName, isForgeError } from "@archlast/forge-runtime";
import type { AppEnv, AppHost } from "@archlast/forge-runtime/server";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { preinit, preloadModule } from "react-dom";
import type { ReactElement } from "react";
import { renderToReadableStream, renderToString } from "react-dom/server";
import { createStaticHandler, createStaticRouter, isRouteErrorResponse, matchRoutes, RouterContextProvider, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { BuildError, buildApp, readBuild, type BuildManifest, type BuildResult } from "./build";
import { createViewerStore, forgeContext, type LoaderContext, type Viewer } from "./context";
import { buildErrorPage, DEV_SCRIPT, DevEvents, watchApp } from "./dev";
import { IslandsContext, type IslandCount } from "./island";
import { Providers } from "./providers";
import { toRouteObjects } from "./route-objects";
import { reviveErrors, type PageState, type SerializedError } from "./state";
import { memoizeIntl } from "./intl-cache";
import { DEFAULT_ZONE, ZONE_COOKIE, zoneFromCookie, type TimeState } from "./time";

export interface AppOptions {
  /** The project directory: it holds app/, public/ and forge/. */
  root: string;
  dev: boolean;
  /** Render pages with islands where the app allows it (see classify.ts). Default: what app/root.tsx's `islands` export or FORGE_ISLANDS says. */
  islands?: boolean;
  /** Where build and error messages go. Defaults to the console. */
  log?: (level: "info" | "error", message: string) => void;
}

interface Loaded {
  build: BuildResult;
  handler: ReturnType<typeof createStaticHandler>;
  routes: ReturnType<typeof toRouteObjects>;
  clientDir: string;
  /** app/root.tsx's `authPlugins`, for the client each render makes. */
  authPlugins?: unknown[];
  /** Routes whose pages the engine prints (see render-compile.ts): the template's id there and the code that runs the app's functions for it. */
  templates: Map<string, { id: number; prep?: (d: unknown) => void }>;
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-cache",
  vary: "cookie",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

/** The engine's template functions, or null where the native engine is not here (not Linux, not built, or this package is used without it). */
let templateEngine: Promise<{ registerTemplate(name: string, template: unknown): number } | null> | undefined;
function nativeTemplates() {
  templateEngine ??= (async () => {
    try {
      const url = new URL("../../serve/src/templates.ts", import.meta.url);
      if (!existsSync(new URL("../native/archlast_serve.node", url))) return null;
      const mod = await import(url.href);
      mod.registerTemplate("probe", ["ok"]);
      return mod;
    } catch {
      return null;
    }
  })();
  return templateEngine;
}

/** JSON that is safe inside a <script> element. */
const scriptJson = (value: unknown) =>
  JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replaceAll(String.fromCharCode(0x2028), "\\u2028")
    .replaceAll(String.fromCharCode(0x2029), "\\u2029");

/** A path below `base` for a URL path, or undefined when it would leave `base` or is not a plain file name. */
function inside(base: string, urlPath: string): string | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return undefined;
  }
  if (decoded.includes("\0") || decoded.split(/[\\/]/).some((seg) => seg === ".." || (seg.startsWith(".") && seg !== "." && seg !== ".well-known"))) return undefined;
  const full = resolve(base, `.${decoded.startsWith("/") ? decoded : `/${decoded}`}`);
  return full.startsWith(base + sep) ? full : undefined;
}

// Async: a request for a file must not stop the event loop on the disk.
const isFile = (path: string) => stat(path).then((s) => s.isFile(), () => false);

async function fileResponse(path: string, req: Request, o: { cache: string; precompressed: boolean }): Promise<Response> {
  const headers: Record<string, string> = { "cache-control": o.cache, "x-content-type-options": "nosniff" };
  const accepted = req.headers.get("accept-encoding") ?? "";
  if (o.precompressed) {
    headers.vary = "accept-encoding";
    for (const [encoding, ext] of [["br", "br"], ["gzip", "gz"]] as const) {
      if (new RegExp(`\\b${encoding}\\b`).test(accepted) && (await isFile(`${path}.${ext}`))) {
        const file = Bun.file(`${path}.${ext}`);
        return new Response(file, { headers: { ...headers, "content-encoding": encoding, "content-type": Bun.file(path).type } });
      }
    }
  }
  return new Response(Bun.file(path), { headers });
}

function serializeErrors(errors: StaticHandlerContext["errors"], o: { dev: boolean; requestId: string; log: NonNullable<AppOptions["log"]> }): Record<string, SerializedError> | null {
  if (!errors) return null;
  return Object.fromEntries(
    Object.entries(errors).map(([id, e]): [string, SerializedError] => {
      if (isRouteErrorResponse(e)) return [id, { kind: "response", status: e.status, statusText: e.statusText, data: e.data }];
      const err = e instanceof Error ? e : new Error(String(e));
      // ForgeErrors and the failures of a function call carry messages meant for callers; a bug in a loader keeps its details to itself.
      const meant = isForgeError(err) || typeof (err as { requestId?: unknown }).requestId === "string";
      if (!isForgeError(err)) o.log("error", `${err.stack ?? err.message} (request ${o.requestId}, route ${id})`);
      return [id, { kind: "error", message: o.dev || meant ? err.message : `Server error (request ${o.requestId})`, ...(o.dev && err.stack && { stack: err.stack }) }];
    }),
  );
}

/** What a route's `handle.cache` asks for, if it is valid: `export const handle = { cache: { ttl: 30, tags: ["home"] } }`. */
function cacheRequest(context: StaticHandlerContext): { ttl: number; tags: string[] } | undefined {
  const c = (context.matches.at(-1)?.route.handle as { cache?: { ttl?: unknown; tags?: unknown } } | undefined)?.cache;
  if (!c || typeof c.ttl !== "number" || !(c.ttl >= 1) || c.ttl > 86_400) return undefined;
  const tags = Array.isArray(c.tags) ? c.tags.filter((t): t is string => typeof t === "string" && /^[\w.:-]{1,64}$/.test(t)) : [];
  return { ttl: Math.floor(c.ttl), tags };
}

/** The CSP hashes (`sha256-…`) of the inline scripts in some HTML: a page that is kept names them instead of carrying a nonce. */
function inlineScriptHashes(html: string): string[] {
  const hashes = new Set<string>();
  for (const m of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = m[1]!;
    if (/\ssrc\s*=/i.test(attrs)) continue;
    const type = /\stype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs)?.[1]?.toLowerCase();
    if (type && type !== "module" && !type.includes("javascript")) continue; // data blocks are not run
    hashes.add(`sha256-${new Bun.CryptoHasher("sha256").update(m[2]!).digest("base64")}`);
  }
  return [...hashes];
}

/**
 * The page as HTML, rendered in one go. `renderToString` is about a third cheaper than the stream (no chunks to count and write, no Web stream to read back),
 * and every page here is waited for to the end anyway. It cannot wait for a component that suspends (it writes the fallback and a marker for the browser to retry),
 * so a page that does, or one that throws, returns null and is rendered again as a stream, which waits and reports errors the usual way.
 */
function renderInOnePass(element: ReactElement): string | null {
  try {
    const html = renderToString(element);
    if (html.includes("<!--$!-->") || html.includes("<!--$?-->")) return null;
    return html.startsWith("<html") ? `<!DOCTYPE html>${html}` : html;
  } catch {
    return null;
  }
}

/** The scripts of a page that is rendered and hydrated as a whole, put into the HTML the way React's `bootstrapScriptContent` and `bootstrapModules` do. */
function withBootstrap(html: string, o: { entry: string; state: PageState; nonce?: string; dev: boolean }): string {
  const nonce = o.nonce ? ` nonce="${escapeAttr(o.nonce)}"` : "";
  const module = (file: string) => `<script type="module" src="/_app/${escapeAttr(file)}" async=""${nonce}></script>`;
  const scripts = `<script${nonce}>window.__FORGE__=${scriptJson(o.state)};</script>${module(o.entry)}${o.dev ? module("__dev.js") : ""}`;
  return insertAround(html, { marker: "</head>", text: `<link rel="modulepreload" fetchPriority="low" href="/_app/${escapeAttr(o.entry)}"/>` }, { marker: "</body>", text: scripts });
}

const escapeAttr = (v: string) => v.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/**
 * The scripts of a page with islands, put into the HTML React wrote: before `</body>` the page's state and the islands entry, and before `</head>` the
 * preloads of what the entry loads. A page where no island rendered gets none of them: it needs no JavaScript at all (the dev page still gets its reload script).
 */
function withScripts(html: string, o: { islands: NonNullable<BuildManifest["islands"]>; meter: IslandCount; state: PageState; nonce?: string; dev: boolean }): string {
  const nonce = o.nonce ? ` nonce="${escapeAttr(o.nonce)}"` : "";
  const module = (file: string) => `<script type="module" src="/_app/${escapeAttr(file)}" async=""${nonce}></script>`;
  const dev = o.dev ? module("__dev.js") : "";
  // Every page gets the navigation script (a few hundred bytes), so a link to another page swaps it in; the rest only when an island rendered.
  if (o.meter.count === 0) return insertAround(html, { marker: "</head>", text: "" }, { marker: "</body>", text: module(o.islands.nav) + dev });
  const preloads = o.islands.preload.map((f) => `<link rel="modulepreload" href="/_app/${escapeAttr(f)}"${nonce}/>`).join("");
  // The state is data, not a script: it needs no nonce, and a page that is swapped in carries it as a loaded one does.
  const state = `<script type="application/json" id="forge-state">${scriptJson(o.state)}</script>`;
  return insertAround(html, { marker: "</head>", text: preloads }, { marker: "</body>", text: state + module(o.islands.entry) + module(o.islands.nav) + dev });
}

/** `html` with `text` before the first `head` marker and the last `tail` marker (both searched from the nearer end: the head is at the start, the body's end at the end). */
function insertAround(html: string, head: { marker: string; text: string }, tail: { marker: string; text: string }): string {
  const h = head.text ? html.indexOf(head.marker) : -1;
  const t = tail.text ? html.lastIndexOf(tail.marker) : -1;
  const parts: string[] = [];
  let from = 0;
  if (h >= 0) {
    parts.push(html.slice(0, h), head.text);
    from = h;
  } else if (head.text) {
    // no head to put it in: it goes with the tail
    tail = { ...tail, text: head.text + tail.text };
  }
  if (t >= 0) parts.push(html.slice(from, t), tail.text, html.slice(t));
  else parts.push(html.slice(from), tail.text);
  return parts.join("");
}

function Page(props: { islands: IslandCount | null; router: ReturnType<typeof createStaticRouter>; context: StaticHandlerContext; client: ArchlastForgeClient; queryClient: QueryClient; viewer: ReturnType<typeof createViewerStore>; time: TimeState; dev: boolean; css: string[]; preload: string[]; nonce?: string }) {
  // Float hoists these into <head>, wherever the user's root document puts it.
  for (const href of props.css) preinit(`/_app/${href}`, { as: "style", precedence: "forge" });
  for (const file of props.preload) preloadModule(`/_app/${file}`, { as: "script" });
  return (
    <Providers client={props.client} queryClient={props.queryClient} viewer={props.viewer} time={props.time} dev={props.dev} nonce={props.nonce}>
      <IslandsContext.Provider value={props.islands}>
        <StaticRouterProvider router={props.router} context={props.context} hydrate={false} />
      </IslandsContext.Provider>
    </Providers>
  );
}

/**
 * The app as an engine host: build it (dev) or load the build (production), then serve pages, built assets and public/.
 * Pass the result to startServer({ app }).
 */
export async function createApp(opts: AppOptions): Promise<AppHost> {
  const { dev } = opts;
  if (process.env.FORGE_MEMO_INTL !== "0") memoizeIntl();
  const root = resolve(opts.root);
  const log = opts.log ?? ((level, message) => (level === "error" ? console.error(message) : console.log(message)));
  const publicDir = join(root, "public");
  const events = new DevEvents();
  let loaded: Loaded | undefined;
  let buildError: string | undefined;

  async function load(build: BuildResult) {
    const mod = (await import(join(build.dir, build.manifest.server))) as { manifest: Parameters<typeof toRouteObjects>[0]; templates?: { route: string; template: unknown[]; prep?: (d: unknown) => void }[] };
    const routes = toRouteObjects(mod.manifest);
    const engine = mod.templates?.length ? await nativeTemplates() : null;
    const templates = new Map<string, { id: number; prep?: (d: unknown) => void }>();
    for (const t of mod.templates ?? []) if (engine) templates.set(t.route, { id: engine.registerTemplate(`${root}:${t.route}`, t.template), prep: t.prep });
    loaded = { build, routes, templates, handler: createStaticHandler(routes), clientDir: join(build.dir, "client"), authPlugins: mod.manifest.module?.authPlugins };
  }

  async function rebuild(): Promise<boolean> {
    const began = performance.now();
    try {
      await load(await buildApp({ root, dev, islands: opts.islands }));
      buildError = undefined;
      log("info", `✓ app built in ${Math.round(performance.now() - began)} ms`);
      return true;
    } catch (e) {
      buildError = e instanceof BuildError ? e.message : ((e as Error).stack ?? String(e));
      log("error", `✗ app build failed\n${buildError}`);
      return false;
    }
  }

  let stopWatching = () => {};
  if (dev) {
    await rebuild();
    stopWatching = watchApp(root, async (files) => {
      if (files.every((f) => f.startsWith(publicDir))) return events.broadcast({ type: "reload" });
      if (await rebuild()) events.broadcast({ type: "reload" });
      else events.broadcast({ type: "error", message: buildError! });
    });
  } else {
    const build = readBuild(root);
    if (!build) throw new BuildError(`No production build in ${join(root, ".forge", "build")}. Run \`archlast-forge build --no-docker\` first.`);
    await load(build);
  }

  async function asset(path: string, req: Request, env: AppEnv): Promise<Response | undefined> {
    if (dev && path === "/_app/__dev.js") return new Response(DEV_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    if (dev && path === "/_app/__events") {
      env.keepAlive();
      return events.response();
    }
    if (!loaded) return undefined;
    const file = inside(loaded.clientDir, path.slice("/_app".length));
    if (!file || !(await isFile(file))) return new Response("Not found", { status: 404 });
    return fileResponse(file, req, { cache: dev ? "no-cache" : "public, max-age=31536000, immutable", precompressed: !dev });
  }

  async function page(req: Request, env: AppEnv, url: URL): Promise<Response> {
    // While the build is broken the page says so, instead of showing the last build that worked.
    if (buildError) return buildErrorPage(buildError, env.nonce);
    if (!loaded) return new Response("The app isn't built yet", { status: 503 });
    const wait = await env.rateLimited();
    if (wait !== null) return new Response("Too many requests", { status: 429, headers: { "retry-after": String(wait), "content-type": "text/plain; charset=utf-8" } });

    const { handler, build, authPlugins } = loaded;
    // One instant and one zone for the whole render, and the same two in the page: the browser's hydrating render uses them too.
    const time: TimeState = { now: Date.now(), timeZone: zoneFromCookie(req.headers.get("cookie")) ?? DEFAULT_ZONE };
    const queryClient = new QueryClient({ defaultOptions: { queries: { staleTime: Infinity } } });
    let asking: Promise<Viewer | null> | undefined;
    const ctx: LoaderContext = {
      async query(ref, ...args) {
        const value = await env.call(getFunctionName(ref), "query", args[0]);
        queryClient.setQueryData(queryKey(ref, args[0]), value);
        return value as never;
      },
      viewer: () =>
        (asking ??= !env.headers.cookie && !env.headers.authorization
          ? Promise.resolve(null)
          : env.identity().then((i) => (i ? { userId: i.userId, email: i.email, name: i.name } : null))),
    };

    const result = await handler.query(req, { requestContext: new RouterContextProvider(new Map([[forgeContext, ctx]])) });
    if (result instanceof Response) {
      result.headers.set("cache-control", "no-store");
      return result;
    }
    const context = result;
    // The engine names this request by the route it matched, so /posts/1 and /posts/2 are one route in its telemetry. A page nothing
    // matched is one name too, or every URL a crawler tries would be a route of its own.
    env.route?.(
      context.statusCode === 404
        ? "(unmatched)"
        : context.matches
            .map((m) => m.route.path ?? "")
            .filter(Boolean)
            .join("/")
            .replace(/\/{2,}/g, "/")
            .replace(/^\/?/, "/")
            .replace(/(.)\/$/, "$1"),
    );
    // The page renders with the same errors the browser will be handed: what a visitor may see, and nothing else.
    const errors = serializeErrors(context.errors, { dev, requestId: env.requestId, log });
    context.errors = reviveErrors(errors);
    const viewer = createViewerStore(await ctx.viewer().catch(() => null));
    // With islands the page is HTML plus a few small roots, and no router starts in the browser: nothing to hand it. A page with an error, or
    // with a route the build could not place, is rendered and hydrated as a whole.
    const islands = build.manifest.islands;
    const withIslands = Boolean(islands && !errors && context.matches.every((m) => m.route.id === "root" || islands.routes.includes(m.route.id)));
    const state: PageState = {
      dev,
      ...time,
      viewer: viewer.get(),
      queries: dehydrate(queryClient),
      hydration: withIslands ? { loaderData: {}, actionData: null, errors: null } : { loaderData: context.loaderData, actionData: context.actionData, errors },
      ...(env.nonce && { nonce: env.nonce }),
    };
    // A page the engine can print from a template (render-compile.ts) is not rendered here: the data goes to it as JSON, and it prints the page on its I/O thread.
    const leaf = context.matches.at(-1)?.route.id;
    const printed = withIslands && env.templates && leaf !== undefined ? loaded.templates.get(leaf) : undefined;
    const status0 = context.statusCode;
    if (printed) {
      const nonce = env.nonce ? ` nonce="${escapeAttr(env.nonce)}"` : "";
      const d = {
        l: Object.fromEntries(context.matches.map((m) => [m.route.id, context.loaderData[m.route.id] ?? null])),
        viewer: viewer.get(),
        tz: time.timeZone,
        params: context.matches.at(-1)?.params ?? {},
        path: url.pathname,
        headEnd: build.manifest.css.map((href) => `<link rel="stylesheet" href="/_app/${escapeAttr(href)}" data-precedence="forge"/>`).join(""),
        bodyEnd: `<script type="module" src="/_app/${escapeAttr(islands!.nav)}" async=""${nonce}></script>${dev ? `<script type="module" src="/_app/__dev.js" async=""${nonce}></script>` : ""}`,
      };
      printed.prep?.(d);
      const keepIt = !dev && status0 === 200 && viewer.get() === null && !env.headers.authorization ? cacheRequest(context) : undefined;
      return new Response(JSON.stringify(d), {
        status: status0,
        headers: {
          ...HTML_HEADERS,
          "x-forge-page": "islands",
          "x-forge-template": String(printed.id),
          ...(keepIt && { "x-forge-cache": `ttl=${keepIt.ttl}; vary-cookie=${ZONE_COOKIE}; only-cookie=; skip-header=authorization${keepIt.tags.length ? `; tag=${keepIt.tags.join(",")}` : ""}`, "x-forge-csp-hashes": "" }),
        },
      });
    }
    const router = createStaticRouter(handler.dataRoutes, context);
    const preload = withIslands ? [] : [...new Set(context.matches.flatMap((m) => build.manifest.routes[m.route.id] ?? []))].filter((f) => f !== build.manifest.entry);
    const client = new ArchlastForgeClient({ url: url.origin, authPlugins });
    const status = context.statusCode;
    const meter: IslandCount | null = withIslands ? { count: 0 } : null;

    try {
      const element = <Page islands={meter} router={router} context={context} client={client} queryClient={queryClient} viewer={viewer} time={time} dev={dev} css={build.manifest.css} preload={preload} nonce={env.nonce} />;
      let body = renderInOnePass(element);
      if (body === null) {
        const stream = await renderToReadableStream(element, {
          // React's own inline scripts (streamed boundaries) carry the engine's CSP nonce.
          ...(env.nonce && { nonce: env.nonce }),
          signal: req.signal,
          onError: (e) => log("error", `render failed (request ${env.requestId}): ${(e as Error)?.stack ?? e}`),
        });
        await stream.allReady;
        body = await new Response(stream).text();
      }
      // The scripts are added here, not by React: a page with islands has them only if an island rendered.
      if (!meter) return new Response(withBootstrap(body, { entry: build.manifest.entry, state, nonce: env.nonce, dev }), { status, headers: { ...HTML_HEADERS, "x-request-id": env.requestId } });
      const document = withScripts(body, { islands: islands!, meter, state, nonce: env.nonce, dev });
      // A page a route asks to have kept (`handle.cache`) is kept for anonymous visitors only: the same HTML would be served to anyone, so nothing in it may be about
      // a person. The engine does the keeping (and drops this note when it cannot), and a hit is served without running the app: the page can be up to `ttl`
      // seconds old, and a request that carries any cookie but the time zone's, or an authorization header, is not served from it.
      const keep = !dev && status === 200 && viewer.get() === null && !env.headers.authorization ? cacheRequest(context) : undefined;
      if (keep)
        return new Response(document, {
          status,
          headers: {
            ...HTML_HEADERS,
            "x-forge-page": "islands",
            "x-forge-cache": `ttl=${keep.ttl}; vary-cookie=${ZONE_COOKIE}; only-cookie=; skip-header=authorization${keep.tags.length ? `; tag=${keep.tags.join(",")}` : ""}`,
            "x-forge-csp-hashes": inlineScriptHashes(document).join(","),
          },
        });
      return new Response(document, { status, headers: { ...HTML_HEADERS, "x-forge-page": "islands", "x-request-id": env.requestId } });
    } catch (e) {
      log("error", `render failed (request ${env.requestId}): ${(e as Error)?.stack ?? e}`);
      return dev ? buildErrorPage(`A page failed to render:\n\n${(e as Error)?.stack ?? e}`, env.nonce) : new Response(`Server error (request ${env.requestId})`, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
    }
  }

  return {
    async fetch(req, env) {
      const url = new URL(req.url);
      const path = url.pathname;
      if (path.startsWith("/_app/")) return asset(path, req, env);
      if (req.method !== "GET" && req.method !== "HEAD") return undefined;
      // Files in public/ have extensions; pages don't need a lookup on disk.
      if (/\.[^/]+$/.test(path)) {
        const file = inside(publicDir, path);
        if (file && (await isFile(file))) return fileResponse(file, req, { cache: dev ? "no-cache" : "public, max-age=3600", precompressed: false });
      }
      return page(req, env, url);
    },
    dispose() {
      stopWatching();
    },
    /**
     * Whether a page takes this path: a route that matches it below the root. A catch-all at the root (`app/routes/[...all].tsx`, a 404
     * page) doesn't count, or nothing could share the server with the app.
     */
    matches(path) {
      if (!loaded) return undefined;
      const found = matchRoutes(loaded.routes, path);
      return Boolean(found?.length && found.at(-1)!.pathnameBase !== "/");
    },
    /** Whether `fetch` answers a GET of this path with a file and no page code: the built assets under /_app, and files that are in public/. */
    async serves(path) {
      if (path.startsWith("/_app/")) return true;
      if (!/\.[^/]+$/.test(path)) return false;
      const file = inside(publicDir, path);
      return Boolean(file && (await isFile(file)));
    },
  };
}
