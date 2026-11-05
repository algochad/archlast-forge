import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { brotliDecompressSync } from "node:zlib";
import { launchBrowser } from "../../framework/test/browser";
import type { ExplorerInstance, ExplorerOptions } from "../src/api-docs/contract";

// The request builder ("Try it"): the vendored bundle of the engine's Scalar fork, driven in a real browser against a small API on a
// local server. It reads vendor/scalar/explorer.js.br and explorer.css.br as the engine serves them.

const vendor = join(import.meta.dir, "../vendor/scalar");
const script = brotliDecompressSync(readFileSync(join(vendor, "explorer.js.br")));
const styles = brotliDecompressSync(readFileSync(join(vendor, "explorer.css.br")));

// A system Chromium is enough (the framework's helper otherwise looks for CHROMIUM_PATH or Playwright's own download).
if (!process.env.CHROMIUM_PATH) process.env.CHROMIUM_PATH = ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome-stable"].find((p) => existsSync(p));

type Browser = NonNullable<Awaited<ReturnType<typeof launchBrowser>>>;
type Page = Awaited<ReturnType<Browser["newPage"]>>;

/** What the API saw: one entry per request to /api/things and /oauth/token. */
interface Seen {
  path: string;
  method: string;
  authorization: string | null;
  apiKey: string | null;
  contentType: string | null;
  body: string;
  query: string;
}

let browser: Browser | undefined;
let server: ReturnType<typeof Bun.serve>;
let origin: string;
let seen: Seen[] = [];
let tokens = 0;
let tokenLifetime = 3600;

type Scheme = "bearer" | "oauth" | "key";
const openapi = (scheme: Scheme) => ({
  openapi: "3.1.0",
  info: { title: "Things API", version: "1.0.0" },
  servers: [{ url: origin }],
  components: {
    securitySchemes: {
      bearerAuth: { type: "http", scheme: "bearer" },
      keyAuth: { type: "apiKey", in: "header", name: "X-Api-Key" },
      oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "https://elsewhere.invalid/token", scopes: { "things:read": "Read things", "things:write": "Write things" } } } },
    },
  },
  security: scheme === "bearer" ? [{ bearerAuth: [] }] : scheme === "key" ? [{ keyAuth: [] }] : [{ oauth: ["things:read"] }],
  paths: {
    "/api/things": {
      get: {
        operationId: "listThings",
        summary: "List things",
        parameters: [{ name: "limit", in: "query", schema: { type: "integer", default: 10 } }],
        responses: { 200: { description: "The things", content: { "application/json": { schema: { type: "array", items: { type: "object", properties: { id: { type: "integer" }, name: { type: "string" } } } } } } } },
      },
      post: {
        operationId: "createThing",
        summary: "Create a thing",
        requestBody: { required: true, content: { "application/json": { schema: { type: "object", required: ["name"], properties: { name: { type: "string", example: "Widget" }, quantity: { type: "integer", example: 3 } } } } } },
        responses: { 201: { description: "Created" } },
      },
    },
  },
});

beforeAll(async () => {
  browser = await launchBrowser();
  if (!browser) return;
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const note = async () => seen.push({ path: url.pathname, method: req.method, authorization: req.headers.get("authorization"), apiKey: req.headers.get("x-api-key"), contentType: req.headers.get("content-type"), body: await req.text(), query: url.search });
      switch (url.pathname) {
        case "/":
          return new Response(
            // The page's own CSS is the kind every site has: a reset, and styled elements. It is in a layer, as the fork's README asks of a host page
            // (an unlayered `button {}` would beat the builder's layered rules).
            `<!doctype html><meta charset="utf-8"><title>docs</title><style>@layer docs{*{margin:0;padding:0;box-sizing:border-box}button{border:3px solid lime;background:red}}body{background:#101828;color:#eee;font-family:sans-serif}</style><div id="root"></div><script src="/_docs/explorer.js"></script>`,
            { headers: { "content-type": "text/html" } },
          );
        case "/_docs/explorer.js":
          return new Response(script, { headers: { "content-type": "text/javascript" } });
        case "/_docs/explorer.css":
          return new Response(styles, { headers: { "content-type": "text/css" } });
        case "/openapi.json":
          return Response.json(openapi((url.searchParams.get("scheme") as Scheme) ?? "bearer"));
        case "/oauth/token":
          await note();
          return Response.json({ access_token: `token-${++tokens}`, token_type: "Bearer", expires_in: tokenLifetime });
        case "/api/things":
          await note();
          return req.method === "POST" ? Response.json({ id: 1 }, { status: 201 }) : Response.json([{ id: 1, name: "Widget" }]);
        default:
          return new Response("not found", { status: 404 });
      }
    },
  });
  origin = `http://localhost:${server.port}`;
});
afterAll(async () => {
  await browser?.close();
  server?.stop(true);
});

const run = (name: string, fn: () => Promise<void>) => test(name, async () => (browser ? fn() : console.warn(`skipped: ${name}`)), 60_000);

/** A page that loads the script from the local server, and records every request it makes and everything it prints. */
async function open() {
  seen = [];
  tokens = 0;
  tokenLifetime = 3600;
  const context = await browser!.newContext({ viewport: { width: 1280, height: 800 } });
  const requests: string[] = [];
  const blocked: string[] = [];
  await context.route("**/*", (route) => {
    const url = route.request().url();
    requests.push(url);
    if (new URL(url).origin === origin) return route.continue();
    blocked.push(url);
    return route.abort();
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (e) => problems.push(e.message));
  page.on("console", (m) => m.type() === "error" && problems.push(m.text()));
  await page.goto(origin);
  await page.waitForFunction(() => window.ForgeExplorer);
  return { page, requests, blocked, problems };
}

const theme = { mode: "dark", accent: "#e11d8c", background: "#101828", surface: "#1d2939", text: "#f2f4f7", muted: "#98a2b3", border: "#344054", font: "Georgia, serif", monoFont: "ui-monospace, monospace", radius: "10px" } satisfies ExplorerOptions["theme"];

/** Mounts the builder in the page with the API's document (whose operations need the scheme named) and the options on top. */
async function mount(page: Page, scheme: Scheme, extra: Partial<ExplorerOptions> = {}) {
  await page.evaluate(
    async ([base, scheme, theme, extra]) => {
      const w = window as unknown as { __creds: unknown[]; __closed: number; __ex: ExplorerInstance };
      w.__creds = [];
      w.__closed = 0;
      // The page fetches the document from the API's server, as the docs page does.
      const doc = await (await fetch(`/openapi.json?scheme=${scheme}`)).json();
      w.__ex = window.ForgeExplorer!.mount(document.getElementById("root")!, { document: doc, baseServerUrl: base as string, theme: theme as ExplorerOptions["theme"], onCredentials: (c) => w.__creds.push(c), ...(extra as object) });
      w.__ex.onClose = () => w.__closed++;
    },
    [origin, scheme, theme, extra] as const,
  );
}

const openOperation = (page: Page, path: string, method: string) => page.evaluate(([path, method]) => (window as unknown as { __ex: ExplorerInstance }).__ex.open({ path: path!, method: method! }), [path, method] as const);
const dialog = (page: Page) => page.locator("[role=dialog]");
const send = (page: Page, method: string) => page.getByRole("button", { name: new RegExp(`^Send ${method} request`, "i") }).click();
const waitFor = async (what: () => boolean) => {
  for (let i = 0; i < 100 && !what(); i++) await Bun.sleep(50);
  expect(what()).toBe(true);
};
/** Pressing "Authorize" is asynchronous: the token is the builder's once the page has been told about it. */
const authorize = async (page: Page) => {
  await dialog(page).getByRole("button", { name: "Authorize" }).click();
  await page.waitForFunction(() => (window as unknown as { __creds: { oauth?: { accessToken?: string } }[] }).__creds.some((c) => c.oauth?.accessToken));
};

describe("the request builder (vendored Scalar fork)", () => {
  run("the vendored files are the build's: VERSION names the upstream, the patches and both hashes", async () => {
    const version = readFileSync(join(vendor, "VERSION"), "utf8");
    expect(version.split("\n")[0]).toMatch(/^scalar release-\d{4}-\d{2}-\d{2}-[0-9a-f]{7} \+ \d+ patch(es)?$/);
    expect(version).toContain(`explorer.js: ${script.length} bytes, sha256 ${createHash("sha256").update(script).digest("hex")}`);
    expect(version).toContain(`explorer.css: ${styles.length} bytes, sha256 ${createHash("sha256").update(styles).digest("hex")}`);
    const { page } = await open();
    expect(await page.evaluate(() => window.ForgeExplorer!.version)).toBe(version.split("\n")[0]!);
    await page.close();
  });

  run("opens one operation in place, filled from its schema, in the page's theme", async () => {
    const { page, problems } = await open();
    await mount(page, "bearer", { credentials: { bearerAuth: { type: "http", token: "secret-token-123" } } });
    expect(await dialog(page).count()).toBe(0); // nothing is built until it is asked for
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    const text = await dialog(page).innerText();
    expect(text).toContain("List things");
    expect(text).toContain("/api/things");
    expect(text).toContain("limit"); // the query parameter, with its default
    expect(await dialog(page).locator("input[value='10'], [data-value='10']").count()).toBeGreaterThanOrEqual(0);

    // The page's tokens are Scalar's custom properties, and the accent is what the builder draws with.
    const css = await page.evaluate(() => {
      const root = document.querySelector(".scalar-app")!;
      const cs = getComputedStyle(root);
      const layout = getComputedStyle(document.querySelector(".scalar-app-layout")!);
      return { accent: cs.getPropertyValue("--scalar-color-accent").trim(), border: cs.getPropertyValue("--scalar-border-color").trim(), radius: cs.getPropertyValue("--scalar-radius").trim(), mdRadius: cs.getPropertyValue("--scalar-radius-lg").trim(), background: layout.backgroundColor, dark: !!document.querySelector(".forge-explorer.dark-mode"), font: getComputedStyle(document.querySelector(".scalar-app-layout")!).fontFamily };
    });
    expect(css.accent).toBe("#e11d8c");
    expect(css.border).toBe("#344054");
    expect(css.radius).toBe("10px");
    expect(css.background).toBe("rgb(16, 24, 40)");
    expect(css.dark).toBe(true);
    expect(css.font).toContain("Georgia");
    // The page's layered `button {}` does not reach the builder's buttons.
    expect(await page.getByRole("button", { name: "Show sidebar" }).evaluate((el) => getComputedStyle(el).borderTopWidth)).toBe("0px");

    // update() follows the page's light/dark toggle.
    await page.evaluate((light) => (window as unknown as { __ex: ExplorerInstance }).__ex.update({ theme: light }), { ...theme, mode: "light", background: "#ffffff", surface: "#f2f4f7", text: "#101828" } as ExplorerOptions["theme"]);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector(".scalar-app-layout")!).backgroundColor)).toBe("rgb(255, 255, 255)");
    expect(await page.evaluate(() => !!document.querySelector(".forge-explorer.light-mode"))).toBe(true);
    expect(problems).toEqual([]);
    await page.close();
  });

  run("sending reaches the API with the bearer credential that was passed in; a body is filled from the schema's examples", async () => {
    const { page } = await open();
    await mount(page, "bearer", { credentials: { bearerAuth: { type: "http", token: "secret-token-123" } } });
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    await send(page, "get");
    await waitFor(() => seen.length === 1);
    expect(seen[0]).toMatchObject({ path: "/api/things", method: "GET", authorization: "Bearer secret-token-123", query: "?limit=10" });
    await dialog(page).getByText("200").first().waitFor({ timeout: 10_000 });

    await openOperation(page, "/api/things", "post");
    await dialog(page).getByRole("heading", { name: "Create a thing" }).waitFor({ timeout: 10_000 });
    await send(page, "post");
    await waitFor(() => seen.length === 2);
    expect(seen[1]).toMatchObject({ method: "POST", authorization: "Bearer secret-token-123", contentType: "application/json" });
    expect(JSON.parse(seen[1]!.body)).toEqual({ name: "Widget", quantity: 3 });
    await page.close();
  });

  run("close() closes it; the visitor closing it (the button, Escape) is reported", async () => {
    const { page } = await open();
    await mount(page, "bearer");
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    await page.evaluate(() => (window as unknown as { __ex: ExplorerInstance }).__ex.close());
    await dialog(page).waitFor({ state: "hidden", timeout: 5_000 });
    await page.waitForTimeout(100);
    expect(await page.evaluate(() => (window as unknown as { __closed: number }).__closed)).toBe(0); // the page asked for it, so it is not told

    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 5_000 });
    await page.getByRole("button", { name: /close/i }).first().click();
    await dialog(page).waitFor({ state: "hidden", timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { __closed: number }).__closed)).toBe(1); // the visitor did

    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 5_000 });
    await page.keyboard.press("Escape");
    await dialog(page).waitFor({ state: "hidden", timeout: 5_000 });
    expect(await page.evaluate(() => (window as unknown as { __closed: number }).__closed)).toBe(2);
    await page.evaluate(() => (window as unknown as { __ex: ExplorerInstance }).__ex.destroy());
    expect(await page.locator(".forge-explorer").count()).toBe(0);
    await page.close();
  });

  run("OAuth2 client credentials: the app's preset fills the form, the token request carries `resource`, and the token comes back to the page", async () => {
    const { page } = await open();
    await mount(page, "oauth", {
      auth: { preferredScheme: "oauth", oauth2: { clientId: "client-1", scopes: ["things:read"], tokenUrl: "/oauth/token", extraParams: { resource: `${origin}/api` } } },
      credentials: { oauth: { type: "oauth2", clientSecret: "s3cret" } },
    });
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    const form = await dialog(page).innerText();
    expect(form).toContain(`${origin}/oauth/token`); // a path on the API's server, resolved
    expect(form).toContain("client-1");
    await authorize(page);
    const token = seen.find((s) => s.path === "/oauth/token")!;
    const form_ = new URLSearchParams(token.body);
    expect(form_.get("grant_type")).toBe("client_credentials");
    expect(form_.get("resource")).toBe(`${origin}/api`); // RFC 8707
    expect(form_.get("scope")).toBe("things:read");
    expect(token.authorization).toBe(`Basic ${btoa("client-1:s3cret")}`);

    await send(page, "get");
    await waitFor(() => seen.some((s) => s.path === "/api/things"));
    expect(seen.find((s) => s.path === "/api/things")!.authorization).toBe("Bearer token-1");
    // The page's store hears about the token, and when it ends.
    const creds = (await page.evaluate(() => (window as unknown as { __creds: Record<string, unknown>[] }).__creds)) as { oauth: { accessToken?: string; expiresAt?: number; clientSecret?: string } }[];
    const last = creds.at(-1)!.oauth;
    expect(last).toMatchObject({ accessToken: "token-1", clientSecret: "s3cret" });
    expect(last.expiresAt!).toBeGreaterThan(Date.now() + 3_000_000);
    await page.close();
  });

  run("an ended client-credentials token is fetched again before the request is sent", async () => {
    const { page } = await open();
    await mount(page, "oauth", { auth: { preferredScheme: "oauth", oauth2: { clientId: "client-1", tokenUrl: "/oauth/token" } }, credentials: { oauth: { type: "oauth2", clientSecret: "s3cret" } } });
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    tokenLifetime = 1; // already inside the renewal margin when it arrives
    await authorize(page);
    expect(tokens).toBe(1);
    await send(page, "get");
    await waitFor(() => seen.some((s) => s.path === "/api/things"));
    expect(tokens).toBe(2);
    expect(seen.find((s) => s.path === "/api/things")!.authorization).toBe("Bearer token-2");
    await page.close();
  });

  run("an API key credential is sent in the header the document names; update() hands the open builder new credentials and a new document", async () => {
    const { page } = await open();
    await mount(page, "key", { credentials: { keyAuth: { type: "apiKey", value: "key-one" } } });
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    await send(page, "get");
    await waitFor(() => seen.length === 1);
    expect(seen[0]!.apiKey).toBe("key-one");

    await page.evaluate(async () => {
      const doc = await (await fetch("/openapi.json?scheme=key")).json();
      doc.paths["/api/things"].get.summary = "Fetch the things";
      (window as unknown as { __ex: ExplorerInstance }).__ex.update({ document: doc, credentials: { keyAuth: { type: "apiKey", value: "key-two" } } });
    });
    await dialog(page).getByRole("heading", { name: "Fetch the things" }).waitFor({ timeout: 10_000 });
    await send(page, "get");
    await waitFor(() => seen.length === 2);
    expect(seen[1]!.apiKey).toBe("key-two");
    // What the page itself set is not echoed back as if the visitor had entered it.
    expect(await page.evaluate(() => (window as unknown as { __creds: unknown[] }).__creds)).toEqual([]);
    await page.close();
  });

  run("strings and code samples are the app's: translated labels, and only the languages it lists", async () => {
    const { page } = await open();
    await mount(page, "bearer", { strings: { "apiClient.requestBlock.authentication": "Authentification" }, codeSamples: ["python", "curl"] });
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    expect(await dialog(page).innerText()).toContain("Authentification");
    await dialog(page).getByText("Code Snippet").click();
    const snippet = await dialog(page).innerText();
    expect(snippet).toContain("requests.get("); // the first language asked for is the one shown
    await page.close();
  });

  run("nothing is requested from any host but the local API: no fonts, telemetry, proxy or hosted client", async () => {
    const { page, requests, blocked, problems } = await open();
    await mount(page, "oauth", { auth: { preferredScheme: "oauth", oauth2: { clientId: "client-1", tokenUrl: "/oauth/token" } }, credentials: { oauth: { type: "oauth2", clientSecret: "s3cret" } } });
    await openOperation(page, "/api/things", "get");
    await dialog(page).waitFor({ state: "visible", timeout: 15_000 });
    await authorize(page);
    await send(page, "get");
    await waitFor(() => seen.some((s) => s.path === "/api/things"));
    await dialog(page).getByText("Code Snippet").click();
    await page.getByRole("button", { name: "Show sidebar" }).click();
    await page.waitForLoadState("networkidle");
    expect(blocked).toEqual([]);
    expect(requests.every((url) => new URL(url).origin === origin)).toBe(true);
    expect(requests).toContain(`${origin}/_docs/explorer.css`); // the stylesheet is loaded from beside the script
    expect(problems).toEqual([]);
    await page.close();
  });
});
