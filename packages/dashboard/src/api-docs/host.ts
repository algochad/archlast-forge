// The API docs page, for the engine to serve (`startServer({ apiDocs })`; the CLI passes this). It answers exactly the paths in contract.ts's
// DocsHost (the pages, their Markdown, llms.txt, assets below `<base>/_docs/`, and the explorer path) and returns null for everything else, so an
// app's own pages under the same prefix keep working.
//
// The page is React with MDX (the app's forge/docs pages, slots and components), bundled with Bun.build when it is first asked for: once for the
// browser (minified, split per page, hashed) and once for Bun, to render each page on the server. A page or component that doesn't compile is
// replaced by an error panel in development (and left out in production), with its file and line logged, so it never takes the page down.
// The request builder ("Try it") is the engine's fork of Scalar, vendored (vendor/scalar/explorer.js.br), served beside the page and loaded by it
// only when someone opens it. What the page is told (its configuration, where the document and the builder are) is JSON in the HTML.
import { compile } from "@mdx-js/mdx";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, relative } from "node:path";
import { brotliCompressSync, brotliDecompressSync, constants } from "node:zlib";
import type { BootConfig } from "./boot";
import type { DocsHost, DocsPageConfig, DocsServeOptions } from "./contract";
import { llmsTxt, pageMarkdown, type MarkdownInput } from "./export";
import { arrange, type OpenApi } from "./openapi";
import { buildSite, type Site } from "./site";
import { makeTranslate } from "./strings";

type Asset = { bytes: Uint8Array<ArrayBuffer>; type: string };
type Built = { script: string; style: string; assets: Map<string, Asset>; render: ((input: { boot: BootConfig; document: OpenApi }) => Promise<string>) | null };

const HERE = import.meta.dir;
const VENDOR = join(HERE, "../../vendor/scalar");
const JSX_RUNTIME = Bun.resolveSync("react/jsx-runtime", HERE);
const REACT = Bun.resolveSync("react", HERE);
const COMPONENTS = join(HERE, "components.tsx");
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
const COMPONENT_FILE = /\.(tsx|jsx|ts|js)$/;

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

interface GuideFile {
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

const stampOf = (path: string) => {
  const st = statSync(path);
  return `${st.mtimeMs}:${st.size}`;
};

/** The app's pages: forge/docs/*.mdx, titled by their front matter (`title`), else their first heading, else the file name. */
function guidesOf(forgeDir: string): GuideFile[] {
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
      return {
        path,
        slug,
        title: meta.title || /^#\s+(.+)$/m.exec(body)?.[1]?.trim() || basename(f, ".mdx"),
        group: meta.group || undefined,
        order,
        text: textOf(body),
        stamp: stampOf(path),
      };
    });
}

/** forge/docs/_slots/<name>.mdx: pieces the page renders in fixed places. */
function slotsOf(forgeDir: string): { name: (typeof SLOTS)[number]; path: string; stamp: string }[] {
  return SLOTS.flatMap((name) => {
    const path = join(forgeDir, "docs", "_slots", `${name}.mdx`);
    return existsSync(path) ? [{ name, path, stamp: stampOf(path) }] : [];
  });
}

/** forge/docs/_components/*.tsx: the app's own MDX components, by file (its default export) and by name (its capitalised named exports). */
function componentsOf(forgeDir: string): { name: string; path: string; stamp: string }[] {
  const dir = join(forgeDir, "docs", "_components");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => COMPONENT_FILE.test(f) && !f.endsWith(".d.ts") && !f.startsWith("_"))
    .sort()
    .map((f) => ({ name: basename(f).replace(COMPONENT_FILE, "").replace(/(^|[-_])(\w)/g, (_, __, c: string) => c.toUpperCase()), path: join(dir, f), stamp: stampOf(join(dir, f)) }));
}

/** Copies a fenced block's meta (```ts title="server.ts") onto its <code>, where the page's code block reads the title. */
const codeMeta = () => (tree: { type: string; meta?: string; data?: Record<string, unknown>; children?: unknown[] }) => {
  const visit = (n: typeof tree) => {
    if (n.type === "code" && n.meta) n.data = { ...n.data, hProperties: { ...(n.data?.hProperties as object), "data-meta": n.meta } };
    for (const c of (n.children ?? []) as (typeof tree)[]) visit(c);
  };
  visit(tree);
};

/** Where an error is, as `file:line:column` relative to the project (forge/docs/…). */
const placeOf = (forgeDir: string, path: string, line?: number, column?: number) => `${relative(join(forgeDir, ".."), path)}${line ? `:${line}${column ? `:${column}` : ""}` : ""}`;

/** A module that shows (in development) what went wrong with an app's file instead of it. */
const brokenModule = (file: string, message: string, dev: boolean) =>
  `import { jsx } from "react/jsx-runtime";\nimport { ContentError } from ${JSON.stringify(COMPONENTS)};\nexport default function Broken() { return jsx(ContentError, { file: ${JSON.stringify(file)}, message: ${JSON.stringify(message)}, dev: ${dev} }); }\n`;

interface Content {
  guides: GuideFile[];
  slots: ReturnType<typeof slotsOf>;
  components: ReturnType<typeof componentsOf>;
}

/** The content module for one build: lazy imports for the browser, plain ones for the server. */
function contentModule(c: Content, server: boolean, broken: Set<string>): string {
  const imports: string[] = [];
  const load = (path: string, i: string) => (server ? (imports.push(`import ${i} from ${JSON.stringify(path)};`), i) : `() => import(${JSON.stringify(path)})`);
  const functionsGuide = join(HERE, "guide.mdx");
  const guides = c.guides.map(
    (g, i) =>
      `{ slug: ${JSON.stringify(g.slug)}, title: ${JSON.stringify(g.title)}, group: ${JSON.stringify(g.group)}, order: ${JSON.stringify(g.order)}, text: ${JSON.stringify(g.text)}, file: ${JSON.stringify(`forge/docs/${basename(g.path)}`)}, ${server ? "content" : "load"}: ${load(g.path, `G${i}`)} }`,
  );
  const slots = c.slots.map((s, i) => `${JSON.stringify(s.name)}: ${server ? load(s.path, `S${i}`) : `() => import(${JSON.stringify(s.path)})`}`);
  const components = c.components.filter((x) => !broken.has(x.path));
  components.forEach((x, i) => imports.push(`import * as C${i} from ${JSON.stringify(x.path)};`));
  const functions = `{ slug: "functions", title: "", text: "Call the engine's functions over HTTP at /rpc/<module>:<name> and keep a query live over the WebSocket at /rpc.", ${server ? "content" : "load"}: ${load(functionsGuide, "F")} }`;
  return (
    `${imports.join("\n")}\n` +
    `const own = (m, name) => { const out = {}; if (typeof m.default === "function") out[name] = m.default; for (const [k, v] of Object.entries(m)) if (k !== "default" && /^[A-Z]/.test(k) && typeof v === "function") out[k] = v; return out; };\n` +
    `export default { guides: [${guides.join(", ")}], slots: { ${slots.join(", ")} }, components: Object.assign({}, ${components.map((x, i) => `own(C${i}, ${JSON.stringify(x.name)})`).join(", ") || "{}"}), functionsGuide: ${functions} };\n`
  );
}

async function bundle(c: Content, publicBase: string, forgeDir: string, dev: boolean, server: boolean, broken: Set<string>) {
  return Bun.build({
    entrypoints: [join(HERE, server ? "ssr.tsx" : "app.tsx")],
    target: server ? "bun" : "browser",
    minify: !server,
    splitting: !server,
    naming: { entry: "[name]-[hash].[ext]", chunk: "chunk-[hash].[ext]", asset: "[name]-[hash].[ext]" },
    publicPath: `${publicBase}/_docs/assets/`,
    define: { "process.env.NODE_ENV": '"production"' },
    throw: false,
    plugins: [
      {
        name: "api-docs-pages",
        setup(b) {
          b.onResolve({ filter: /^forge-docs:content$/ }, () => ({ path: "content", namespace: "forge-docs" }));
          b.onLoad({ filter: /.*/, namespace: "forge-docs" }, () => ({ loader: "js", contents: contentModule(c, server, broken), resolveDir: HERE }));
          // The app's MDX and components live in forge/, where React may not be installed (a backend): theirs is the page's own copy.
          b.onResolve({ filter: /^react\/jsx-runtime$/ }, () => ({ path: JSX_RUNTIME }));
          b.onResolve({ filter: /^react$/ }, () => ({ path: REACT }));
          b.onLoad({ filter: /\.mdx$/ }, async ({ path }) => {
            const file = placeOf(forgeDir, path);
            try {
              const source = parseFrontMatter(await Bun.file(path).text()).body;
              return { loader: "js", contents: String(await compile(source, { jsxImportSource: "react", remarkPlugins: [codeMeta as never] })), resolveDir: join(path, "..") };
            } catch (e) {
              const err = e as { line?: number; column?: number; place?: { line?: number; column?: number; start?: { line?: number; column?: number } }; reason?: string; message?: string };
              const line = err.line ?? err.place?.line ?? err.place?.start?.line;
              const column = err.column ?? err.place?.column ?? err.place?.start?.column;
              const where = placeOf(forgeDir, path, line, column);
              const message = err.reason ?? err.message ?? String(e);
              if (!server) console.error(`✗ the API docs page: ${where}: ${message}`);
              return { loader: "js", contents: brokenModule(file, `${where}: ${message}`, dev), resolveDir: HERE };
            }
          });
        },
      },
    ],
  });
}

/** Files of the app's that made a build fail: what its log names under forge/. */
const culprits = (logs: { position?: { file?: string } | null }[], c: Content) => {
  const own = new Set([...c.guides.map((g) => g.path), ...c.slots.map((s) => s.path), ...c.components.map((x) => x.path)]);
  return [...new Set(logs.map((l) => l.position?.file).filter((f): f is string => !!f && own.has(f)))];
};

async function build(publicBase: string, forgeDir: string, dev: boolean, c: Content): Promise<Built> {
  // A file of the app's that doesn't build is set aside (and said so) and the page built without it.
  const broken = new Set<string>();
  let client = await bundle(c, publicBase, forgeDir, dev, false, broken);
  for (let i = 0; !client.success && i < 5; i++) {
    const bad = culprits(client.logs, c);
    if (!bad.length) break;
    for (const f of bad) {
      broken.add(f);
      console.error(`✗ the API docs page: ${placeOf(forgeDir, f)} didn't build, so the page is built without it: ${client.logs.find((l) => l.position?.file === f)?.message ?? ""}`);
    }
    c = {
      guides: c.guides.filter((g) => !broken.has(g.path)),
      slots: c.slots.filter((s) => !broken.has(s.path)),
      components: c.components,
    };
    client = await bundle(c, publicBase, forgeDir, dev, false, broken);
  }
  if (!client.success) throw new AggregateError(client.logs, "The API docs page didn't build");
  const assets = new Map<string, Asset>();
  let script = "";
  let style = "";
  for (const out of client.outputs) {
    const name = basename(out.path);
    assets.set(name, { bytes: new Uint8Array(await out.arrayBuffer()), type: out.type });
    if (out.kind === "entry-point") script = name;
    else if (name.endsWith(".css") && !style) style = name;
  }
  // The server's copy: written where Bun can import it. Without it the page renders in the browser only, as before.
  let render: Built["render"] = null;
  try {
    const ssr = await bundle(c, publicBase, forgeDir, dev, true, broken);
    if (!ssr.success) throw new AggregateError(ssr.logs, "the server build failed");
    const code = await ssr.outputs.find((o) => o.kind === "entry-point")!.text();
    const dir = join(tmpdir(), "archlast-forge-docs");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `ssr-${createHash("sha1").update(code).digest("hex").slice(0, 16)}.js`);
    if (!existsSync(file)) writeFileSync(file, code);
    render = (await import(file)).render;
  } catch (e) {
    console.error(`✗ the API docs page isn't rendered on the server (it still renders in the browser): ${(e as Error).message}`);
  }
  return { script, style, assets, render };
}

/** Builds by public base, pages, slots and components: a file added or edited in forge/docs builds the page again. Only the latest few are kept. */
const builds = new Map<string, Promise<Built>>();
const builtFor = (publicBase: string, forgeDir: string, dev = false) => {
  const c: Content = { guides: guidesOf(forgeDir), slots: slotsOf(forgeDir), components: componentsOf(forgeDir) };
  const key = JSON.stringify([publicBase, forgeDir, dev, c.guides.map((g) => [g.path, g.stamp]), c.slots.map((s) => [s.path, s.stamp]), c.components.map((x) => [x.path, x.stamp])]);
  let b = builds.get(key);
  if (!b) {
    b = build(publicBase, forgeDir, dev, c);
    builds.set(key, b);
    b.catch(() => builds.delete(key));
    for (const old of [...builds.keys()].slice(0, Math.max(0, builds.size - 4))) builds.delete(old);
  }
  return { built: b, content: c };
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
    const stamp = stampOf(path);
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

function send(req: Request, body: string | Uint8Array<ArrayBuffer>, type: string, cache: string, status = 200): Response {
  const headers = { "content-type": type, "cache-control": cache, vary: "accept-encoding", "x-content-type-options": "nosniff" };
  const bytes = typeof body === "string" ? new TextEncoder().encode(body) : body;
  // Made on every request: a lower brotli quality than the default, which is for files compressed once.
  if (accepts(req, "br")) return new Response(brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 5 } }), { status, headers: { ...headers, "content-encoding": "br" } });
  if (accepts(req, "gzip")) return new Response(Bun.gzipSync(bytes), { status, headers: { ...headers, "content-encoding": "gzip" } });
  return new Response(bytes, { status, headers });
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

/** The app's CSS for the page (`page.css`): the text, or a file under forge/docs. */
function appCss(page: DocsPageConfig, forgeDir: string): string {
  const css = page.css?.trim();
  if (!css) return "";
  if (/^[\w./-]+\.css$/.test(css)) {
    const path = join(forgeDir, "docs", css);
    if (!path.startsWith(join(forgeDir, "docs")) || !existsSync(path)) {
      console.error(`✗ the API docs page: page.css names ${css}, which isn't a file in forge/docs`);
      return "";
    }
    return readFileSync(path, "utf8");
  }
  return css;
}

/** The page's background while it loads: the theme's (or its preset's), in both modes. */
function backdrop(page: DocsPageConfig) {
  const t = page.theme ?? {};
  const bg = t.tokens?.bg;
  const [light, dark] = typeof bg === "string" ? [bg, bg] : bg ? [bg.light, bg.dark] : t.preset === "minimal" ? ["#ffffff", "#0b0b0c"] : ["#f6f4ef", "#0c0c0d"];
  const mode = t.mode ?? (t.preset === "dark" ? "dark" : "auto");
  return `@layer forge-docs{html,body{margin:0}body{background:${mode === "dark" ? dark : light}}${mode === "auto" ? `@media (prefers-color-scheme:dark){body{background:${dark}}}` : ""}}`;
}

function pageHtml(built: Built, boot: BootConfig, o: { title: string; html?: string; css?: string; markdown?: string }): string {
  const base = escapeAttr(boot.publicBase);
  const mode = boot.page.theme?.mode ?? (boot.page.theme?.preset === "dark" ? "dark" : "auto");
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">` +
    `<meta name="color-scheme" content="${mode === "dark" ? "dark" : mode === "light" ? "light" : "light dark"}"><title>${escapeAttr(o.title)}</title>` +
    // The page's layer first, then the app's (page.css), so the app's rules win without !important. In the page's layer too, so that nothing
    // here is an unlayered rule the request builder's layered styles would lose to.
    `<style>@layer forge-docs, forge-docs-app;${fontFaces(boot.publicBase)}${backdrop(boot.page)}</style>` +
    (built.style ? `<link rel="stylesheet" href="${base}/_docs/assets/${built.style}">` : "") +
    (o.css ? `<style>@layer forge-docs-app{${o.css.replace(/<\/style/gi, "<\\/style")}}</style>` : "") +
    (o.markdown ? `<link rel="alternate" type="text/markdown" href="${escapeAttr(o.markdown)}">` : "") +
    `<link rel="preload" href="${escapeAttr(boot.openapiUrl)}${boot.rendered === "all" ? "?audience=all" : ""}" as="fetch" crossorigin>` +
    `<script type="application/json" id="forge-docs-config">${jsonForScript(boot)}</script></head>` +
    `<body><div id="root">${o.html ?? ""}</div><noscript>The API description is at <a href="${escapeAttr(boot.openapiUrl)}">${escapeAttr(boot.openapiUrl)}</a>.</noscript>` +
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

/** The site of a document, as the page builds it (the same labels, guides and options), kept per document. */
const sites = new WeakMap<object, Map<string, { site: Site; model: ReturnType<typeof arrange> }>>();
function siteOf(doc: OpenApi, page: DocsPageConfig, guides: GuideFile[]) {
  const t = makeTranslate(page.strings);
  const model = arrange(doc, t("untagged"), t("otherGroup"));
  const all = [...guides, ...(model.hasRpc ? [{ slug: "functions", title: t("functionsGuide") }] : [])];
  const key = JSON.stringify([page.layout?.pages, page.layout?.referencePath, page.hide, page.strings, all.map((g) => [g.slug, g.title, (g as GuideFile).group, (g as GuideFile).order])]);
  let byKey = sites.get(doc);
  if (!byKey) sites.set(doc, (byKey = new Map()));
  let found = byKey.get(key);
  if (!found) {
    const site = buildSite(model, all, {
      pages: page.layout?.pages ?? "operation",
      referencePath: page.layout?.referencePath,
      hide: page.hide,
      labels: { overview: t("overview"), guides: t("guides"), webhooks: t("webhooks"), models: t("models"), api: t("api") },
    });
    byKey.set(key, (found = { site, model }));
  }
  return found;
}

/** Rendered pages, by build, then document, then address: a page is the same until the code or the forge/docs files change. */
const rendered = new WeakMap<Built, WeakMap<object, Map<string, string>>>();
function renderedFor(built: Built, doc: object) {
  let byDoc = rendered.get(built);
  if (!byDoc) rendered.set(built, (byDoc = new WeakMap()));
  let pages = byDoc.get(doc);
  if (!pages) byDoc.set(doc, (pages = new Map()));
  return pages;
}

export const apiDocs: DocsHost & { firstLoadBytes(publicBase: string, forgeDir: string): Promise<{ raw: number; gzip: number }> } = {
  async serve(req, options) {
    if (req.method !== "GET" && req.method !== "HEAD") return null;
    const url = new URL(req.url);
    const path = url.pathname;
    const { base, explorerPath } = options;
    const prefix = `${base}/_docs/`;
    if (path.startsWith(prefix)) {
      const rest = path.slice(prefix.length);
      if (rest.startsWith("assets/")) {
        const asset = (await builtFor(options.publicBase, options.forgeDir, options.dev).built).assets.get(rest.slice("assets/".length));
        return asset ? sendAsset(req, asset) : null;
      }
      if (rest.startsWith("fonts/") && Object.hasOwn(FONTS, rest.slice("fonts/".length)))
        return new Response(Bun.file(FONTS[rest.slice("fonts/".length)]!.file), { headers: { "content-type": "font/woff2", "cache-control": "public, max-age=31536000, immutable" } });
      if (explorerPath !== null && (rest === "explorer.js" || rest === "explorer.css")) {
        const file = vendor(rest);
        // With the content's hash in the address the file never changes under it; without, it is checked again each time.
        return file ? sendVendored(req, file, MIME[rest.slice(rest.lastIndexOf(".") + 1)]!, url.searchParams.has("v") ? "public, max-age=31536000, immutable" : "no-cache") : null;
      }
      return null;
    }
    const isPage = path === base || path === `${base}/` || (explorerPath !== null && path === explorerPath);
    if (!isPage && !path.startsWith(`${base}/`)) return null;

    const audience = options.dev && url.searchParams.get("audience") === "all" ? "all" : "public";
    const doc = ((await options.document?.(audience)) ?? null) as OpenApi | null;
    const { built: building, content } = builtFor(options.publicBase, options.forgeDir, options.dev);
    const found = doc ? siteOf(doc, options.page, content.guides) : null;

    // Markdown and llms.txt, from the same document and pages.
    const markdownOf = (): MarkdownInput | null =>
      doc && found
        ? {
            doc,
            model: found.model,
            site: found.site,
            origin: url.origin,
            publicBase: options.publicBase,
            guideSource: (slug) => {
              const g = content.guides.find((x) => x.slug === slug);
              return g ? parseFrontMatter(readFileSync(g.path, "utf8")).body : slug === "functions" ? readFileSync(join(HERE, "guide.mdx"), "utf8") : undefined;
            },
          }
        : null;
    if (path === `${base}/llms.txt`) {
      const m = markdownOf();
      return m ? send(req, llmsTxt(m), "text/plain; charset=utf-8", "no-cache") : null;
    }
    if (path.endsWith(".md")) {
      const m = markdownOf();
      const at = path === `${base}/index.md` ? "" : path.slice(base.length, -3);
      const p = m?.site.byPath.get(at);
      return m && p ? send(req, pageMarkdown(m, p), "text/markdown; charset=utf-8", "no-cache") : null;
    }

    // A page: the overview at the docs' own path (and the explorer path), any other only when the document has it.
    const at = isPage ? "" : path.slice(base.length).replace(/\/+$/, "");
    const page = found?.site.byPath.get(at);
    if (!isPage && !page) return null;
    const built = await building;
    const boot: BootConfig = {
      publicBase: options.publicBase,
      openapiUrl: options.openapiUrl,
      explorerUrl: explorerUrlOf(options),
      tryOpen: explorerPath !== null && path === explorerPath,
      dev: options.dev,
      page: options.page,
      path: at,
    };
    const name = options.page.title ?? doc?.info.title ?? "API reference";
    const title = page && page.kind !== "overview" && page.kind !== "single" ? `${page.title} | ${name}` : name;
    const css = appCss(options.page, options.forgeDir);
    let html: string | undefined;
    if (doc && built.render) {
      const pages = renderedFor(built, doc);
      const key = `${at}\u0000${JSON.stringify(options.page)}\u0000${boot.tryOpen}`;
      try {
        html = pages.get(key) ?? (await built.render({ boot: { ...boot, rendered: audience }, document: doc }));
        if (pages.size > 500) pages.clear();
        pages.set(key, html);
        boot.rendered = audience;
      } catch (e) {
        console.error(`✗ the API docs page: ${at || "/"} didn't render on the server (it renders in the browser): ${(e as Error).message}`);
        html = undefined;
      }
    }
    return send(req, pageHtml(built, boot, { title, html, css, markdown: page ? `${options.publicBase}${at || "/index"}.md` : undefined }), "text/html; charset=utf-8", "no-cache");
  },
  paths({ base, explorerPath }) {
    return { exact: [base, `${base}/`, ...(explorerPath !== null ? [explorerPath] : [])], prefixes: [`${base}/_docs/`] };
  },
  /** The page's first load, gzipped, for the size budget: the HTML shell, the entry script, the stylesheet and the chunks the entry imports at once (not the explorer, or any app page). */
  async firstLoadBytes(publicBase, forgeDir) {
    const built = await builtFor(publicBase, forgeDir).built;
    const html = pageHtml(built, { publicBase, openapiUrl: `${publicBase}/openapi.json`, explorerUrl: `${publicBase}/_docs/explorer.js`, tryOpen: false, dev: false, page: {} satisfies DocsPageConfig, path: "" }, { title: "API reference" });
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
