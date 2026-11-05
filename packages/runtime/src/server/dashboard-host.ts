// The dashboard's page and its files. Bun can serve an HTML import itself (`routes`), but then the engine can't set headers on what it
// sends, and the dashboard needs strict ones (security-headers.ts). So the engine builds the same HTML import with Bun.build, once, the
// first time it is asked for, and serves the page at /_dashboard and its hashed files below /_dashboard/_assets/.
import { brotliCompressSync, constants } from "node:zlib";

type Asset = { bytes: Uint8Array<ArrayBuffer>; type: string; br?: Uint8Array<ArrayBuffer>; gzip?: Uint8Array<ArrayBuffer> };

const ASSETS = "/_dashboard/_assets/";

export function dashboardHost(bundle: { index: string }) {
  let built: Promise<{ html: string; assets: Map<string, Asset> }> | undefined;
  const build = () =>
    (built ??= (async () => {
      // Production mode everywhere, dev included: React's production build, minified (the engine image has only that build of React).
      const result = await Bun.build({
        entrypoints: [bundle.index],
        target: "browser",
        minify: true,
        splitting: true,
        publicPath: ASSETS,
        naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
        define: { "process.env.NODE_ENV": '"production"' },
      });
      if (!result.success) throw new AggregateError(result.logs, "The dashboard didn't build");
      let html = "";
      const assets = new Map<string, Asset>();
      for (const out of result.outputs) {
        const name = out.path.replace(/^.*\//, "");
        if (name.endsWith(".html")) html = await out.text();
        else assets.set(name, { bytes: new Uint8Array(await out.arrayBuffer()), type: out.type });
      }
      return { html, assets };
    })().catch((e) => {
      built = undefined; // the next request tries again
      throw e;
    }));

  const encoded = (req: Request, a: Asset, cache: string) => {
    const accepts = req.headers.get("accept-encoding") ?? "";
    const headers: Record<string, string> = { "content-type": a.type, "cache-control": cache, vary: "accept-encoding" };
    if (/\bbr\b/.test(accepts)) return new Response((a.br ??= new Uint8Array(brotliCompressSync(a.bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 9 } }))), { headers: { ...headers, "content-encoding": "br" } });
    if (/\bgzip\b/.test(accepts)) return new Response((a.gzip ??= Bun.gzipSync(a.bytes)), { headers: { ...headers, "content-encoding": "gzip" } });
    return new Response(a.bytes, { headers });
  };

  return {
    /** The page or one of its files; null for any other path under /_dashboard. */
    async serve(req: Request, path: string): Promise<Response | null> {
      if (req.method !== "GET" && req.method !== "HEAD") return null;
      if (path === "/_dashboard" || path === "/_dashboard/") {
        const { html } = await build();
        return new Response(html, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      }
      if (!path.startsWith(ASSETS)) return null;
      const asset = (await build()).assets.get(path.slice(ASSETS.length));
      return asset ? encoded(req, asset, "public, max-age=31536000, immutable") : null;
    },
    /** Builds it now, so the first visitor doesn't wait. */
    warm() {
      void build().catch(() => {});
    },
  };
}
