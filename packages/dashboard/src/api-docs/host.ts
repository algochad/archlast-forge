// The API docs page, for the engine to serve (`startServer({ apiDocs })`; the CLI passes this). It answers exactly the paths in contract.ts's
// DocsHost (the page, its assets below `<base>/_docs/`, and the explorer path) and returns null for everything else, so an app's own pages
// under the same prefix keep working.
//
// The page is React with MDX (the app's forge/docs pages and slots), bundled with Bun.build when it is first asked for: minified, split per
// page, hashed. The request builder ("Try it") is the engine's fork of Scalar, vendored (vendor/scalar/explorer.js.br), served beside the page
// and loaded by it only when someone opens it. What the page is told (its configuration, where the document and the builder are) is JSON in
// the HTML, which is made on every request, so a change of configuration needs no rebuild.
import { compile } from "@mdx-js/mdx";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { BootConfig } from "./boot";
import type { DocsHost, DocsPageConfig, DocsServeOptions } from "./contract";

type Asset = { bytes: Uint8Array<ArrayBuffer>; type: string };
type Built = { script: string; style: string; assets: Map<string, Asset> };

const HERE = import.meta.dir;
const VENDOR = join(HERE, "../../vendor/scalar");
const JSX_RUNTIME = Bun.resolveSync("react/jsx-runtime", HERE);
/** The docs site's fonts, Latin only: the page names them in its head, and they are fetched only when text uses them. */
const FONTS: Record<string, { file: string; family: string }> = {
  "geist.woff2": { file: join(Bun.resolveSync("@fontsource-variable/geist/package.json", HERE), "../files/geist-latin-wght-normal.woff2"), family: "Geist Variable" },
  "geist-mono.woff2": { file: join(Bun.resolveSync("@fontsource-variable/geist-mono/package.json", HERE), "../files/geist-mono-latin-wght-normal.woff2"), family: "Geist Mono Variable" },
};
const fontFaces = (base: string) =>
  Object.entries(FONTS)
    .map(([name, f]) => `@font-face{font-family:"${f.family}";font-style:normal;font-display:swap;font-weight:100 900;src:url(${base}/_docs/fonts/${name}) format("woff2-variations")}`)
    .join("");

const SLOTS = ["header", "sidebar-footer", "operation-before", "operation-after"] as const;

/** `---` front matter at the top of an MDX file: `key: value` lines (title, group, order), values optionally quoted. */
export function parseFrontMatter(source: string): { meta: Record<string, string>; body: string } {
  const m = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(source);
  if (!m) return { meta: {}, body: source };
  const meta: Record<string, string> = {};
  for (const line of m[1]!.split(/\r?\n/)) {
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*?)\s*$/.exec(line);
    if (!kv) continue;
    let value = kv[2]!;
    const quoted = /^(["'])(.*)\1/.exec(value);
    value = quoted ? quoted[2]! : value.replace(/\s+#.*$/, "");
    meta[kv[1]!] = value;
  }
  return { meta, body: source.slice(m[0].length) };
}

interface Guide {
  path: string;
  slug: string;
  title: string;
  group?: string;
  order?: number;
  text: string;
  stamp: string;
}

/** The text of a page without its markup, for the page's search. */
const textOf = (body: string) =>
  body
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[`*_#>|~{}]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 4000);

/** The app's pages: forge/docs/*.mdx, titled by their front matter (`title`), else their first heading, else the file name. */
function guidesOf(forgeDir: string): Guide[] {
  const dir = join(forgeDir, "docs");
  if (!existsSync(dir)) return [];
  const slugs = new Set<string>();
  return readdirSync(dir)
    .filter((f) => f.endsWith(".mdx") && !f.startsWith("_"))
    .sort()
    .map((f) => {
      const path = join(dir, f);
      const { meta, body } = parseFrontMatter(readFileSync(path, "utf8"));
      const order = meta.order !== undefined && meta.order !== "" && Number.isFinite(Number(meta.order)) ? Number(meta.order) : undefined;
      let slug = basename(f, ".mdx").replace(/^\d+[-_]/, "").replace(/[^A-Za-z0-9_-]+/g, "-") || "page";
      while (slugs.has(slug)) slug += "-";
      slugs.add(slug);
      const st = statSync(path);
      return {
        path,
        slug,
        title: meta.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || basename(f, ".mdx"),
        group: meta.group || undefined,
        order,
        text: textOf(body),
        stamp: `${st.mtimeMs}:${st.size}`,
      };
    });
}

/** forge/docs/_slots/<name>.mdx: pieces the page renders in fixed places. */
function slotsOf(forgeDir: string): { name: (typeof SLOTS)[number]; path: string; stamp: string }[] {
  return SLOTS.flatMap((name) => {
    const path = join(forgeDir, "docs", "_slots", `${name}.mdx`);
    if (!existsSync(path)) return [];
    const st = statSync(path);
    return [{ name, path, stamp: `${st.mtimeMs}:${st.size}` }];
  });
}

async function build(publicBase: string, guides: Guide[], slots: ReturnType<typeof slotsOf>): Promise<Built> {
  const result = await Bun.build({
    entrypoints: [join(HERE, "app.tsx")],
    target: "browser",
    minify: true,
    splitting: true,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    publicPath: `${publicBase}/_docs/assets/`,
    define: { "process.env.NODE_ENV": '"production"' },
    plugins: [
      {
        name: "api-docs-pages",
        setup(b) {
          b.onResolve({ filter: /^forge-docs:content$/ }, () => ({ path: "content", namespace: "forge-docs" }));
          b.onLoad({ filter: /.*/, namespace: "forge-docs" }, () => ({
            loader: "js",
            contents: `export default { guides: [${guides
              .map((g) => `{ slug: ${JSON.stringify(g.slug)}, title: ${JSON.stringify(g.title)}, group: ${JSON.stringify(g.group)}, order: ${JSON.stringify(g.order)}, text: ${JSON.stringify(g.text)}, load: () => import(${JSON.stringify(g.path)}) }`)
              .join(", ")}], slots: { ${slots.map((s) => `${JSON.stringify(s.name)}: () => import(${JSON.stringify(s.path)})`).join(", ")} } };`,
          }));
          // The app's MDX lives in forge/, where React may not be installed (a backend): its JSX runtime is the page's own.
          b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: JSX_RUNTIME }));
          b.onLoad({ filter: /\.mdx$/ }, async ({ path }) => ({ loader: "js", contents: String(await compile(parseFrontMatter(await Bun.file(path).text()).body, { jsxImportSource: "react" })) }));
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
  return { script, style, assets };
}

/** Builds by public base, pages and slots: a page added or edited in forge/docs builds the page again. Only the latest few are kept. */
const builds = new Map<string, Promise<Built>>();
const builtFor = (publicBase: string, forgeDir: string) => {
  const guides = guidesOf(forgeDir);
  const slots = slotsOf(forgeDir);
  const key = JSON.stringify([publicBase, forgeDir, guides.map((g) => [g.path, g.stamp]), slots.map((s) => [s.path, s.stamp])]);
  let b = builds.get(key);
  if (!b) {
    b = build(publicBase, guides, slots);
    builds.set(key, b);
    b.catch(() => builds.delete(key));
    for (const old of [...builds.keys()].slice(0, Math.max(0, builds.size - 4))) builds.delete(old);
  }
  return b;
};

// ---------------------------------------------------------------------------------------------------------------------------------
// The request builder, vendored: explorer.js and explorer.css, stored brotli-compressed (`.br`) or plain.

interface Vendored {
  bytes: Uint8Array<ArrayBuffer>;
  brotli: boolean;
  etag: string;
  plain?: Uint8Array<ArrayBuffer>;
}
const vendored = new Map<string, { stamp: string; file: Vendored | null }>();

function vendor(name: "explorer.js" | "explorer.css"): Vendored | null {
  for (const [file, brotli] of [[`${name}.br`, true], [name, false]] as const) {
    const path = join(VENDOR, file);
    if (!existsSync(path)) continue;
    const st = statSync(path);
    const stamp = `${st.mtimeMs}:${st.size}`;
    const known = vendored.get(name);
    if (known?.stamp === stamp) return known.file;
    const bytes = new Uint8Array(readFileSync(path));
    const entry = { bytes, brotli, etag: `W/"${createHash("sha1").update(bytes).digest("hex").slice(0, 16)}"` };
    vendored.set(name, { stamp, file: entry });
    return entry;
  }
  vendored.delete(name);
  return null;
}

const accepts = (req: Request, coding: "br" | "gzip") => new RegExp(`\\b${coding}\\b`).test(req.headers.get("accept-encoding") ?? "");

function send(req: Request, body: string | Uint8Array<ArrayBuffer>, type: string, cache: string): Response {
  const headers = { "content-type": type, "cache-control": cache, vary: "accept-encoding", "x-content-type-options": "nosniff" };
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  // Made on every request: a lower brotli quality than the default, which is for files compressed once.
  if (accepts(req, "br")) return new Response(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), { headers: { ...headers, "content-encoding": "br" } });
  if (accepts(req, "gzip")) return new Response(Bun.gzipSync(bytes), { headers: { ...headers, "content-encoding": "gzip" } });
  return new Response(bytes, { headers });
}

function sendVendored(req: Request, file: Vendored, type: string, cache: string): Response {
  const headers: Record<string, string> = { "content-type": type, "cache-control": cache, vary: "accept-encoding", "x-content-type-options": "nosniff", etag: file.etag };
  if (req.headers.get("if-none-match") === file.etag) return new Response(null, { status: 304, headers });
  if (file.brotli) {
    if (accepts(req, "br")) return new Response(file.bytes, { headers: { ...headers, "content-encoding": "br" } });
    file.plain ??= new Uint8Array(brotliDecompressSync(file.bytes));
    return new Response(file.plain, { headers });
  }
  if (accepts(req, "br")) return new Response(brotliCompressSync(file.bytes), { headers: { ...headers, "content-encoding": "br" } });
  return new Response(file.bytes, { headers });
}

/** Compressed copies of assets, so each is compressed once per encoding, not on every request. */
const packed = new WeakMap<Asset, Map<string, Uint8Array<ArrayBuffer>>>();
function sendAsset(req: Request, asset: Asset): Response {
  const encoding = accepts(req, "br") ? "br" : accepts(req, "gzip") ? "gzip" : "";
  const headers: Record<string, string> = { "content-type": asset.type, "cache-control": "public, max-age=31536000, immutable", vary: "accept-encoding", "x-content-type-options": "nosniff" };
  if (!encoding) return new Response(asset.bytes, { headers });
  let copies = packed.get(asset);
  if (!copies) packed.set(asset, (copies = new Map()));
  let bytes = copies.get(encoding);
  if (!bytes) copies.set(encoding, (bytes = encoding === "br" ? new Uint8Array(brotliCompressSync(asset.bytes)) : Bun.gzipSync(asset.bytes)));
  return new Response(bytes, { headers: { ...headers, "content-encoding": encoding } });
}

// ---------------------------------------------------------------------------------------------------------------------------------
// The page's HTML.

const escapeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
/** JSON that can sit inside a <script> element: nothing in it can close the tag or start a comment. */
const jsonForScript = (v: unknown) => JSON.stringify(v).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

function pageHtml(built: Built, boot: BootConfig): string {
  const base = escapeAttr(boot.publicBase);
  const dark = boot.page.theme?.mode === "dark";
  const light = boot.page.theme?.mode === "light";
  // In the page's layer too, so that nothing here is an unlayered rule the request builder's layered styles would lose to.
  const backdrop = `@layer forge-docs{html,body{margin:0}body{background:${dark ? "#0c0c0d" : "#f6f4ef"}}${dark || light ? "" : "@media (prefers-color-scheme:dark){body{background:#0c0c0d}}"}}`;
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="${dark ? "dark" : light ? "light" : "light dark"}"><title>${escapeAttr(boot.page.title ?? "API reference")}</title>` +
    `<style>${fontFaces(boot.publicBase)}${backdrop}</style>` +
    (built.style ? `<link rel="stylesheet" href="${base}/_docs/assets/${built.style}">` : "") +
    `<link rel="preload" href="${escapeAttr(boot.openapiUrl)}" as="fetch" crossorigin>` +
    `<script type="application/json" id="forge-docs-config">${jsonForScript(boot)}</script></head>` +
    `<body><div id="root"></div><noscript>This page needs JavaScript. The API description is at <a href="${escapeAttr(boot.openapiUrl)}">${escapeAttr(boot.openapiUrl)}</a>.</noscript>` +
    `<script type="module" src="${base}/_docs/assets/${built.script}"></script></body></html>`
  );
}

function explorerUrlOf(options: Pick<DocsServeOptions, "publicBase" | "explorerPath" | "page">): string | null {
  if (options.explorerPath === null || options.page.explorer === false) return null;
  const js = vendor("explorer.js");
  const css = vendor("explorer.css");
  // The script loads its stylesheet from the address beside its own, query kept, so one version covers both files.
  const version = js ? createHash("sha1").update(js.etag).update(css?.etag ?? "").digest("hex").slice(0, 12) : "";
  return `${options.publicBase}/_docs/explorer.js${version ? `?v=${version}` : ""}`;
}

const MIME: Record<string, string> = { js: "text/javascript; charset=utf-8", css: "text/css; charset=utf-8" };

export const apiDocs: DocsHost & { firstLoadBytes(publicBase: string, forgeDir: string): Promise<{ raw: number; gzip: number }> } = {
  async serve(req, options) {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const path = new URL(req.url).pathname;
    const { base, explorerPath } = options;
    if (path === base || path === `${base}/` || (explorerPath !== null && path === explorerPath)) {
      const built = await builtFor(options.publicBase, options.forgeDir);
      const boot: BootConfig = {
        publicBase: options.publicBase,
        openapiUrl: options.openapiUrl,
        explorerUrl: explorerUrlOf(options),
        tryOpen: explorerPath !== null && path === explorerPath,
        dev: options.dev,
        page: options.page,
      };
      return send(req, pageHtml(built, boot), "text/html; charset=utf-8", "no-cache");
    }
    const prefix = `${base}/_docs/`;
    if (!path.startsWith(prefix)) return null;
    const rest = path.slice(prefix.length);
    if (rest.startsWith("assets/")) {
      const asset = (await builtFor(options.publicBase, options.forgeDir)).assets.get(rest.slice("assets/".length));
      return asset ? sendAsset(req, asset) : null;
    }
    if (rest.startsWith("fonts/") && Object.hasOwn(FONTS, rest.slice("fonts/".length)))
      return new Response(Bun.file(FONTS[rest.slice("fonts/".length)]!.file), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
    if (explorerPath !== null && (rest === "explorer.js" || rest === "explorer.css")) {
      const file = vendor(rest);
      // With the content's hash in the address the file never changes under it; without, it is checked again each time.
      return file ? sendVendored(req, file, MIME[rest.slice(rest.lastIndexOf(".") + 1)]!, new URL(req.url).searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache") : null;
    }
    return null;
  },
  paths({ base, explorerPath }) {
    return { exact: [base, `${base}/`, ...(explorerPath !== null ? [explorerPath] : [])], prefixes: [`${base}/_docs/`] };
  },
  /** The page's first load, gzipped, for the size budget: the HTML, the entry script, the stylesheet and the chunks the entry imports at once (not the explorer, or any app page). */
  async firstLoadBytes(publicBase, forgeDir) {
    const built = await builtFor(publicBase, forgeDir);
    const html = pageHtml(built, { publicBase, openapiUrl: `${publicBase}/openapi.json`, explorerUrl: `${publicBase}/_docs/explorer.js`, tryOpen: false, dev: false, page: {} satisfies DocsPageConfig });
    // Chunks the entry imports statically load with it, and the ones those import.
    const loaded = new Set([built.script, built.style].filter(Boolean));
    for (const name of loaded) {
      const asset = built.assets.get(name)!;
      if (!name.endsWith(".js")) continue;
      for (const m of new TextDecoder().decode(asset.bytes).matchAll(/from"\.\/(chunk-[^"]+\.js)"/g)) loaded.add(m[1]!);
    }
    const parts = [new TextEncoder().encode(html), ...[...loaded].map((n) => built.assets.get(n)!.bytes)];
    return { raw: parts.reduce((n, p) => n + p.length, 0), gzip: parts.reduce((n, p) => n + Bun.gzipSync(p).length, 0) };
  },
};

export default apiDocs;
