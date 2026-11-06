import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createElement } from "react";
import { renderToString } from "react-dom/server";
import type { Browser, BrowserContext, Page } from "playwright-core";
import type { DocsPageConfig, DocsServeOptions } from "../src/api-docs/contract";
import { apiDocs, parseFrontMatter } from "../src/api-docs/host";
import { ApiReference } from "../src/api-docs/react";
import { fetchToken } from "../src/api-docs/credentials";
import { generate } from "../src/api-docs/languages";
import { Markdown, safeUrl } from "../src/api-docs/markdown";
import { arrange, type OpenApi, type Schema } from "../src/api-docs/openapi";
import { buildRequest, curl } from "../src/api-docs/samples";
import { describe as describeSchema, exampleOf } from "../src/api-docs/schema";

const FIXTURES = join(import.meta.dir, "fixtures");
const FORGE = join(FIXTURES, "forge");
const doc = JSON.parse(readFileSync(join(FIXTURES, "openapi.json"), "utf8")) as { paths: Record<string, unknown> };

const options = (over: Partial<DocsServeOptions> = {}): DocsServeOptions => ({ base: "/docs", publicBase: "/docs", openapiUrl: "/docs/openapi.json", explorerPath: "/docs/explorer", dev: false, forgeDir: FORGE, page: {}, ...over });
const ask = (path: string, over: Partial<DocsServeOptions> = {}, headers: Record<string, string> = {}, init: RequestInit = {}) =>
  apiDocs.serve(new Request(`http://localhost${path}`, { headers: { "accept-encoding": "identity", ...headers }, ...init }), options(over));
const configOf = (html: string) => JSON.parse(/<script type="application\/json" id="forge-docs-config">(.*?)<\/script>/s.exec(html)![1]!) as Record<string, any>;
const scriptOf = (html: string) => /src="[^"]*\/_docs\/assets\/([^"]+\.js)"/.exec(html)![1]!;

describe("the host", () => {
  test("answers the page, its assets and the explorer path, and hands everything else to the app", async () => {
    for (const path of ["/docs", "/docs/"]) {
      const page = await ask(path);
      expect(page!.status).toBe(200);
      expect(page!.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(page!.headers.get("cache-control")).toBe("no-cache");
    }
    const explorer = await ask("/docs/explorer", {}, {}, {});
    expect(configOf(await explorer!.text()).tryOpen).toBe(true);
    expect(configOf(await (await ask("/docs"))!.text()).tryOpen).toBe(false);

    // The app's own pages below the same prefix, the document (the engine serves it) and unknown assets are not the host's.
    for (const path of ["/docs/api/products", "/docs/authentication", "/docs/openapi.json", "/docs/_docs", "/docs/_docs/", "/docs/_docs/nope.js", "/docs/_docs/assets/nope.js", "/docs/_docs/fonts/nope.woff2", "/docs/_docs/fonts/__proto__", "/docs/explorer/more", "/docs/assets/app.js", "/documents", "/other"])
      expect(await ask(path), path).toBeNull();
    expect(await ask("/docs", {}, {}, { method: "POST" })).toBeNull();

    // With the builder off, its path and files are the app's too.
    expect(await ask("/docs/explorer", { explorerPath: null })).toBeNull();
    expect(await ask("/docs/_docs/explorer.js", { explorerPath: null })).toBeNull();

    expect(apiDocs.paths({ base: "/docs", explorerPath: "/docs/explorer" })).toEqual({ exact: ["/docs", "/docs/", "/docs/explorer"], prefixes: ["/docs/_docs/"] });
    expect(apiDocs.paths({ base: "/_api", explorerPath: null })).toEqual({ exact: ["/_api", "/_api/"], prefixes: ["/_api/_docs/"] });

    // What it says it answers, it answers.
    const html = await (await ask("/docs"))!.text();
    const script = scriptOf(html);
    const asset = await ask(`/docs/_docs/assets/${script}`, {}, { "accept-encoding": "gzip, br" });
    expect(asset!.headers.get("content-encoding")).toBe("br");
    expect(asset!.headers.get("cache-control")).toContain("immutable");
    expect((await ask("/docs/_docs/fonts/geist.woff2"))!.headers.get("content-type")).toBe("font/woff2");
    expect((await ask("/docs/_docs/fonts/geist-mono.woff2"))!.status).toBe(200);
  });

  test("every URL in the HTML starts with the public base, a reverse proxy's sub-path", async () => {
    const o = { publicBase: "/platform/docs", openapiUrl: "/platform/docs/openapi.json" };
    const html = await (await ask("/docs", o))!.text();
    expect(html).toContain('href="/platform/docs/_docs/assets/');
    expect(html).toContain('src="/platform/docs/_docs/assets/');
    expect(html).toContain("url(/platform/docs/_docs/fonts/geist.woff2)");
    expect(html).toContain('<link rel="preload" href="/platform/docs/openapi.json" as="fetch" crossorigin>');
    expect(html).not.toMatch(/(?:href|src)="\/docs\//);
    const config = configOf(html);
    expect(config).toMatchObject({ publicBase: "/platform/docs", openapiUrl: "/platform/docs/openapi.json", dev: false });
    expect(config.explorerUrl).toStartWith("/platform/docs/_docs/explorer.js");
    // The bundle's own chunks load from there too, and the engine still finds the assets at its own path.
    const js = await (await ask(`/docs/_docs/assets/${scriptOf(html)}`, o))!.text();
    expect(js).toContain("/platform/docs/_docs/assets/");
    expect(await ask("/docs", { ...o, explorerPath: null }).then((r) => r!.text()).then((t) => configOf(t).explorerUrl)).toBeNull();
    expect(await ask("/docs", { page: { explorer: false } }).then((r) => r!.text()).then((t) => configOf(t).explorerUrl)).toBeNull();
  });

  test("the page's configuration is JSON in the HTML that can't close the script tag", async () => {
    const page: DocsPageConfig = { title: "</script><script>alert(1)</script>   &amp;", logo: { url: '"><img src=x onerror=alert(1)>' }, strings: { tryIt: "</script>" } };
    const html = await (await ask("/docs", { page, dev: true }))!.text();
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).not.toContain("<img src=x");
    expect(html.match(/<script/g)!.length).toBe(2); // the configuration and the bundle
    const config = configOf(html);
    expect(config.page).toEqual(page);
    expect(config.dev).toBe(true);
    expect(html).toContain("<title>&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  test("front matter sets a guide's title, group and order; the page keeps them as data", async () => {
    expect(parseFrontMatter("---\ntitle: A: b\ngroup: 'Q & A'\norder: 2 # first\n---\n# Body")).toEqual({ meta: { title: "A: b", group: "Q & A", order: "2" }, body: "# Body" });
    expect(parseFrontMatter("# No front matter\n---\nnot: yaml")).toEqual({ meta: {}, body: "# No front matter\n---\nnot: yaml" });
    expect(parseFrontMatter('---\r\ntitle: "Quoted"\r\n---\r\ntext').meta.title).toBe("Quoted");

    const html = await (await ask("/docs"))!.text();
    const js = await (await ask(`/docs/_docs/assets/${scriptOf(html)}`))!.text();
    expect(js.length / js.split("\n").length).toBeGreaterThan(2000); // minified: long lines
    // Title, group and order from the front matter, else the first heading, else the file name; `_slots` are not guides.
    const guides = /guides:\[(.*?)\],slots:/s.exec(js)![1]!;
    expect(guides).toMatch(/slug:"getting-started",title:"Getting started",group:"Introduction",order:1/);
    expect(guides).toMatch(/slug:"errors",title:"Errors",group:"Guides",order:3/);
    expect(guides).toMatch(/slug:"changelog",title:"Changelog"/);
    expect(guides).not.toContain("slots");
    expect(js).toContain("header");
    // The MDX in each guide's chunk has no front matter in it.
    const chunk = /chunk-[a-z0-9]+\.js/.exec(js.slice(js.indexOf('slug:"getting-started"')))![0];
    const text = await (await ask(`/docs/_docs/assets/${chunk}`))!.text();
    expect(text).toContain("Take your first payment");
    expect(text).not.toContain("order: 1");
  });

  test("a page or slot added or edited in forge/docs builds the page again; a change of configuration doesn't need to", async () => {
    const dir = mkdtempSync(join(tmpdir(), "afx-api-docs-"));
    cpSync(FORGE, join(dir, "forge"), { recursive: true });
    const forgeDir = join(dir, "forge");
    const first = await (await ask("/docs", { forgeDir }))!.text();
    expect(await (await ask("/docs", { forgeDir, page: { title: "Other" } }))!.text().then(scriptOf)).toBe(scriptOf(first));
    writeFileSync(join(forgeDir, "docs", "04-limits.mdx"), "---\ntitle: Limits\n---\n\nTen per second.\n");
    const second = await (await ask("/docs", { forgeDir }))!.text();
    expect(scriptOf(second)).not.toBe(scriptOf(first));
    expect(await (await ask(`/docs/_docs/assets/${scriptOf(second)}`, { forgeDir }))!.text()).toContain('title:"Limits"');
    // The old build's files are gone with it: assets are looked up in the current build.
    expect(await ask(`/docs/_docs/assets/${scriptOf(first)}`, { forgeDir })).toBeNull();
    writeFileSync(join(forgeDir, "docs", "_slots", "header.mdx"), "Edited header\n");
    const third = await (await ask("/docs", { forgeDir }))!.text();
    expect(scriptOf(third)).not.toBe(scriptOf(second));
  });

  test("the page's styles are in a cascade layer, so they can't beat the request builder's (Tailwind, layered) or leak into it", async () => {
    const html = await (await ask("/docs"))!.text();
    expect(html).toContain("<style>@layer forge-docs, forge-docs-app;@font-face");
    expect(html).toMatch(/@layer forge-docs\{html,body\{margin:0\}/);
    const css = await (await ask(`/docs/_docs/assets/${/_docs\/assets\/([^"]+\.css)/.exec(html)![1]}`))!.text();
    expect(css.startsWith("@layer forge-docs{")).toBe(true);
    expect(css.trimEnd().endsWith("}")).toBe(true);
    // Everything in it is inside that one layer: the next top-level thing after the layer's block is the end of the file.
    let depth = 0;
    let topLevel = 0;
    for (const ch of css) {
      if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) topLevel++;
    }
    expect(topLevel).toBe(1);
  });

  test("the request builder is served from vendor/scalar, brotli as stored, with a content hash in its address", async () => {
    const vendor = join(import.meta.dir, "../vendor/scalar");
    const stored = ["explorer.js.br", "explorer.js"].some((f) => existsSync(join(vendor, f)));
    const config = configOf(await (await ask("/docs"))!.text());
    if (!stored) {
      expect(await ask("/docs/_docs/explorer.js")).toBeNull();
      expect(config.explorerUrl).toBe("/docs/_docs/explorer.js");
      return;
    }
    expect(config.explorerUrl).toMatch(/^\/docs\/_docs\/explorer\.js\?v=[0-9a-f]{12}$/);
    const res = await ask(config.explorerUrl as string, {}, { "accept-encoding": "gzip, br" });
    expect(res!.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(res!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const etag = res!.headers.get("etag")!;
    expect((await ask("/docs/_docs/explorer.js", {}, { "if-none-match": etag }))!.status).toBe(304);
    expect((await ask("/docs/_docs/explorer.js"))!.headers.get("cache-control")).toBe("no-cache"); // no hash: checked each time
    const plain = await ask("/docs/_docs/explorer.js"); // a client without brotli gets it decompressed
    expect(plain!.headers.get("content-encoding")).toBeNull();
    expect((await plain!.text()).length).toBeGreaterThan(1000);
    // Its stylesheet: the script asks for the address beside its own with `.js` made `.css`, query kept.
    if (existsSync(join(vendor, "explorer.css.br")) || existsSync(join(vendor, "explorer.css"))) {
      const css = await ask((config.explorerUrl as string).replace("explorer.js", "explorer.css"));
      expect(css!.headers.get("content-type")).toBe("text/css; charset=utf-8");
      expect(css!.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
      expect((await css!.text()).length).toBeGreaterThan(1000);
      expect((await ask("/docs/_docs/explorer.css"))!.headers.get("cache-control")).toBe("no-cache");
      // One version for both files: it moves when either does.
      expect(config.explorerUrl).not.toBe(configOf(await (await ask("/docs", { page: {} }))!.text()).explorerUrl.replace(/v=\w+/, "v=0"));
    }
  });

  test("the page's first load stays within its budget", async () => {
    const { gzip } = await apiDocs.firstLoadBytes("/_api", FORGE);
    console.log(`API docs page, first load: ${gzip} bytes gzipped (HTML, script, stylesheet and the chunks they import at once; fonts are two Latin woff2 files, 29 and 23 KB)`);
    expect(gzip).toBeLessThan(110 * 1024);
  });

  const withDoc = (over: Partial<DocsServeOptions> = {}): Partial<DocsServeOptions> => ({ document: async () => doc, ...over });

  test("every page has its own address and is rendered on the server: its HTML is the page, readable without JavaScript", async () => {
    const op = await ask("/docs/payments/create-payment", withDoc());
    expect(op!.status).toBe(200);
    const html = await op!.text();
    expect(html).toContain("<title>Create a payment | Midas Payments API</title>");
    expect(html).toContain("Idempotency-Key"); // the operation, in the HTML
    expect(html).toContain('href="/docs/payments/list-payments"'); // the navigation, as links
    expect(html).toContain('<link rel="alternate" type="text/markdown" href="/docs/payments/create-payment.md">');
    expect(configOf(html)).toMatchObject({ path: "/payments/create-payment", rendered: "public" });
    for (const path of ["/docs/payments", "/docs/guides/getting-started", "/docs/webhooks", "/docs/models", "/docs/customers/list-customers"]) expect((await ask(path, withDoc()))!.status, path).toBe(200);
    expect(await (await ask("/docs/guides/getting-started", withDoc()))!.text()).toContain("Use the sandbox server while you build.");
    // Addresses the document doesn't have are the app's.
    for (const path of ["/docs/payments/nope", "/docs/nope", "/docs/guides/nope", "/docs/nope.md", "/docs/payments/nope.md"]) expect(await ask(path, withDoc()), path).toBeNull();
    // Without the document (the engine's code not loaded yet), only the page itself, rendered in the browser.
    expect(await ask("/docs/payments/create-payment")).toBeNull();
    expect(configOf(await (await ask("/docs"))!.text()).rendered).toBeUndefined();
    // How the reference is split is the app's choice: one page per tag, or everything on one page.
    expect(await ask("/docs/payments/create-payment", withDoc({ page: { layout: { pages: "tag" } } }))).toBeNull();
    expect(await (await ask("/docs/payments", withDoc({ page: { layout: { pages: "tag" } } })))!.text()).toContain("Idempotency-Key");
    expect(await ask("/docs/payments", withDoc({ page: { layout: { pages: "single" } } }))).toBeNull();
    expect((await ask("/docs/api/payments/create-payment", withDoc({ page: { layout: { referencePath: "/api" } } })))!.status).toBe(200);
  });

  test("every page as Markdown (what Copy page copies), and llms.txt listing them", async () => {
    const md = await ask("/docs/payments/create-payment.md", withDoc());
    expect(md!.headers.get("content-type")).toBe("text/markdown; charset=utf-8");
    const text = await md!.text();
    expect(text).toStartWith("# Create a payment\n\n`POST https://api.midas.test/api/v1/payments`");
    expect(text).toContain("Scopes: `payments:write`");
    expect(text).toContain("| `Idempotency-Key` | string | no |");
    expect(text).toContain("- `amount` (integer, required, minimum 1, maximum 99999999): In the currency's smallest unit.");
    expect(text).toContain("  - `card_declined`: The issuer declined the card.");
    expect(text).toContain("```bash\ncurl -X POST 'https://api.midas.test/api/v1/payments'");
    // A guide is its own MDX, without the front matter.
    expect(await (await ask("/docs/guides/getting-started.md", withDoc()))!.text()).toStartWith("# Take your first payment");
    expect(await (await ask("/docs/index.md", withDoc()))!.text()).toContain("## Base URL");
    const llms = await (await ask("/docs/llms.txt", withDoc()))!.text();
    expect(llms).toStartWith("# Midas Payments API\n\n> Take payments, refund them and hear about it.");
    expect(llms).toContain("- [Create a payment](/docs/payments/create-payment.md): POST /payments");
    expect(llms).toContain("- [Getting started](/docs/guides/getting-started.md)");
    expect(llms).toContain("- [Webhooks](/docs/webhooks.md)");
  });

  test("a slot, page or component of the app's that doesn't compile is logged with its file and line, shown in development, left out in production; the page still works", async () => {
    const forge = mkdtempSync(join(tmpdir(), "afx-docs-"));
    cpSync(FORGE, forge, { recursive: true });
    writeFileSync(join(forge, "docs", "_slots", "header.mdx"), '<style>{`.x::before { content: "\\25D0"; }`}</style>\n');
    writeFileSync(join(forge, "docs", "07-broken.mdx"), "# Broken\n\n<Callout>unclosed\n");
    const errors: string[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a.join(" "));
    try {
      const dev = await ask("/docs/payments/create-payment", withDoc({ forgeDir: forge, dev: true }));
      expect(dev!.status).toBe(200);
      const html = await dev!.text();
      expect(html).toContain("Idempotency-Key"); // the rest of the page
      expect(html).toMatch(/docs\/_slots\/header\.mdx has an error/);
      expect(errors.join("\n")).toMatch(/docs\/_slots\/header\.mdx:1:\d+: /);
      expect(errors.join("\n")).toMatch(/docs\/07-broken\.mdx:\d+:\d+: /);
      const guide = await (await ask("/docs/guides/broken", withDoc({ forgeDir: forge, dev: true })))!.text();
      expect(guide).toMatch(/07-broken\.mdx has an error/);
      const prod = await (await ask("/docs/payments/create-payment", withDoc({ forgeDir: forge, dev: false })))!.text();
      expect(prod).not.toContain("has an error");
      expect(prod).toContain("Idempotency-Key");
    } finally {
      console.error = original;
    }
  });

  test("page.css: CSS for the page, as text or a file in forge/docs, in a layer after the page's own", async () => {
    const forge = mkdtempSync(join(tmpdir(), "afx-docs-"));
    cpSync(FORGE, forge, { recursive: true });
    writeFileSync(join(forge, "docs", "theme.css"), ".fd [data-part='brand'] { font-weight: 800 }");
    const fromFile = await (await ask("/docs", withDoc({ forgeDir: forge, page: { css: "theme.css" } })))!.text();
    expect(fromFile).toContain("<style>@layer forge-docs-app{.fd [data-part='brand'] { font-weight: 800 }}</style>");
    const inline = await (await ask("/docs", withDoc({ page: { css: "body { color: red } </style><script>x</script>" } })))!.text();
    expect(inline).toContain("@layer forge-docs-app{body { color: red } <\\/style><script>x</script>}"); // it can't close its element
    expect(inline.indexOf("@layer forge-docs, forge-docs-app;")).toBeLessThan(inline.indexOf("@layer forge-docs-app{"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The page in a real browser. These skip when no browser can be launched (CHROMIUM_PATH, or `bunx playwright-core install chromium`).

function chromiumPath(): string | undefined {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;
  const cache = join(homedir(), ".cache", "ms-playwright");
  if (existsSync(cache))
    for (const dir of readdirSync(cache).filter((d) => d.startsWith("chromium-")).sort().reverse())
      for (const exe of [join(cache, dir, "chrome-linux64", "chrome"), join(cache, dir, "chrome-linux", "chrome")]) if (existsSync(exe)) return exe;
  return ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"].find(existsSync);
}

const STUB = `window.__mounts = []; window.__opens = []; window.__updates = []; window.__closes = 0; window.__instances = [];
window.ForgeExplorer = { version: "stub", mount(el, options) {
  window.__mounts.push(options);
  el.textContent = "stub explorer";
  const instance = { open(t) { window.__opens.push(t); }, close() { window.__closes++; }, update(o) { window.__updates.push(o); }, destroy() {} };
  window.__instances.push(instance);
  return instance;
} };`;

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve>;
let origin = "";
let pageConfig: DocsPageConfig = {};
let dev = false;
let explorerStatus = 200;
let realExplorer = false;
let tokenMode: "basic" | "post-only" | "reject" = "basic";
const tokenRequests: { authorization: string | null; body: string }[] = [];
const contexts: BrowserContext[] = [];
const internalPaths = {
  "/internal/ping": { get: { operationId: "ping", tags: ["Customers"], summary: "Ping the cluster", "x-internal": true, responses: { "200": { description: "pong" } } } },
  "/rpc/payments:sync": { post: { operationId: "rpcSync", tags: ["Functions"], summary: "payments:sync", "x-internal": true, responses: { "200": { description: "Done" } } } },
};

beforeAll(async () => {
  const executablePath = chromiumPath();
  if (executablePath) {
    try {
      const { chromium } = await import("playwright-core");
      browser = await chromium.launch({ executablePath, args: ["--no-sandbox"] });
    } catch (e) {
      console.warn(`browser tests skipped: ${(e as Error).message.split("\n")[0]}`);
    }
  }
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/docs/openapi.json") return Response.json(url.searchParams.get("audience") === "all" ? { ...doc, paths: { ...doc.paths, ...internalPaths } } : doc);
      if (url.pathname === "/docs/_docs/explorer.js" && !realExplorer) return explorerStatus === 200 ? new Response(STUB, { headers: { "content-type": "text/javascript" } }) : new Response("gone", { status: explorerStatus });
      if (url.pathname === "/token" && req.method === "POST") {
        const body = await req.text();
        const authorization = req.headers.get("authorization");
        tokenRequests.push({ authorization, body });
        const refuse = tokenMode === "reject" || (tokenMode === "post-only" && authorization);
        if (refuse) return Response.json({ error: "invalid_client", error_description: "Unknown client" }, { status: 401 });
        return Response.json({ access_token: `at_${tokenRequests.length}`, token_type: "Bearer", expires_in: 3600 });
      }
      const page = await apiDocs.serve(req, options({ dev, page: pageConfig, document: async (audience) => (audience === "all" ? { ...doc, paths: { ...doc.paths, ...internalPaths } } : doc) }));
      return page ?? new Response("the app's own page", { status: 404 });
    },
  });
  origin = `http://localhost:${server.port}`;
});
afterAll(async () => {
  await browser?.close();
  await server?.stop(true);
});
afterEach(async () => {
  for (const c of contexts.splice(0)) await c.close();
  pageConfig = {};
  dev = false;
  explorerStatus = 200;
  realExplorer = false;
  tokenMode = "basic";
  tokenRequests.length = 0;
});

const run = (name: string, fn: () => Promise<void>) => test(name, async () => (browser ? fn() : console.warn(`skipped: ${name}`)), 60_000);

/** A page on the docs, recording whatever the browser complains about. */
async function open(path = "/docs", ctxOptions: Parameters<Browser["newContext"]>[0] = {}) {
  const context = await browser!.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: "light", ...ctxOptions });
  contexts.push(context);
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && !m.location().url.endsWith("/favicon.ico") && problems.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${origin}${path}`, { waitUntil: "load" });
  await page.waitForSelector(".fd[data-ready] [data-part='article']");
  return { page, problems };
}
/** Everything on one page, as 0.19 had it: for what spans operations (a language picked everywhere, slots around each). */
const SINGLE: DocsPageConfig = { layout: { pages: "single" } };
const op = (page: Page, id: string) => page.locator(`[id="${id}"]`);
/** What an element says, its text collapsed to single spaces (`textContent`, so what the browser skips drawing counts too). */
const text = async (page: Page, id: string) => ((await op(page, id).textContent()) ?? "").replace(/\s+/g, " ");
/** A section of a page by the anchor it is listed under (its heading has the id). */
const spied = async (page: Page, anchor: string) => ((await page.locator(`[data-spy="${anchor}"]`).textContent()) ?? "").replace(/\s+/g, " ");
const store = (page: Page) => page.evaluate(() => JSON.parse(sessionStorage.getItem("forge-docs:/docs:/docs/openapi.json") ?? "{}") as Record<string, any>);
const win = <T>(page: Page, fn: () => T) => page.evaluate(fn);

describe("the page in a browser", () => {
  run("the default layout: logo and search at the top of a full-height navigation, a page per operation at its own address, On this page, Copy page, previous and next", async () => {
    const { page, problems } = await open("/docs/payments/create-payment");
    // The navigation runs the page's height, with the brand and the search (and its shortcut) at its top.
    const side = page.locator("[data-part='sidebar']");
    expect(await side.locator("[data-part='brand']").textContent()).toContain("Midas Payments API");
    expect(await side.locator("[data-part='search'] kbd").count()).toBe(1);
    expect(await side.evaluate((el) => Math.round(el.getBoundingClientRect().height))).toBe(900);
    // Groups in order, sentence case, foldable.
    const nav = ((await page.getByRole("navigation", { name: "API navigation" }).textContent()) ?? "").replace(/\s+/g, " ");
    const order = ["Overview", "Authentication", "Introduction", "Getting started", "Guides", "Idempotency", "Errors", "Changelog", "Core resources", "Payments", "Refunds", "People", "Customers", "Webhooks", "Models"];
    const at = order.map((x) => nav.indexOf(x));
    expect(at.every((n) => n >= 0), nav).toBe(true);
    expect(at).toEqual([...at].sort((a, b) => a - b));
    expect(await page.locator(".fd-nav-title").first().evaluate((el) => getComputedStyle(el).textTransform)).toBe("none");
    // Links are addresses, not #/… fragments.
    expect(await page.locator("nav a[href^='#/']").count()).toBe(0);
    expect(await page.locator("nav a[href='/docs/payments/create-payment']").getAttribute("aria-current")).toBe("page");
    // The page: its section, its title, the endpoint bar with Try it, On this page, Copy page and previous / next.
    expect(await page.locator("[data-part='breadcrumb']").textContent()).toBe("Payments");
    expect(await page.locator("h1").textContent()).toContain("Create a payment");
    const bar = page.locator("[data-part='endpoint-bar']");
    expect(await bar.textContent()).toContain("https://api.midas.test/api/v1/payments");
    expect(await bar.getByRole("button", { name: "Try it" }).count()).toBe(1);
    const toc = page.getByRole("navigation", { name: "On this page" });
    expect(await toc.getByRole("link").allTextContents()).toEqual(["Authorizations", "Header parameters", "Body", "Responses"]);
    expect(await page.getByRole("button", { name: "Copy page" }).count()).toBe(1);
    expect(await page.getByRole("link", { name: "View as Markdown" }).getAttribute("href")).toBe("/docs/payments/create-payment.md");
    const pager = page.locator("[data-part='pagination']");
    expect(await pager.locator("[rel=prev]").getAttribute("href")).toBe("/docs/payments/list-payments");
    expect(await pager.locator("[rel=next]").getAttribute("href")).toBe("/docs/payments/get-payment");
    expect(await page.title()).toBe("Create a payment | Midas Payments API");
    expect(problems).toEqual([]);
  });

  run("pages are rendered on the server; the browser takes them over without rendering them again, and moves between them without reloading", async () => {
    const { page, problems } = await open("/docs/payments");
    // The server's HTML was the page (the operation list was there before any script ran).
    const html = await (await fetch(`${origin}/docs/payments`)).text();
    expect(html).toContain("Create a payment");
    expect(html).toContain('data-part="tag-endpoints"');
    await page.evaluate(() => ((window as any).__sameDocument = true));
    await page.getByRole("link", { name: /Create a payment/ }).first().click();
    await page.waitForFunction(() => location.pathname === "/docs/payments/create-payment");
    expect(await page.locator("h1").textContent()).toContain("Create a payment");
    expect(await page.title()).toBe("Create a payment | Midas Payments API");
    expect(await win(page, () => (window as any).__sameDocument)).toBe(true); // no reload
    await page.goBack();
    await page.waitForFunction(() => location.pathname === "/docs/payments");
    expect(await page.locator("h1").textContent()).toBe("Payments");
    expect(problems).toEqual([]);
  });

  run("an address of 0.19's single page (#/tag/operationId) moves to the page that has it now", async () => {
    const { page } = await open("/docs#/refunds/refundPayment");
    await page.waitForFunction(() => location.pathname === "/docs/refunds/refund-payment" && location.hash === "");
    expect(await page.locator("h1").textContent()).toContain("Refund a payment");
    const guide = await open("/docs#/g/idempotency");
    await guide.page.waitForFunction(() => location.pathname === "/docs/guides/idempotency");
    // A description's own link written then (`#/webhooks`) goes there too.
    const tag = await open("/docs/payments");
    await tag.page.locator("[data-part='article'] a[href='#/webhooks']").first().click();
    await tag.page.waitForFunction(() => location.pathname === "/docs/webhooks");
  });

  run("guides are pages of their own, with their headings in On this page; the overview is the description, the base URL and authentication", async () => {
    const { page } = await open("/docs/guides/getting-started");
    expect(await page.locator("h1").textContent()).toBe("Take your first payment");
    expect(await page.locator("[data-part='breadcrumb']").textContent()).toBe("Introduction");
    expect(await page.getByRole("navigation", { name: "On this page" }).getByRole("link").allTextContents()).toEqual(["Sandbox"]);
    const overview = await open("/docs");
    const text = ((await overview.page.locator("[data-part='article']").textContent()) ?? "").replace(/\s+/g, " ");
    expect(text).toContain("Base URL");
    expect(text).toContain("Authentication");
    expect(text).not.toContain("Take your first payment"); // no guide inside the overview
    expect(await overview.page.locator("[data-part='breadcrumb']").count()).toBe(0);
  });

  run("shows an operation: parameters with enums and limits, the body, scopes, every response with its error codes and headers", async () => {
    const { page } = await open("/docs/payments/create-payment");
    const create = ((await page.locator("[data-part='article']").textContent()) ?? "").replace(/\s+/g, " ");
    expect(create).toContain("Create a payment");
    expect(create).toContain("POST");
    // The scope it needs, from `security`, with what it means on hover.
    expect(create).toMatch(/Scopes:\s*payments:write/);
    expect(await page.locator("[data-part='scopes'] code", { hasText: "payments:write" }).getAttribute("title")).toBe("Create payments.");
    expect(create).toContain("Idempotency-Key");
    expect(create).toContain("Max length 255");
    expect(create).toContain("3f1c9a7e-5b2d-4e8a-9c41-0d6f2b7a1e55");
    expect(create).toContain("Body");
    expect(create).toContain("application/json");
    expect(create).toMatch(/one_time\s*Paid once\./);
    expect(create).toMatch(/subscription\s*Paid on a schedule\./);
    expect(create).toContain("Minimum 1");
    expect(create).toContain("Maximum 99999999");
    expect(create).toContain("Pattern ^[A-Z]{3}$");
    expect(create).toContain("Max length 500");
    expect(create).toContain("Default true");
    for (const status of ["201", "400", "402", "409"]) expect(create).toContain(status);
    expect(create).toContain("application/problem+json");
    expect(create).toMatch(/card_declined\s*The issuer declined the card\./);
    expect(create).toContain("idempotency_in_progress");
    expect(create).toContain("validation_failed"); // from a response written as a $ref to components.responses
    expect(create).toContain("Idempotent-Replayed");
    expect(create).toContain("Midas-API-Version");
    // A response's headers are folded.
    expect(await page.locator("details.fd-nested", { has: page.locator("summary", { hasText: "Response headers" }) }).first().getAttribute("open")).toBeNull();

    const list = await open("/docs/payments/list-payments");
    const listText = ((await list.page.locator("[data-part='article']").textContent()) ?? "").replace(/\s+/g, " ");
    expect(listText).toContain("Query parameters");
    expect(listText).toMatch(/limit.*integer/s);
    expect(listText).toContain("Default 20");
    expect(listText).toContain("Retry-After");
    expect(listText).toContain("rate_limited");
    expect(listText).toContain("date-time");

    const all = await open("/docs/customers/delete-customer");
    expect(await all.page.locator("[data-part='article']").textContent()).toContain("Deprecated");
    const status = await open("/docs/customers/get-status");
    expect(await status.page.locator("[data-part='article']").textContent()).toContain("No authentication required.");
    const customers = await open("/docs/customers/list-customers");
    const c = ((await customers.page.locator("[data-part='authorizations']").textContent()) ?? "").replace(/\s+/g, " ");
    expect(c).toContain("oauth");
    expect(c).toContain("bearer"); // a second way in
    expect(c).toContain("customers:read");
    const refund = await open("/docs/refunds/refund-payment");
    expect(await refund.page.locator("[data-part='article']").textContent()).toMatch(/refund_exceeds_payment\s*More than the payment's remaining amount\./);
    // The tag's own page: its prose, as Markdown, and its operations.
    const tag = await open("/docs/payments");
    expect(await tag.page.locator("[data-part='article'] strong", { hasText: "payment" }).first().textContent()).toBe("payment");
    expect(await tag.page.locator("[data-part='endpoint-link']").count()).toBe(3);
  });

  run("takes nothing from a description but text, emphasis, code and safe links", async () => {
    const { page, problems } = await open("/docs/customers/list-customers");
    const article = page.locator("[data-part='article']");
    expect(await article.locator("strong", { hasText: "bold" }).count()).toBe(1);
    expect(await article.locator(".fd-md img, .fd-md script").count()).toBe(0);
    expect(await article.locator("a[href^='javascript:']").count()).toBe(0);
    expect(await article.textContent()).toContain('<img src=x onerror="window.__pwned=1">');
    expect(await article.textContent()).toContain("a bad link");
    expect(await win(page, () => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
    expect(problems).toEqual([]);
  });

  run("code samples: the app's own first, generated ones after, credentials as placeholders; a language picked is picked everywhere", async () => {
    pageConfig = SINGLE;
    const { page } = await open("/docs#payments/create-payment");
    const create = op(page, "payments/create-payment");
    const tabs = await create.locator("[role=tab]").allInnerTexts();
    expect(tabs.slice(0, 4)).toEqual(["Midas SDK", "cURL", "Node.js", "Python"]);
    expect(await create.locator(".fd-code pre").first().textContent()).toContain('import { Midas } from "@midas/sdk"');
    await create.getByRole("tab", { name: "cURL" }).first().click();
    const curl = (await create.locator(".fd-code pre").first().textContent())!;
    expect(curl).toContain("curl -X POST 'https://api.midas.test/api/v1/payments'");
    expect(curl).toContain("-H 'Authorization: Bearer YOUR_ACCESS_TOKEN'");
    expect(curl).toContain("-H 'Content-Type: application/json'");
    expect(curl).not.toContain("Idempotency-Key");
    expect(curl).toContain('"amount": 2500');
    await create.getByRole("tab", { name: "Python" }).first().click();
    await page.waitForFunction(() => document.querySelector("[id='payments/create-payment'] .fd-code pre")?.textContent?.includes("import requests"));
    expect(await create.locator(".fd-code pre").first().textContent()).toContain('"amount": 2500,');
    const get = op(page, "payments/get-payment");
    await page.waitForFunction(() => document.querySelector("[id='payments/get-payment'] .fd-code pre")?.textContent?.includes("import requests"));
    expect(await get.locator(".fd-code pre").first().textContent()).toContain("https://api.midas.test/api/v1/payments/pay_01hx9k");
    expect(await create.locator(".fd-code", { has: page.locator(".fd-code-title", { hasText: "Response" }) }).textContent()).toContain('"id": "pay_01hx9k"');
  });

  run("webhooks: the envelope, how to verify, the retry schedule and each event with its payload and example", async () => {
    const { page } = await open("/docs/webhooks");
    const hooks = ((await page.locator("[data-part='article']").textContent()) ?? "").replace(/\s+/g, " ");
    expect(hooks).toContain("sends events to your server");
    for (const header of ["webhook-id", "webhook-timestamp", "webhook-signature"]) expect(hooks).toContain(header);
    expect(hooks).toContain("The event's name, such as payment.succeeded.");
    expect(hooks).toContain("Reject a timestamp older than 5 min");
    expect(hooks).toContain("createHmac");
    expect(hooks).toMatch(/up to 5 s/);
    expect(hooks).toMatch(/up to 20 s/);
    expect(hooks).toMatch(/up to 1 min 20 s/);
    expect(hooks).toContain("up to 21 min 20 s");
    expect(hooks).toContain("within 15 s");
    expect(hooks).toContain("6 attempts");
    const succeeded = await spied(page, "payment-succeeded");
    expect(succeeded).toContain("payment.succeeded");
    expect(succeeded).toContain("A payment went through.");
    expect(await spied(page, "refund-created")).toContain("A refund was made.");
    expect(await page.locator("nav a[href='/docs/webhooks#refund-created']").count()).toBe(1);
  });

  run("models: the named schemas with their attributes, nullable and read-only marks, nested ones opened under their row", async () => {
    const { page } = await open("/docs/models#payment");
    const payment = await spied(page, "payment");
    expect(payment).toContain("Money moving from a customer to you.");
    expect(payment).toMatch(/customer_id\s*string\s*nullable/);
    expect(payment).toMatch(/created_at\s*string\s*required\s*read only/);
    expect(payment).toContain("Child attributes (4)");
    expect(payment).toMatch(/metadata\s*map<string, string>/);
  });

  run("light and dark: follows the system and has an icon toggle that is remembered; the app fixes the mode, the accent, fonts, corners and logo", async () => {
    const light = await open("/docs", { colorScheme: "light" });
    const fd = light.page.locator(".fd");
    expect(await fd.getAttribute("data-mode")).toBe("light");
    const background = () => fd.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await background()).toBe("rgb(246, 244, 239)");
    // An icon in the navigation's footer, by default.
    const toggle = light.page.locator("[data-part='sidebar'] [data-part='theme-toggle']");
    expect(await toggle.locator("svg").count()).toBe(1);
    await toggle.click();
    expect(await fd.getAttribute("data-mode")).toBe("dark");
    expect(await background()).toBe("rgb(12, 12, 13)");
    expect(await win(light.page, () => localStorage.getItem("forge-docs-theme"))).toBe("dark");
    await light.page.reload({ waitUntil: "load" });
    await light.page.waitForSelector(".fd[data-ready]");
    expect(await fd.getAttribute("data-mode")).toBe("dark");

    const dark = await open("/docs", { colorScheme: "dark" });
    expect(await dark.page.locator(".fd").getAttribute("data-mode")).toBe("dark");

    pageConfig = { theme: { mode: "dark", accent: "rgb(10, 125, 90)", font: "Georgia, serif", radius: "0px" }, logo: { url: "/logo.svg", dark: "/logo-dark.svg", alt: "Midas" }, title: "Midas docs" };
    const fixed = await open("/docs/payments/create-payment", { colorScheme: "light" });
    expect(await fixed.page.locator(".fd").getAttribute("data-theme")).toBe("dark");
    expect(await fixed.page.locator("[data-part='theme-toggle']").count()).toBe(0);
    expect(await fixed.page.locator(".fd-try").first().evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(10, 125, 90)");
    expect(await fixed.page.locator(".fd").evaluate((el) => getComputedStyle(el).fontFamily)).toContain("Georgia");
    // The dark logo on dark.
    expect(await fixed.page.locator("[data-part='sidebar'] .fd-logo-dark").isVisible()).toBe(true);
    expect(await fixed.page.locator("[data-part='sidebar'] .fd-logo-light").isVisible()).toBe(false);
    expect(await fixed.page.locator("[data-part='sidebar'] .fd-brand span").textContent()).toBe("Midas docs");
  });

  run("matching another docs site from configuration: a preset, a few tokens, light code on a dark accent, tabs, footer links and only the buttons asked for", async () => {
    pageConfig = {
      title: "Midas",
      logo: { url: "data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2224%22 height=%2224%22/%3E", title: false },
      theme: { preset: "minimal", code: "light", tokens: { accent: "rgb(109, 40, 217)", accentFill: "rgb(109, 40, 217)", bg: { light: "rgb(255, 255, 255)", dark: "rgb(11, 11, 12)" } } },
      layout: { referencePath: "/api" },
      nav: { tabs: [{ label: "Docs", section: "guides" }, { label: "API reference", section: "reference" }, { label: "Changelog", href: "/changelog" }], footer: [{ label: "OpenAPI document", href: "/docs/openapi.json" }, { label: "Dashboard", href: "/" }], groups: { case: "upper" } },
      controls: { authorize: "header", themeToggle: { style: "icon", place: "header" }, devSwitch: false, download: false },
    };
    const { page, problems } = await open("/docs/api/payments/create-payment");
    expect(await page.locator(".fd").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(255, 255, 255)");
    expect(await page.locator("[data-part='brand'] span").count()).toBe(0); // the mark alone
    // Tinted pills (the preset's), the accent on the primary button.
    expect(await page.locator("[data-part='endpoint-bar'] [data-part='method']").evaluate((el) => getComputedStyle(el).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.locator(".fd-try").evaluate((el) => getComputedStyle(el).backgroundColor)).toBe("rgb(109, 40, 217)");
    // Tabs: the reference is current; the navigation shows its pages only.
    const tabs = page.locator("[data-part='tabs'] a");
    expect(await tabs.allTextContents()).toEqual(["Docs", "API reference", "Changelog"]);
    expect(await tabs.nth(1).getAttribute("aria-current")).toBe("page");
    expect(await tabs.nth(0).getAttribute("href")).toBe("/docs/guides/getting-started"); // the first guide is the Docs tab's landing page
    expect(await page.locator("nav[aria-label='API navigation']").textContent()).not.toContain("Idempotency");
    expect(await page.locator(".fd-nav-title").first().evaluate((el) => getComputedStyle(el).textTransform)).toBe("uppercase");
    // Only Authorize and an icon theme button in the header; the footer links in the navigation; no download link, no dev switch.
    const header = page.locator("[data-part='header'] [data-part='actions']");
    expect(await header.locator("button").count()).toBe(2);
    expect(await header.locator("[data-part='authorize']").count()).toBe(1);
    expect(await header.locator("[data-part='theme-toggle'] svg").count()).toBe(1);
    expect(await page.locator("[data-part='footer-links'] a").allTextContents()).toEqual(["OpenAPI document", "Dashboard"]);
    expect(await page.locator("[data-part='download']").count()).toBe(0);
    expect(problems).toEqual([]);
  });

  run("page.css: the app's CSS, from a string, wins over the page's own rules without !important", async () => {
    pageConfig = { css: ".fd [data-part='breadcrumb'] { color: rgb(1, 2, 3); }" };
    const { page } = await open("/docs/payments/create-payment");
    expect(await page.locator("[data-part='breadcrumb']").evaluate((el) => getComputedStyle(el).color)).toBe("rgb(1, 2, 3)");
  });

  run("slots: the app's MDX in the header, the sidebar footer and around every operation", async () => {
    pageConfig = SINGLE;
    const { page, problems } = await open();
    expect(await page.locator(".fd-slot-header a").getAttribute("href")).toBe("https://status.midas.test");
    expect(await page.locator(".fd-slot-footer").textContent()).toContain("Need help? Write to support@midas.test.");
    const ops = await page.locator(".fd-op").count();
    expect(ops).toBe(7);
    await page.waitForFunction((n) => document.querySelectorAll(".slot-before").length === n && document.querySelectorAll(".slot-after").length === n, ops);
    expect(await op(page, "payments/create-payment").locator(".slot-before").textContent()).toBe("Before POST /payments in Payments: createPayment");
    expect(await op(page, "refunds/refund-payment").locator(".slot-after").textContent()).toBe("After refundPayment");
    expect(problems).toEqual([]);
  });

  run("strings: every text can be replaced, and what isn't keeps its English", async () => {
    pageConfig = { strings: { searchPlaceholder: "Buscar", authorize: "Autorizar", tryIt: "Probar", requestBody: "Cuerpo", resultsCount: "{n} resultados", onThisPage: "En esta página" } };
    const { page } = await open("/docs/payments/create-payment");
    expect(await page.getByPlaceholder("Buscar").count()).toBe(1);
    expect(await page.getByRole("button", { name: "Autorizar" }).count()).toBeGreaterThan(0);
    expect(await page.getByRole("button", { name: "Probar" }).count()).toBe(1);
    expect(await page.locator("[data-part='article']").textContent()).toContain("Cuerpo");
    expect(await page.locator("[data-part='article']").textContent()).toContain("Header parameters");
    expect(await page.getByRole("navigation", { name: "En esta página" }).count()).toBe(1);
    await page.getByPlaceholder("Buscar").fill("payment");
    expect(await page.locator(".fd-results").textContent()).toMatch(/\d+ resultados/);
  });

  run("search: operations, guides and webhook events, with Enter to go to the first; hidden when the app asks", async () => {
    const { page } = await open();
    const box = page.getByRole("searchbox", { name: "Search" });
    await box.fill("refund");
    const results = page.locator(".fd-results");
    expect(await results.textContent()).toContain("Refund a payment");
    expect(await results.textContent()).toContain("refund.created");
    await box.fill("idempotent");
    expect(await results.textContent()).toContain("Idempotency");
    await box.fill("zzzz nothing");
    expect(await results.textContent()).toContain("Nothing found");
    await box.fill("refund a pay");
    await box.press("Enter");
    await page.waitForFunction(() => location.pathname === "/docs/refunds/refund-payment");
    expect(await box.inputValue()).toBe("");
    // `/` and Ctrl K focus the search from anywhere.
    await page.locator("main").click();
    await page.keyboard.press("/");
    expect(await win(page, () => document.activeElement?.getAttribute("type"))).toBe("search");

    pageConfig = { hide: { search: true, models: true, webhooks: true, downloadLink: true } };
    const hidden = await open();
    expect(await hidden.page.getByRole("searchbox").count()).toBe(0);
    expect(await hidden.page.locator("nav a[href='/docs/models'], nav a[href='/docs/webhooks']").count()).toBe(0);
    expect(await hidden.page.getByRole("link", { name: "openapi.json" }).count()).toBe(0);
    pageConfig = {};
    const shown = await open();
    expect(await shown.page.getByRole("link", { name: "openapi.json" }).getAttribute("href")).toBe("/docs/openapi.json");
  });

  run("authentication: the schemes the document declares, with the token URL, the scopes and where each is used", async () => {
    pageConfig = { explorer: { auth: { oauth2: { tokenUrl: "https://auth.midas.test/token", extraParams: { resource: "https://api.midas.test/api/v1" } } } } };
    const { page } = await open("/docs#authentication");
    const auth = await text(page, "authentication");
    expect(auth).toContain("Authentication");
    const section = ((await page.locator("[data-part='authentication']").textContent()) ?? "").replace(/\s+/g, " ");
    expect(section).toContain("OAuth 2.0");
    expect(section).toContain("Client credentials");
    expect(section).toContain("https://auth.midas.test/token");
    expect(section).toMatch(/payments:read\s*Read payments\.\s*2 operations/);
    expect(section).toMatch(/refunds:write\s*Refund payments\.\s*1 operation(?!s)/);
    expect(section).toContain("-d 'resource=https://api.midas.test/api/v1'");
    expect(section).toContain("YOUR_CLIENT_ID:YOUR_CLIENT_SECRET");
    expect(section).toContain("X-Midas-Key");
    expect(section).toContain("Authorization: Bearer YOUR_ACCESS_TOKEN");
  });

  run("Authorize: in the header, the navigation, each operation or nowhere; a bearer token is kept for the tab and shown nowhere", async () => {
    const { page } = await open("/docs/customers/list-customers");
    await page.locator("[data-part='header'] [data-part='authorize']").click();
    const dialog = page.getByRole("dialog");
    await dialog.waitFor();
    const bearer = dialog.locator("section", { hasText: "bearer" }).filter({ has: page.getByLabel("Bearer token") });
    await bearer.getByLabel("Bearer token").fill("tok_live_123");
    await bearer.getByRole("button", { name: "Save" }).click();
    expect((await store(page)).bearer).toEqual({ type: "http", token: "tok_live_123" });
    await dialog.getByRole("button", { name: "Close" }).click();
    expect(await page.locator(".fd-dot").count()).toBe(1);
    const samples = await page.locator("pre").allTextContents();
    expect(samples.join("\n")).toContain("YOUR_ACCESS_TOKEN");
    expect(await page.evaluate(() => document.body.textContent)).not.toContain("tok_live_123");
    await page.reload({ waitUntil: "load" });
    await page.waitForSelector(".fd-dot");
    await page.getByRole("button", { name: "Authorize" }).first().click();
    expect(await page.getByLabel("Bearer token").inputValue()).toBe("tok_live_123");
    await page.getByRole("dialog").locator("section", { hasText: "bearer" }).getByRole("button", { name: "Clear" }).click();
    expect((await store(page)).bearer).toBeUndefined();

    for (const [where, inHeader, inSide, inOp] of [["sidebar", 0, 1, 0], ["operation", 0, 0, 1], [false, 0, 0, 0]] as const) {
      pageConfig = { controls: { authorize: where } };
      const p = (await open("/docs/customers/list-customers")).page;
      expect(await p.locator("[data-part='header'] [data-part='authorize']").count()).toBe(inHeader);
      expect(await p.locator("[data-part='sidebar'] [data-part='authorize']").count()).toBe(inSide);
      expect(await p.locator("[data-part='authorizations'] button", { hasText: "Authorize" }).count()).toBe(inOp);
    }
  });

  run("Authorize: client credentials fetch a token from the token URL with Basic first, and again with the secret in the body when refused", async () => {
    pageConfig = { explorer: { auth: { preferredScheme: "oauth", oauth2: { clientId: "demo-client", scopes: ["payments:read"], tokenUrl: `${origin}/token`, extraParams: { resource: "https://api.midas.test/api/v1" } } } } };
    const { page } = await open();
    await page.getByRole("button", { name: "Authorize" }).first().click();
    const dialog = page.getByRole("dialog");
    expect(await dialog.getByLabel("Client ID").inputValue()).toBe("demo-client");
    expect(await dialog.getByRole("checkbox", { name: /payments:read/ }).isChecked()).toBe(true);
    expect(await dialog.getByRole("button", { name: "Get token" }).isDisabled()).toBe(true);
    await dialog.getByLabel("Client secret").fill("s3cret");
    await dialog.getByRole("checkbox", { name: /payments:write/ }).check();
    await dialog.getByRole("button", { name: "Get token" }).click();
    await dialog.getByText("Token active").waitFor();
    expect(tokenRequests).toHaveLength(1);
    expect(tokenRequests[0]!.authorization).toBe(`Basic ${btoa("demo-client:s3cret")}`);
    const form = new URLSearchParams(tokenRequests[0]!.body);
    expect(form.get("grant_type")).toBe("client_credentials");
    expect(form.get("scope")).toBe("payments:read payments:write");
    expect(form.get("resource")).toBe("https://api.midas.test/api/v1");
    expect(form.get("client_secret")).toBeNull();
    const saved = (await store(page)).oauth;
    expect(saved).toMatchObject({ type: "oauth2", clientId: "demo-client", accessToken: "at_1", scopes: ["payments:read", "payments:write"] });

    tokenMode = "post-only";
    tokenRequests.length = 0;
    await dialog.getByRole("button", { name: "Get token" }).click();
    await dialog.getByText("Token active").waitFor();
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("forge-docs:/docs:/docs/openapi.json")!).oauth.accessToken === "at_2");
    expect(tokenRequests).toHaveLength(2);
    expect(tokenRequests[1]!.authorization).toBeNull();
    const post = new URLSearchParams(tokenRequests[1]!.body);
    expect(post.get("client_id")).toBe("demo-client");
    expect(post.get("client_secret")).toBe("s3cret");

    tokenMode = "reject";
    await dialog.getByRole("button", { name: "Clear" }).first().click();
    expect((await store(page)).oauth).toBeUndefined();
    await dialog.getByLabel("Client ID").fill("demo-client");
    await dialog.getByLabel("Client secret").fill("wrong");
    await dialog.getByRole("button", { name: "Get token" }).click();
    expect(await dialog.getByRole("alert").textContent()).toContain("Unknown client");
    expect((await store(page)).oauth).toBeUndefined();
  });

  run("Authorize: with credentials kept in memory, nothing is written to the tab's storage", async () => {
    pageConfig = { credentials: "memory" };
    const { page } = await open();
    await page.getByRole("button", { name: "Authorize" }).first().click();
    const section = page.getByRole("dialog").locator("section", { hasText: "apiKey" });
    await section.getByLabel("API key").fill("key_123");
    await section.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByText("Saved").waitFor();
    expect(await page.evaluate(() => sessionStorage.length)).toBe(0);
    expect(await page.locator(".fd-dot").count()).toBe(1);
  });

  run("Try it: loads the builder when first wanted, mounts it once with the page's state, opens it on the operation, and shares credentials both ways", async () => {
    pageConfig = { explorer: { auth: { preferredScheme: "oauth", oauth2: { clientId: "demo-client" } } }, codeSamples: { languages: ["curl", "go"] }, strings: { searchNone: "Nada", "apiClient.requestBlock.requestBody": "Cuerpo" } };
    const { page, problems } = await open("/docs/payments/create-payment");
    const explorerScripts = () => page.locator("script[src*='/_docs/explorer.js']").count();
    expect(await explorerScripts()).toBe(0);
    const button = page.locator("[data-part='endpoint-bar']").getByRole("button", { name: "Try it" });
    await button.hover();
    expect(await page.locator("link[rel=prefetch][href*='/_docs/explorer.js']").count()).toBe(1);
    expect(await explorerScripts()).toBe(0);
    await page.getByRole("button", { name: "Authorize" }).first().click();
    const section = page.getByRole("dialog").locator("section", { hasText: "apiKey" });
    await section.getByLabel("API key").fill("key_123");
    await section.getByRole("button", { name: "Save" }).click();
    await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();

    await button.click();
    await page.waitForFunction(() => (window as any).__opens?.length === 1);
    expect(await explorerScripts()).toBe(1);
    const mounted = await page.evaluate(() => {
      const o = (window as any).__mounts[0];
      return { title: o.document.info.title, base: o.baseServerUrl, auth: o.auth, languages: o.codeSamples, credentials: o.credentials, theme: o.theme, strings: o.strings, opens: (window as any).__opens };
    });
    expect(mounted.title).toBe("Midas Payments API");
    expect(mounted.base).toBe(origin);
    expect(mounted.auth).toEqual({ preferredScheme: "oauth", oauth2: { clientId: "demo-client" } });
    expect(mounted.languages).toEqual(["curl", "go"]);
    expect(mounted.credentials).toEqual({ apiKey: { type: "apiKey", value: "key_123" } });
    expect(mounted.opens).toEqual([{ path: "/payments", method: "post" }]);
    expect(mounted.theme).toMatchObject({ mode: "light", background: "rgb(246, 244, 239)", text: "rgb(17, 17, 16)", font: expect.stringContaining("Geist") });
    expect(mounted.strings).toEqual({ "apiClient.requestBlock.requestBody": "Cuerpo" });
    expect(await page.locator("body > .forge-docs-explorer").textContent()).toBe("stub explorer");
    expect(await page.locator(".fd .forge-docs-explorer").count()).toBe(0);
    expect(await win(page, () => location.pathname + location.search)).toBe("/docs/payments/create-payment?try");

    // Another operation reuses the same builder.
    await page.locator("[data-part='nav'] a[href='/docs/payments/get-payment']").click();
    await page.waitForFunction(() => location.pathname === "/docs/payments/get-payment");
    await page.locator("[data-part='endpoint-bar']").getByRole("button", { name: "Try it" }).click();
    await page.waitForFunction(() => (window as any).__opens.length === 2);
    expect(await win(page, () => (window as any).__mounts.length)).toBe(1);
    expect(await win(page, () => (window as any).__opens[1])).toEqual({ path: "/payments/{paymentId}", method: "get" });

    await page.evaluate(() => (window as any).__mounts[0].onCredentials({ apiKey: { type: "apiKey", value: "key_123" }, oauth: { type: "oauth2", accessToken: "from-builder", expiresAt: Date.now() + 600_000 } }));
    await page.waitForFunction(() => JSON.parse(sessionStorage.getItem("forge-docs:/docs:/docs/openapi.json")!).oauth?.accessToken === "from-builder");

    // The theme follows the page's toggle.
    const before = (await win(page, () => (window as any).__updates.length)) as number;
    await page.locator("[data-part='theme-toggle']").click();
    await page.waitForFunction((n) => (window as any).__updates.slice(n).some((u: any) => u.theme?.mode === "dark" && u.theme.background === "rgb(12, 12, 13)"), before);

    // The visitor closes the builder: the address loses `?try` and focus goes back to the button that opened it.
    await page.evaluate(() => (window as any).__instances[0].onClose());
    expect(await win(page, () => location.search)).toBe("");
    expect(await win(page, () => location.pathname)).toBe("/docs/payments/get-payment");
    expect(await win(page, () => document.activeElement?.textContent)).toBe("Try it");
    expect(await win(page, () => (window as any).__closes)).toBe(0);
    expect(problems).toEqual([]);
  });

  run("Try it: an address opens the builder on its operation, with ?try, or at the explorer path with ?op", async () => {
    const a = await open("/docs/refunds/refund-payment?try");
    await a.page.waitForFunction(() => (window as any).__opens?.length === 1);
    expect(await win(a.page, () => (window as any).__opens[0])).toEqual({ path: "/payments/{paymentId}/refunds", method: "post" });

    const b = await open("/docs/explorer?op=getPayment");
    await b.page.waitForFunction(() => (window as any).__opens?.length === 1);
    expect(await win(b.page, () => (window as any).__opens[0])).toEqual({ path: "/payments/{paymentId}", method: "get" });
    await b.page.waitForFunction(() => location.pathname === "/docs/payments/get-payment");

    const c = await open("/docs/explorer");
    await c.page.waitForFunction(() => (window as any).__opens?.length === 1);
    expect(await win(c.page, () => (window as any).__opens[0])).toEqual({ path: "/payments", method: "get" });

    const d = await open("/docs");
    expect(await win(d.page, () => (window as any).__mounts)).toBeUndefined();
  });

  run("Try it: off when the app turns it off; a builder that won't load says so and can be tried again", async () => {
    pageConfig = { explorer: false };
    const off = await open("/docs/payments/create-payment?try");
    expect(await off.page.getByRole("button", { name: "Try it" }).count()).toBe(0);
    expect(await off.page.locator("script[src*='explorer.js']").count()).toBe(0);

    pageConfig = {};
    explorerStatus = 500;
    const { page } = await open("/docs/payments/get-payment");
    await page.getByRole("button", { name: "Try it" }).click();
    const alert = page.locator(".fd-toast");
    await alert.waitFor();
    expect(await alert.textContent()).toContain("The request builder didn't load");
    explorerStatus = 200;
    await alert.getByRole("button", { name: "Try again" }).click();
    await page.waitForFunction(() => (window as any).__opens?.length === 1);
    expect(await page.locator(".fd-toast").count()).toBe(0);
  });

  run("Try it with the real request builder (the vendored fork of Scalar): its modal opens on the operation, over the page, and the page's own styles stay out of it", async () => {
    realExplorer = true;
    const { page } = await open("/docs/payments/get-payment");
    await page.addStyleTag({ content: "@layer forge-docs{button{border:3px solid lime}} " });
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.getByRole("button", { name: "Try it" }).click();
    const modal = page.locator("[role=dialog]");
    await modal.waitFor({ state: "visible", timeout: 30_000 });
    await modal.getByRole("heading", { name: "Retrieve a payment" }).waitFor({ timeout: 15_000 });
    expect(await modal.textContent()).toContain("paymentId");
    const script = requests.find((u) => u.includes("/_docs/explorer.js"))!;
    expect(requests).toContain(script.replace("explorer.js", "explorer.css"));
    expect(await modal.locator("button").evaluateAll((els) => els.filter((e) => getComputedStyle(e).borderTopColor === "rgb(0, 255, 0)").length)).toBe(0);
    await page.keyboard.press("Escape");
    await modal.waitFor({ state: "hidden", timeout: 5_000 });
    await page.waitForFunction(() => location.search === "");
    const again = await open("/docs/explorer?op=refundPayment");
    await again.page.locator("[role=dialog]").getByRole("heading", { name: "Refund a payment" }).waitFor({ timeout: 30_000 });
  });

  run("development: a switch to the complete document, with what the public one leaves out marked, and the guide to /rpc when there are functions", async () => {
    dev = true;
    const { page } = await open();
    expect(await page.locator("nav a[href='/docs/customers/ping']").count()).toBe(0);
    expect(await page.locator("nav a[href='/docs/guides/functions']").count()).toBe(0);
    await page.getByRole("checkbox", { name: "Show everything" }).check();
    await page.waitForSelector("nav a[href='/docs/customers']");
    await page.locator("nav a[href='/docs/customers']").click();
    await page.waitForSelector("nav a[href='/docs/customers/ping']");
    expect(await page.locator("nav a[href='/docs/customers/ping']").textContent()).toContain("Internal");
    expect(await win(page, () => location.search)).toBe("?audience=all");
    expect(await page.getByRole("link", { name: "openapi.json" }).getAttribute("href")).toBe("/docs/openapi.json?audience=all");
    expect(await page.getByRole("navigation").getByText("Calling functions").count()).toBe(1);
    // The switch can be hidden.
    pageConfig = { controls: { devSwitch: false } };
    expect(await (await open()).page.getByRole("checkbox", { name: "Show everything" }).count()).toBe(0);
    dev = false;
    pageConfig = {};
    expect(await (await open()).page.getByRole("checkbox", { name: "Show everything" }).count()).toBe(0);
  });

  run("a guide uses Callout, Tabs, Steps, Cards, CodeGroup, Accordion, titled code blocks and the app's own components; one that doesn't compile shows its error and the page goes on", async () => {
    const { page, problems } = await open("/docs/guides/changelog");
    const article = page.locator("[data-part='article']");
    expect(await article.locator("[data-part='callout'][data-kind='tip']").textContent()).toContain("Breaking changes are announced");
    const tabs = article.locator("[data-part='tabs']");
    expect(await tabs.getByRole("tab").allTextContents()).toEqual(["Node", "Python"]);
    await tabs.getByRole("tab", { name: "Python" }).click();
    expect(await tabs.getByRole("tabpanel").filter({ hasNot: page.locator("[hidden]") }).first().textContent()).toContain("pip install");
    expect(await win(page, () => localStorage.getItem("forge-docs-tabs:Node|Python"))).toBe("Python"); // remembered
    expect(await article.locator("[data-part='steps'] li").count()).toBe(2);
    expect(await article.locator("[data-part='card']").count()).toBe(2);
    expect(await article.locator("[data-part='code-group'] [role=tab]").allTextContents()).toEqual(["server.ts", "server.py"]);
    expect(await article.locator("[data-part='code-block'] .fd-mdx-code-title").first().textContent()).toBe("install.sh");
    expect(await article.locator("[data-part='accordion'] summary").textContent()).toBe("Why version?");
    expect(await article.locator("[data-badge]").textContent()).toBe("beta"); // forge/docs/_components/Badge.tsx
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// The pure parts: what the page makes of a schema, a description and an operation, and the token request.

const fixture = doc as unknown as OpenApi;
const schemas: OpenApi = {
  info: { title: "t", version: "1" },
  components: {
    schemas: {
      Node: { type: "object", properties: { name: { type: "string" }, next: { $ref: "#/components/schemas/Node" }, id: { type: "string", readOnly: true } } },
      Base: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      Named: { allOf: [{ $ref: "#/components/schemas/Base" }, { type: "object", required: ["name"], properties: { name: { type: "string", maxLength: 40 } } }] },
      Cat: { type: "object", title: "Cat", properties: { lives: { type: "integer" } } },
      Dog: { type: "object", title: "Dog", properties: { barks: { type: "boolean" } } },
    },
  },
};
const info = (schema: object, seen: string[] = []) => describeSchema(schemas, schema as Schema, seen);

describe("what the page makes of a schema", () => {
  test("types, nullable in all its spellings, enums with their notes, constraints", () => {
    expect(info({ anyOf: [{ type: "string" }, { type: "null" }] })).toMatchObject({ type: "string", nullable: true });
    expect(info({ type: ["integer", "null"], minimum: 1, exclusiveMaximum: 10, multipleOf: 3 })).toMatchObject({ type: "integer", nullable: true, constraints: [["minimum", "1"], ["exclusiveMaximum", "10"], ["multipleOf", "3"]] });
    expect(info({ type: "string", nullable: true }).nullable).toBe(true); // OpenAPI 3.0
    expect(info({ type: "integer", minimum: 0, exclusiveMinimum: true }).constraints).toEqual([["exclusiveMinimum", "0"]]); // 3.0 wrote it beside minimum
    expect(info({ type: "string", format: "email", minLength: 3, maxLength: 9, pattern: "^a" }).constraints).toEqual([["format", "email"], ["minLength", "3"], ["maxLength", "9"], ["pattern", "^a"]]);
    expect(info({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 5, uniqueItems: true })).toMatchObject({ type: "array<string>", constraints: [["minItems", "1"], ["maxItems", "5"], ["uniqueItems", "true"]] });
    expect(info({ type: "object", additionalProperties: { type: "integer" } }).type).toBe("map<string, integer>");
    expect(info({ type: "string", enum: ["a", "b"], "x-enumDescriptions": ["First", "Second"] }).enumValues).toEqual([{ value: "a", description: "First" }, { value: "b", description: "Second" }]);
    expect(info({ enum: ["a", "b"], "x-enumDescriptions": { b: "Only b" } }).enumValues).toEqual([{ value: "a", description: undefined }, { value: "b", description: "Only b" }]);
    expect(info({ const: "payment.succeeded" })).toMatchObject({ type: "string", enumValues: [{ value: "payment.succeeded" }] });
    expect(info({ type: "string", default: "x", example: "y" })).toMatchObject({ hasDefault: true, default: "x", hasExample: true, example: "y" });
    expect(info({ oneOf: [{ $ref: "#/components/schemas/Cat" }, { $ref: "#/components/schemas/Dog" }] })).toMatchObject({ type: "Cat | Dog", children: { kind: "variants" } });
    expect(info({})).toMatchObject({ type: "any", nullable: false });
  });

  test("references and allOf are followed, and a schema that contains itself stops", () => {
    const named = info({ $ref: "#/components/schemas/Named" });
    expect(named.name).toBe("Named");
    expect(named.children).toMatchObject({ kind: "props", required: new Set(["id", "name"]) });
    expect((named.children as { props: [string, unknown][] }).props.map(([k]) => k)).toEqual(["id", "name"]);
    const node = info({ $ref: "#/components/schemas/Node" });
    const next = (node.children as { props: [string, object][] }).props.find(([k]) => k === "next")![1];
    expect(info(next, node.seen).name).toBe("Node");
    expect(node.seen).toContain("Node"); // the page sees the name is already open and stops there
    // A union with null is its other member, still named.
    expect(info({ anyOf: [{ $ref: "#/components/schemas/Cat" }, { type: "null" }] })).toMatchObject({ name: "Cat", nullable: true, type: "Cat" });
  });

  test("examples fit the schema: its own example first, else its limits and format; read-only fields only in answers", () => {
    const e = (s: object, mode?: "request" | "response") => exampleOf(schemas, s as Schema, mode);
    expect(e({ type: "string", example: "given" })).toBe("given");
    expect(e({ type: "string", enum: ["x", "y"] })).toBe("x");
    expect(e({ type: "integer", minimum: 5, maximum: 9 })).toBe(5);
    expect(e({ type: "integer", exclusiveMinimum: 5 })).toBe(6);
    expect(e({ type: "number", maximum: 0.5 })).toBe(0.5);
    expect(e({ type: "integer", multipleOf: 25, minimum: 10 })).toBe(25);
    expect(e({ type: "string", format: "date-time" })).toBe("2026-01-15T10:30:00Z");
    expect(e({ type: "string", maxLength: 3 })).toBe("str");
    expect(e({ type: "string", pattern: "^users:" })).toMatch(/^users:/);
    expect(e({ anyOf: [{ type: "null" }, { type: "boolean" }] })).toBe(true);
    expect(e({ type: "array", items: { type: "string", format: "email" } })).toEqual(["user@example.com"]);
    expect(e({ $ref: "#/components/schemas/Named" })).toEqual({ id: "string", name: "string" });
    expect(e({ $ref: "#/components/schemas/Node" }, "request")).toEqual({ name: "string" }); // `id` is read-only, `next` would be the schema again
    expect(e({ $ref: "#/components/schemas/Node" }, "response")).toEqual({ name: "string", id: "string" });
    expect(JSON.stringify(e({ type: "object", properties: { a: { $ref: "#/components/schemas/Node" } }, required: ["a"] }))).toContain('"name":"string"'); // terminates
  });
});

describe("Markdown from the document", () => {
  const md = (text: string, headings?: number) => renderToString(createElement(Markdown, { text, headings }));

  test("renders a safe subset and escapes the rest", () => {
    expect(md("**bold**, __strong__, *it*, _em_, ~~gone~~ and `a < b`")).toBe("<div class=\"fd-md\"><p><strong>bold</strong>, <strong>strong</strong>, <em>it</em>, <em>em</em>, <del>gone</del> and <code>a &lt; b</code></p></div>");
    expect(md("snake_case_name and window.__x = 1 and 2 * 3 * 4")).toBe('<div class="fd-md"><p>snake_case_name and window.__x = 1 and 2 * 3 * 4</p></div>');
    expect(md('<script>alert(1)</script> <img src=x onerror="y"> &lt;')).not.toMatch(/<script|<img/);
    expect(md('<b>x</b>')).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(md("# Title\n\n## Sub", 4)).toBe('<div class="fd-md"><h4>Title</h4><h5>Sub</h5></div>');
    expect(md("###### deep", 5)).toContain("<h6>");
    expect(md("- one\n- two\n  - nested\n\n1. first\n2. second")).toBe('<div class="fd-md"><ul><li><p>one</p></li><li><p>two</p><ul><li><p>nested</p></li></ul></li></ul><ol><li><p>first</p></li><li><p>second</p></li></ol></div>');
    expect(md("```ts\nconst a = <b>;\n```")).toBe('<div class="fd-md"><pre><code class="language-ts">const a = &lt;b&gt;;</code></pre></div>');
    expect(md("> quoted\n\n---")).toBe('<div class="fd-md"><blockquote><p>quoted</p></blockquote><hr/></div>');
    expect(md("| a | b |\n|---|:-:|\n| 1 | `x\\|y` |")).toContain("<th>a</th><th>b</th></tr></thead><tbody><tr><td>1</td><td><code>x|y</code></td>");
    expect(md("line one  \nline two")).toContain("line one<br/>line two");
    expect(md("")).toBe("");
    expect(md("   \n")).toBe("");
  });

  test("links: http, https, mailto and addresses without a scheme only", () => {
    expect(md("[x](https://a.test/p?q=1&r=2)")).toContain('<a href="https://a.test/p?q=1&amp;r=2" target="_blank" rel="noopener noreferrer">x</a>');
    expect(md("[x](#/payments/createPayment) [y](/docs/other) [z](mailto:a@b.test) <https://a.test>")).toMatch(/href="#\/payments\/createPayment">x<\/a> <a href="\/docs\/other">y.*mailto:a@b.test.*<a href="https:\/\/a.test"/);
    for (const bad of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", " javascript:alert(1)", "data:text/html;base64,AAAA", "vbscript:x", "file:///etc/passwd"]) {
      expect(safeUrl(bad), bad).toBe(false);
      expect(md(`[click](${bad.trim()})`), bad).toBe('<div class="fd-md"><p>click</p></div>');
    }
    expect(safeUrl("relative/path")).toBe(true);
  });
});

describe("the operation as a request", () => {
  const model = arrange(fixture, "Other", "More");
  const entry = (id: string) => model.ops.find((o) => o.operationId === id)!;

  test("the document is arranged by its tag groups, ids stay unique and a tag can't take a section's id", () => {
    expect(model.groups.map((g) => [g.name, g.tags.map((t) => t.title)])).toEqual([["Core resources", ["Payments", "Refunds"]], ["People", ["Customers"]]]);
    expect(model.ops.map((o) => o.id)).toEqual(["/payments/listPayments", "/payments/createPayment", "/payments/getPayment", "/refunds/refundPayment", "/customers/listCustomers", "/customers/deleteCustomer", "/customers/getStatus"]);
    expect(model.webhooks.map((w) => [w.id, w.name])).toEqual([["/webhooks/payment-succeeded", "payment.succeeded"], ["/webhooks/refund-created", "refund.created"]]);
    expect(model.models.map((m) => m.id)).toContain("/models/payment");
    expect(model.hasRpc).toBe(false);
    const odd = arrange({ info: { title: "t", version: "1" }, paths: { "/a": { get: { operationId: "x", tags: ["Webhooks"] } }, "/b": { get: { operationId: "x", tags: ["Webhooks"] }, post: {} }, "/c": { get: { tags: ["Models"] } } } } as OpenApi, "Other", "More");
    expect(odd.groups[0]!.tags.map((t) => t.id)).toEqual(["/webhooks-", "/other", "/models-"]);
    expect(odd.ops.map((o) => o.id)).toEqual(["/webhooks-/x", "/webhooks-/x-2", "/other/post-b", "/models-/get-c"]);
    expect(odd.groups[0]!.name).toBeNull(); // no tag groups: one unnamed
  });

  test("cURL: placeholders for credentials, the operation's own example as the body, required headers and the server from the document", () => {
    expect(curl(buildRequest(fixture, entry("refundPayment"), "http://page.test"))).toBe(
      ["curl -X POST 'https://api.midas.test/api/v1/payments/pay_01hx9k/refunds'", "  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'", "  -H 'Content-Type: application/json'", `  -d '{"amount":1,"reason":"duplicate"}'`].join(" \\\n"),
    );
    expect(curl(buildRequest(fixture, entry("listPayments"), ""))).toBe(["curl -X GET 'https://api.midas.test/api/v1/payments?created_after=2026-01-01T00%3A00%3A00Z'", "  -H 'Authorization: Bearer YOUR_ACCESS_TOKEN'"].join(" \\\n"));
    expect(curl(buildRequest(fixture, entry("getStatus"), ""))).toBe("curl -X GET 'https://api.midas.test/api/v1/status'"); // `security: []`
    // Without servers the page's own origin, an API key where the scheme says, Basic as -u.
    const open: OpenApi = {
      info: { title: "t", version: "1" },
      components: { securitySchemes: { key: { type: "apiKey", in: "query", name: "k" }, basic: { type: "http", scheme: "basic" } } },
      paths: { "/a": { get: { operationId: "a", security: [{ key: [] }], responses: {} } }, "/b": { post: { operationId: "b", security: [{ basic: [] }], requestBody: { content: { "application/x-www-form-urlencoded": { example: { a: "1 2", b: true } } } }, responses: {} } } },
    };
    const m = arrange(open, "Other", "More");
    expect(curl(buildRequest(open, m.ops[0]!, "http://page.test"))).toBe("curl -X GET 'http://page.test/a?k=YOUR_API_KEY'");
    expect(curl(buildRequest(open, m.ops[1]!, "http://page.test"))).toBe(["curl -X POST 'http://page.test/b'", "  -u 'YOUR_USERNAME:YOUR_PASSWORD'", "  -H 'Content-Type: application/x-www-form-urlencoded'", "  --data-urlencode 'a=1 2'", "  --data-urlencode 'b=true'"].join(" \\\n"));
  });

  test("every language: the same request, with the credentials left as placeholders", () => {
    const body = { ok: true, none: null, list: [1, "it's"], nested: { s: 'a"b' } };
    const r = { method: "POST", url: "https://api.test/v1/x", headers: [["Authorization", "Bearer YOUR_ACCESS_TOKEN"], ["Content-Type", "application/json"]] as [string, string][], body: { kind: "json" as const, value: body, text: JSON.stringify(body, null, 2) } };
    expect(generate("node", r)).toContain('const response = await fetch("https://api.test/v1/x", {');
    expect(generate("node", r)).toContain('"Authorization": "Bearer YOUR_ACCESS_TOKEN",');
    expect(generate("python", r)).toContain('"ok": True,');
    expect(generate("python", r)).toContain('"none": None,');
    expect(generate("python", r)).toContain("import requests");
    expect(generate("go", r)).toContain('req, _ := http.NewRequest("POST", "https://api.test/v1/x", strings.NewReader(`');
    expect(generate("go", r)).toContain('req.Header.Set("Content-Type", "application/json")');
    expect(generate("php", r)).toContain("CURLOPT_CUSTOMREQUEST => 'POST',");
    expect(generate("php", r)).toContain("it\\'s");
    expect(generate("ruby", r)).toContain("Net::HTTP::Post.new(uri)");
    expect(generate("java", r)).toContain('.header("Authorization", "Bearer YOUR_ACCESS_TOKEN")');
    expect(generate("csharp", r)).toContain('new HttpMethod("POST")');
    expect(generate("csharp", r)).toContain('a\\""b'); // a verbatim string: the quote JSON escaped, then doubled
    expect(generate("curl", r)).toContain("-H 'Authorization: Bearer YOUR_ACCESS_TOKEN'");
    for (const lang of ["node", "python", "go", "php", "ruby", "java", "csharp", "curl"] as const) expect(generate(lang, { method: "GET", url: "https://api.test/", headers: [] }), lang).toContain("https://api.test/");
  });
});

describe("the token request", () => {
  const respond = (status: number, body: object) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const request = { tokenUrl: "https://auth.test/token", clientId: "id", clientSecret: "se/cret+1", scopes: ["a:read", "b:write"], extra: { resource: "https://api.test" } };

  test("client_secret_basic first, with the credentials form-encoded as RFC 6749 says, and the scopes and extra fields in the body", async () => {
    const seen: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (url: string, init: RequestInit) => (seen.push({ url, init }), respond(200, { access_token: "tok", expires_in: 60 }))) as unknown as typeof fetch;
    const before = Date.now();
    const token = await fetchToken(request, fetcher);
    expect(token.accessToken).toBe("tok");
    expect(token.expiresAt).toBeGreaterThanOrEqual(before + 60_000);
    expect(seen).toHaveLength(1);
    const headers = seen[0]!.init.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa("id:se%2Fcret%2B1")}`);
    expect(seen[0]!.init).toMatchObject({ method: "POST", credentials: "omit", cache: "no-store" });
    expect(Object.fromEntries(seen[0]!.init.body as URLSearchParams)).toEqual({ grant_type: "client_credentials", scope: "a:read b:write", resource: "https://api.test" });
  });

  test("the secret goes in the body when the server refuses Basic; a refusal is an error with the server's words", async () => {
    const calls: RequestInit[] = [];
    const picky = (async (_url: string, init: RequestInit) => (calls.push(init), (init.headers as Record<string, string>).authorization ? respond(401, { error: "invalid_client" }) : respond(200, { access_token: "tok2" }))) as unknown as typeof fetch;
    const token = await fetchToken(request, picky);
    expect(token.accessToken).toBe("tok2");
    expect(token.expiresAt).toBeGreaterThan(Date.now() + 3_000_000); // no expires_in: an hour
    expect(calls).toHaveLength(2);
    expect(Object.fromEntries(calls[1]!.body as URLSearchParams)).toMatchObject({ client_id: "id", client_secret: "se/cret+1" });
    expect((calls[1]!.headers as Record<string, string>).authorization).toBeUndefined();

    const badRequest = (async () => respond(400, { error: "invalid_scope", error_description: "Unknown scope b:write" })) as unknown as typeof fetch; // not about the client: no second try
    await expect(fetchToken(request, badRequest)).rejects.toThrow("Unknown scope b:write");
    let n = 0;
    const down = (async () => (n++, new Response("oops", { status: 502, statusText: "Bad Gateway" }))) as unknown as typeof fetch;
    await expect(fetchToken(request, down)).rejects.toThrow("502 Bad Gateway");
    expect(n).toBe(1);
  });
});

describe("the component for full-stack apps", () => {
  test("renders on a server: the whole reference is in the HTML, nothing reads window", () => {
    expect(typeof window).toBe("undefined");
    const Page = () => createElement("p", { className: "my-guide" }, "Our own page");
    const html = renderToString(createElement(ApiReference, { document: doc as never, explorerUrl: null, config: { theme: { accent: "#0a7d5a" } }, className: "mine", guides: [{ slug: "mine", title: "Mine", group: "Ours", content: Page }] }));
    expect(html).toContain("Our own page"); // the app's own pages are in the server's HTML too
    expect(html).toContain('class="fd fd-embed mine"');
    expect(html).toContain("Midas Payments API");
    expect(html).toContain("Create a payment");
    expect(html).toContain("one_time");
    expect(html).toContain("--fd-accent:#0a7d5a");
    expect(html).not.toContain("Loading");
    expect(html).not.toContain("fd-try"); // no builder URL, no button
    expect(html).not.toContain("fd-builder");
    // With only a URL, the server renders the shell and the browser fetches the document.
    expect(renderToString(createElement(ApiReference, { openapiUrl: "/_api/openapi.json" }))).toContain("Loading");
  });

  run("hydrates what the server rendered without a mismatch, works, and leaves the page around it alone", async () => {
    const built = await Bun.build({ entrypoints: [join(FIXTURES, "embed.tsx")], target: "browser", minify: true, define: { "process.env.NODE_ENV": '"production"' } });
    expect(built.success, built.logs.join("\n")).toBe(true);
    const files = new Map<string, Blob>();
    for (const out of built.outputs) files.set(`/${out.path.split("/").pop()}`, out);
    const css = [...files.keys()].find((k) => k.endsWith(".css"))!;
    const js = [...files.keys()].find((k) => k.endsWith(".js"))!;
    const html = `<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${css}"><style>body{margin:0;background:#fff}</style></head><body><h1 id="host">The host app</h1><a id="host-link" href="/x">a link</a><div id="root">${renderToString(createElement(ApiReference, { document: doc as never, explorerUrl: null }))}</div><script type="module" src="${js}"></script></body></html>`;
    const host = Bun.serve({ port: 0, fetch: (req) => (files.get(new URL(req.url).pathname) ? new Response(files.get(new URL(req.url).pathname)!) : new Response(html, { headers: { "content-type": "text/html" } })) });
    try {
      const context = await browser!.newContext({ viewport: { width: 1280, height: 800 }, colorScheme: "light" });
      contexts.push(context);
      const page = await context.newPage();
      const problems: string[] = [];
      page.on("console", (m) => ["error", "warning"].includes(m.type()) && problems.push(m.text()));
      page.on("pageerror", (e) => problems.push(e.message));
      const hostStyle = () => page.evaluate(() => ({ h1: getComputedStyle(document.getElementById("host")!).fontSize, link: getComputedStyle(document.getElementById("host-link")!).color, body: getComputedStyle(document.body).backgroundColor, family: getComputedStyle(document.body).fontFamily }));
      await page.goto(`http://localhost:${host.port}/`, { waitUntil: "load" });
      const before = await hostStyle();
      await page.waitForFunction(() => !!(window as any).__errors);
      await page.getByRole("button", { name: "Dark" }).click(); // interactive after hydration
      expect(await page.locator(".fd").getAttribute("data-theme")).toBe("dark");
      await page.getByRole("searchbox").fill("refund");
      expect(await page.locator(".fd-results").textContent()).toContain("Refund a payment");
      expect(await win(page, () => (window as any).__errors)).toEqual([]);
      expect(problems).toEqual([]);
      // The component's styles stop at the component.
      const after = await hostStyle();
      expect(after).toEqual(before);
      expect(after).toMatchObject({ h1: "32px", body: "rgb(255, 255, 255)", link: "rgb(0, 0, 238)" });
    } finally {
      await host.stop(true);
    }
  });
});
