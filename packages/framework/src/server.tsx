import { ArchlastForgeClient, queryKey } from "@archlast/forge-client";
import { getFunctionName, isForgeError } from "@archlast/forge-runtime";
import type { AppEnv, AppHost } from "@archlast/forge-runtime/server";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { stat } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { preinit, preloadModule } from "react-dom";
import { renderToReadableStream } from "react-dom/server";
import { createStaticHandler, createStaticRouter, isRouteErrorResponse, matchRoutes, RouterContextProvider, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { BuildError, buildApp, readBuild, type BuildManifest, type BuildResult } from "./build";
import { createViewerStore, forgeContext, type LoaderContext, type Viewer } from "./context";
import { buildErrorPage, DEV_SCRIPT, DevEvents, watchApp } from "./dev";
import { IslandsContext, type IslandCount } from "./island";
import { Providers } from "./providers";
import { toRouteObjects } from "./route-objects";
import { reviveErrors, type PageState, type SerializedError } from "./state";
import { DEFAULT_ZONE, zoneFromCookie, type TimeState } from "./time";

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
}

const HTML_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "private, no-cache",
  vary: "cookie",
  "x-content-type-options": "nosniff",
  "referrer-policy": "strict-origin-when-cross-origin",
};

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
  if (o.meter.count === 0) return insertBefore(html, "</body>", module(o.islands.nav) + dev);
  const preloads = o.islands.preload.map((f) => `<link rel="modulepreload" href="/_app/${escapeAttr(f)}"${nonce}/>`).join("");
  // The state is data, not a script: it needs no nonce, and a page that is swapped in carries it as a loaded one does.
  const state = `<script type="application/json" id="forge-state">${scriptJson(o.state)}</script>`;
  return insertBefore(insertBefore(html, "</head>", preloads), "</body>", state + module(o.islands.entry) + module(o.islands.nav) + dev);
}

/** `html` with `text` before the last `marker`, or at the end when there is none. */
function insertBefore(html: string, marker: string, text: string): string {
  if (!text) return html;
  const at = html.lastIndexOf(marker);
  return at < 0 ? html + text : html.slice(0, at) + text + html.slice(at);
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
  const root = resolve(opts.root);
  const log = opts.log ?? ((level, message) => (level === "error" ? console.error(message) : console.log(message)));
  const publicDir = join(root, "public");
  const events = new DevEvents();
  let loaded: Loaded | undefined;
  let buildError: string | undefined;

  async function load(build: BuildResult) {
    const mod = (await import(join(build.dir, build.manifest.server))) as { manifest: Parameters<typeof toRouteObjects>[0] };
    const routes = toRouteObjects(mod.manifest);
    loaded = { build, routes, handler: createStaticHandler(routes), clientDir: join(build.dir, "client"), authPlugins: mod.manifest.module?.authPlugins };
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
    const router = createStaticRouter(handler.dataRoutes, context);
    const preload = withIslands ? [] : [...new Set(context.matches.flatMap((m) => build.manifest.routes[m.route.id] ?? []))].filter((f) => f !== build.manifest.entry);
    const client = new ArchlastForgeClient({ url: url.origin, authPlugins });
    const status = context.statusCode;
    const meter: IslandCount | null = withIslands ? { count: 0 } : null;

    try {
      const stream = await renderToReadableStream(
        <Page islands={meter} router={router} context={context} client={client} queryClient={queryClient} viewer={viewer} time={time} dev={dev} css={build.manifest.css} preload={preload} nonce={env.nonce} />,
        {
          // React's own inline scripts (the page's state, streamed boundaries) carry the engine's CSP nonce.
          ...(env.nonce && { nonce: env.nonce }),
          // With islands, the scripts are added below, and only if the page has an island.
          ...(!withIslands && { bootstrapScriptContent: `window.__FORGE__=${scriptJson(state)};`, bootstrapModules: [`/_app/${build.manifest.entry}`, ...(dev ? ["/_app/__dev.js"] : [])] }),
          signal: req.signal,
          onError: (e) => log("error", `render failed (request ${env.requestId}): ${(e as Error)?.stack ?? e}`),
        },
      );
      await stream.allReady;
      if (!meter) return new Response(stream, { status, headers: { ...HTML_HEADERS, "x-request-id": env.requestId } });
      return new Response(withScripts(await new Response(stream).text(), { islands: islands!, meter, state, nonce: env.nonce, dev }), { status, headers: { ...HTML_HEADERS, "x-forge-page": "islands", "x-request-id": env.requestId } });
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
