// The API docs page and the explorer, for the engine to serve below API_DOCS_PATH (`startServer({ apiDocs })`; the CLI passes this).
// The page is React with MDX pages (the guide, and forge/docs/*.mdx of the app), bundled with Bun.build when it is first asked for: minified,
// split per page, hashed. The explorer is Scalar's standalone bundle, vendored (vendor/scalar, `bun scripts/update-scalar.ts`), on a page of
// its own so it never weighs on the docs page.
import { compile } from "@mdx-js/mdx";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

type Asset = { bytes: Uint8Array<ArrayBuffer>; type: string };
type Built = { html: string; assets: Map<string, Asset> };

const HERE = import.meta.dir;
const SCALAR = join(HERE, "../../vendor/scalar/standalone.js.br");
const JSX_RUNTIME = Bun.resolveSync("react/jsx-runtime", HERE);
/** The docs site's fonts, Latin only: the page names them in its head, and they are fetched only when text uses them. */
const FONTS: Record<string, { file: string; family: string }> = {
  "geist.woff2": { file: join(Bun.resolveSync("@fontsource-variable/geist/package.json", HERE), "../files/geist-latin-wght-normal.woff2"), family: "Geist Variable" },
  "geist-mono.woff2": { file: join(Bun.resolveSync("@fontsource-variable/geist-mono/package.json", HERE), "../files/geist-mono-latin-wght-normal.woff2"), family: "Geist Mono Variable" },
};
const fontFaces = (base: string) =>
  Object.entries(FONTS)
    .map(([name, f]) => `@font-face{font-family:"${f.family}";font-style:normal;font-display:swap;font-weight:100 900;src:url(${base}/fonts/${name}) format("woff2-variations")}`)
    .join("");

/** The app's pages: forge/docs/*.mdx, ordered by file name, titled by their first heading. */
function appPages(forgeDir: string) {
  const dir = join(forgeDir, "docs");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mdx"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const title = /^#\s+(.+)$/m.exec(readFileSync(path, "utf8"))?.[1]?.trim() ?? basename(f, ".mdx");
      return { path, slug: basename(f, ".mdx").replace(/[^A-Za-z0-9_-]+/g, "-"), title, mtime: statSync(path).mtimeMs };
    });
}

async function build(base: string, forgeDir: string): Promise<Built> {
  const pages = appPages(forgeDir);
  const result = await Bun.build({
    entrypoints: [join(HERE, "app.tsx")],
    target: "browser",
    minify: true,
    splitting: true,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    publicPath: `${base}/assets/`,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "api-docs-pages",
        setup(b) {
          b.onResolve({ filter: /^forge-docs:pages$/ }, () => ({ path: "pages", namespace: "forge-docs" }));
          b.onLoad({ filter: /.*/, namespace: "forge-docs" }, () => ({
            loader: "js",
            contents: `export default [${pages.map((p) => `{ slug: ${JSON.stringify(p.slug)}, title: ${JSON.stringify(p.title)}, load: () => import(${JSON.stringify(p.path)}) }`).join(", ")}];`,
          }));
          // The app's MDX lives in forge/, where React may not be installed (a backend): its JSX runtime is the page's own.
          b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: JSX_RUNTIME }));
          b.onLoad({ filter: /\.mdx$/ }, async ({ path }) => ({ loader: "js", contents: String(await compile(await Bun.file(path).text(), { jsxImportSource: "react" })) }));
        },
      },
    ],
  });
  if (!result.success) throw new AggregateError(result.logs, "The API docs page didn't build");
  const assets = new Map<string, Asset>();
  let script = "";
  let style = "";
  for (const out of result.outputs) {
    const name = basename(out.path);
    assets.set(name, { bytes: new Uint8Array(await out.arrayBuffer()), type: out.type });
    if (out.kind === "entry-point") script = name;
    else if (name.endsWith(".css") && !style) style = name;
  }
  const html = `<!doctype html><html lang="en" data-base="${base}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>API</title><style>${fontFaces(base)}</style>${style ? `<link rel="stylesheet" href="${base}/assets/${style}">` : ""}</head><body><div id="root"></div><script type="module" src="${base}/assets/${script}"></script></body></html>`;
  return { html, assets };
}

/** Builds by base and pages: a page added or edited in forge/docs builds the page again. */
const builds = new Map<string, Promise<Built>>();
const builtFor = (base: string, forgeDir: string) => {
  const key = `${base}\u0000${forgeDir}\u0000${JSON.stringify(appPages(forgeDir).map((p) => [p.path, p.mtime]))}`;
  let b = builds.get(key);
  if (!b) {
    builds.clear();
    builds.set(key, (b = build(base, forgeDir)));
    b.catch(() => builds.delete(key));
  }
  return b;
};

const explorerHtml = (base: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>API explorer</title></head><body><div id="app"></div><script src="${base}/scalar.js"></script><script src="${base}/explorer.js"></script></body></html>`;
// In its own file, so the page needs no inline script. Nothing leaves the server: no hosted toolbar (share, SDKs), no Ask AI, no telemetry, no web fonts.
const explorerScript = (base: string) =>
  `Scalar.createApiReference("#app", ${JSON.stringify({ url: `${base}/openapi.json`, withDefaultFonts: false, showDeveloperTools: "never", agent: { disabled: true }, telemetry: false, theme: "default", customCss: ":root{--scalar-font:system-ui,sans-serif}" })});`;

let scalarPlain: Uint8Array<ArrayBuffer> | undefined;

function send(req: Request, body: string | Uint8Array<ArrayBuffer>, type: string, cache: string, alreadyBrotli = false): Response {
  const accepts = req.headers.get("accept-encoding") ?? "";
  const headers = { "content-type": type, "cache-control": cache, vary: "accept-encoding", "x-content-type-options": "nosniff" };
  if (alreadyBrotli) {
    if (/\bbr\b/.test(accepts)) return new Response(body, { headers: { ...headers, "content-encoding": "br" } });
    scalarPlain ??= new Uint8Array(brotliDecompressSync(body as Uint8Array));
    body = scalarPlain;
  }
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  if (/\bbr\b/.test(accepts)) return new Response(brotliCompressSync(bytes), { headers: { ...headers, "content-encoding": "br" } });
  if (/\bgzip\b/.test(accepts)) return new Response(Bun.gzipSync(bytes), { headers: { ...headers, "content-encoding": "gzip" } });
  return new Response(bytes, { headers });
}

/** Compressed copies of assets, so each is compressed once per encoding, not on every request. */
const packed = new WeakMap<Asset, Map<string, Uint8Array<ArrayBuffer>>>();
function sendAsset(req: Request, asset: Asset): Response {
  const accepts = req.headers.get("accept-encoding") ?? "";
  const encoding = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gzip" : "";
  const headers: Record<string, string> = { "content-type": asset.type, "cache-control": "public, max-age=31536000, immutable", vary: "accept-encoding" };
  if (!encoding) return new Response(asset.bytes, { headers });
  let copies = packed.get(asset);
  if (!copies) packed.set(asset, (copies = new Map()));
  let bytes = copies.get(encoding);
  if (!bytes) copies.set(encoding, (bytes = encoding === "br" ? new Uint8Array(brotliCompressSync(asset.bytes)) : Bun.gzipSync(asset.bytes)));
  return new Response(bytes, { headers: { ...headers, "content-encoding": encoding } });
}

export const apiDocs = {
  async serve(req: Request, { base, forgeDir }: { base: string; forgeDir: string; dev: boolean }): Promise<Response | null> {
    const path = new URL(req.url).pathname;
    const rest = path.slice(base.length);
    if (rest === "" || rest === "/") return send(req, (await builtFor(base, forgeDir)).html, "text/html; charset=utf-8", "no-cache");
    if (rest.startsWith("/assets/")) {
      const asset = (await builtFor(base, forgeDir)).assets.get(rest.slice("/assets/".length));
      return asset ? sendAsset(req, asset) : null;
    }
    if (rest.startsWith("/fonts/") && FONTS[rest.slice("/fonts/".length)])
      return new Response(Bun.file(FONTS[rest.slice("/fonts/".length)]!.file), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
    if (rest === "/explorer") return send(req, explorerHtml(base), "text/html; charset=utf-8", "no-cache");
    if (rest === "/explorer.js") return send(req, explorerScript(base), "text/javascript; charset=utf-8", "no-cache");
    if (rest === "/scalar.js") return send(req, new Uint8Array(await Bun.file(SCALAR).arrayBuffer()), "text/javascript; charset=utf-8", "public, max-age=86400", true);
    return null;
  },
  /** The page's first load, gzipped, for the size budget: the HTML, the entry script and the stylesheet (not the explorer, or any app page). */
  async firstLoadBytes(base: string, forgeDir: string) {
    const built = await builtFor(base, forgeDir);
    const linked = [...built.html.matchAll(/assets\/([^"]+)/g)].map((m) => m[1]!);
    const entry = built.assets.get(linked.find((n) => n.endsWith(".js"))!)!;
    // Chunks the entry imports statically load with it.
    const chunks = [...new TextDecoder().decode(entry.bytes).matchAll(/from"\.\/(chunk-[^"]+\.js)"/g)].map((m) => m[1]!);
    const parts = [new TextEncoder().encode(built.html), ...[...new Set([...linked, ...chunks])].map((n) => built.assets.get(n)!.bytes)];
    return { raw: parts.reduce((n, p) => n + p.length, 0), gzip: parts.reduce((n, p) => n + Bun.gzipSync(p).length, 0) };
  },
};

export default apiDocs;
