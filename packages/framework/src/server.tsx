import { ArchlastForgeClient, queryKey } from "@archlast-forge/client";
import { getFunctionName, isForgeError } from "@archlast-forge/runtime";
import type { AppEnv, AppHost } from "@archlast-forge/runtime/server";
import { dehydrate, QueryClient } from "@tanstack/react-query";
import { existsSync, statSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { preinit, preloadModule } from "react-dom";
import { renderToReadableStream } from "react-dom/server";
import { createStaticHandler, createStaticRouter, isRouteErrorResponse, RouterContextProvider, StaticRouterProvider, type StaticHandlerContext } from "react-router";
import { BuildError, buildApp, readBuild, type BuildResult } from "./build";
import { createViewerStore, forgeContext, type LoaderContext, type Viewer } from "./context";
import { buildErrorPage, DEV_SCRIPT, DevEvents, watchApp } from "./dev";
import { Providers } from "./providers";
import { toRouteObjects } from "./route-objects";
import { reviveErrors, type PageState, type SerializedError } from "./state";

export interface AppOptions {
  /** The project directory: it holds app/, public/ and forge/. */
  root: string;
  dev: boolean;
  /** Where build and error messages go. Defaults to the console. */
  log?: (level: "info" | "error", message: string) => void;
}

interface Loaded {
  build: BuildResult;
  handler: ReturnType<typeof createStaticHandler>;
  clientDir: string;
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

const isFile = (path: string) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

function fileResponse(path: string, req: Request, o: { cache: string; precompressed: boolean }): Response {
  const headers: Record<string, string> = { "cache-control": o.cache, "x-content-type-options": "nosniff" };
  const accepted = req.headers.get("accept-encoding") ?? "";
  if (o.precompressed) {
    headers.vary = "accept-encoding";
    for (const [encoding, ext] of [["br", "br"], ["gzip", "gz"]] as const) {
      if (new RegExp(`\\b${encoding}\\b`).test(accepted) && isFile(`${path}.${ext}`)) {
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

function Page(props: { router: ReturnType<typeof createStaticRouter>; context: StaticHandlerContext; client: ArchlastForgeClient; queryClient: QueryClient; viewer: ReturnType<typeof createViewerStore>; dev: boolean; css: string[]; preload: string[] }) {
  // Float hoists these into <head>, wherever the user's root document puts it.
  for (const href of props.css) preinit(`/_app/${href}`, { as: "style", precedence: "forge" });
  for (const file of props.preload) preloadModule(`/_app/${file}`, { as: "script" });
  return (
    <Providers client={props.client} queryClient={props.queryClient} viewer={props.viewer} dev={props.dev}>
      <StaticRouterProvider router={props.router} context={props.context} hydrate={false} />
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
    loaded = { build, handler: createStaticHandler(toRouteObjects(mod.manifest)), clientDir: join(build.dir, "client") };
  }

  async function rebuild(): Promise<boolean> {
    const began = performance.now();
    try {
      await load(await buildApp({ root, dev }));
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

  function asset(path: string, req: Request, env: AppEnv): Response | undefined {
    if (dev && path === "/_app/__dev.js") return new Response(DEV_SCRIPT, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" } });
    if (dev && path === "/_app/__events") {
      env.keepAlive();
      return events.response();
    }
    if (!loaded) return undefined;
    const file = inside(loaded.clientDir, path.slice("/_app".length));
    if (!file || !isFile(file)) return new Response("Not found", { status: 404 });
    return fileResponse(file, req, { cache: dev ? "no-cache" : "public, max-age=31536000, immutable", precompressed: !dev });
  }

  async function page(req: Request, env: AppEnv, url: URL): Promise<Response> {
    // While the build is broken the page says so, instead of showing the last build that worked.
    if (buildError) return buildErrorPage(buildError);
    if (!loaded) return new Response("The app isn't built yet", { status: 503 });
    const wait = await env.rateLimited();
    if (wait !== null) return new Response("Too many requests", { status: 429, headers: { "retry-after": String(wait), "content-type": "text/plain; charset=utf-8" } });

    const { handler, build } = loaded;
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
    // The page renders with the same errors the browser will be handed: what a visitor may see, and nothing else.
    const errors = serializeErrors(context.errors, { dev, requestId: env.requestId, log });
    context.errors = reviveErrors(errors);
    const viewer = createViewerStore(await ctx.viewer().catch(() => null));
    const state: PageState = {
      dev,
      viewer: viewer.get(),
      queries: dehydrate(queryClient),
      hydration: { loaderData: context.loaderData, actionData: context.actionData, errors },
    };
    const router = createStaticRouter(handler.dataRoutes, context);
    const preload = [...new Set(context.matches.flatMap((m) => build.manifest.routes[m.route.id] ?? []))].filter((f) => f !== build.manifest.entry);
    const client = new ArchlastForgeClient({ url: url.origin });
    const status = context.statusCode;

    try {
      const stream = await renderToReadableStream(
        <Page router={router} context={context} client={client} queryClient={queryClient} viewer={viewer} dev={dev} css={build.manifest.css} preload={preload} />,
        {
          bootstrapScriptContent: `window.__FORGE__=${scriptJson(state)};`,
          bootstrapModules: [`/_app/${build.manifest.entry}`, ...(dev ? ["/_app/__dev.js"] : [])],
          signal: req.signal,
          onError: (e) => log("error", `render failed (request ${env.requestId}): ${(e as Error)?.stack ?? e}`),
        },
      );
      await stream.allReady;
      return new Response(stream, { status, headers: { ...HTML_HEADERS, "x-request-id": env.requestId } });
    } catch (e) {
      log("error", `render failed (request ${env.requestId}): ${(e as Error)?.stack ?? e}`);
      return dev ? buildErrorPage(`A page failed to render:\n\n${(e as Error)?.stack ?? e}`) : new Response(`Server error (request ${env.requestId})`, { status: 500, headers: { "content-type": "text/plain; charset=utf-8" } });
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
        if (file && isFile(file)) return fileResponse(file, req, { cache: dev ? "no-cache" : "public, max-age=3600", precompressed: false });
      }
      return page(req, env, url);
    },
    dispose() {
      stopWatching();
    },
  };
}
