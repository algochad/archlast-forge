import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RunningServer } from "@archlast/forge-runtime/server";
import type { Browser } from "playwright-core";
import { readBuild } from "../src/build";
import { launchBrowser } from "./browser";
import { hasNativeEngine, signUp, startFixture } from "./helpers";

const root = join(import.meta.dir, "fixture-islands");
let srv: RunningServer;
let browser: Browser | undefined;
let native = false;

beforeAll(async () => {
  browser = await launchBrowser();
  native = await hasNativeEngine();
  srv = await startFixture({ root, islands: true, env: { HTTP_ENGINE: native ? "archlast" : "bun" } });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await srv?.stop({ graceful: false });
});

const html = (path: string, cookie?: string) => fetch(`${srv.url}${path}`, cookie ? { headers: { cookie } } : undefined).then((r) => r.text());
const markers = (page: string) => [...page.matchAll(/data-forge-island="([^"]+)"/g)].map((m) => m[1]);
const scripts = (page: string) => [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);

describe("pages with islands", () => {
  test("the build records the islands entry and which routes can use it", () => {
    const b = readBuild(root)!;
    expect(b.manifest.islands?.entry).toMatch(/^islands\.client-.*\.js$/);
    expect([...b.manifest.islands!.routes].sort()).toEqual(["routes/about", "routes/cached", "routes/cached-items", "routes/index", "routes/live"]);
  });

  test("a page renders its static parts as HTML and marks its islands, which load from their own entry", async () => {
    const page = await html("/");
    expect(page).toContain('<h1 id="title">Home</h1>');
    expect(markers(page)).toEqual(["_c/counter.tsx#Counter"]); // the menu is for a signed-in visitor; an anonymous one gets a link
    expect(page).toContain("data-props=\"{&quot;start&quot;:1,&quot;step&quot;:2}\"");
    const entries = scripts(page);
    expect(entries.some((s) => /islands\.client-/.test(s))).toBe(true);
    expect(entries.some((s) => /entry\.client-/.test(s))).toBe(false);
    // no router state for the browser: nothing was handed over for a router to start from
    expect(page).toContain('"loaderData":{}');
  });

  test("a route that is an island itself is marked where the router renders it, and a signed-in visitor's menu is an island", async () => {
    const cookie = await signUp(srv, "islands@example.com");
    const page = await html("/live", cookie);
    expect(markers(page).sort()).toEqual(["_c/user-menu.tsx#UserMenu", "routes/live.tsx#default"]);
    expect(scripts(page).some((s) => /islands\.client-/.test(s))).toBe(true);
  });

  test("a page where no island rendered has no framework JavaScript: only the small navigation script", async () => {
    const page = await html("/about");
    expect(markers(page)).toEqual([]);
    expect(scripts(page).length).toBe(1);
    expect(scripts(page)[0]).toMatch(/\/nav-.*\.js$/);
    expect(page).not.toContain("forge-state");
    expect(page).not.toContain("modulepreload");
    expect(page).toContain('<h1 id="title">About</h1>');
  });

  test("a route the build could not place renders and hydrates as a whole, as without islands", async () => {
    const page = await html("/old");
    expect(markers(page)).toEqual([]);
    expect(scripts(page).some((s) => /entry\.client-/.test(s))).toBe(true);
    expect(scripts(page).some((s) => /islands\.client-/.test(s))).toBe(false);
  });

  test("a page that asks to be kept is served again to anonymous visitors without being rendered; signed-in visitors and other cookies never meet it", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const renders = async (path: string, init?: RequestInit) => /rendered (?:<!-- -->)?(\d+)/.exec(await fetch(`${srv.url}${path}`, init).then((r) => r.text()))?.[1];
    const first = await fetch(`${srv.url}/cached`);
    expect(await first.text()).toMatch(/rendered (<!-- -->)?1/);
    // the policy carries hashes of the page's inline scripts, not a nonce, and the engine's note is gone
    const csp = first.headers.get("content-security-policy") ?? "";
    expect(csp).not.toContain("nonce-");
    expect(first.headers.get("x-archlast-cache")).toBeNull();
    expect(first.headers.get("x-forge-cache")).toBeNull();
    expect(await renders("/cached")).toBe("1"); // from the cache
    expect(await renders("/cached?x=1")).toBe("2"); // another key
    expect(await renders("/cached?x=1")).toBe("2");
    const zone = (tz: string) => ({ headers: { cookie: `forge-tz=${tz}` } });
    expect(await renders("/cached", zone("Asia/Manila"))).toBe("3"); // the time zone is part of the key
    expect(await renders("/cached", zone("Asia/Manila"))).toBe("3");
    expect(await renders("/cached", { headers: { cookie: "analytics=1" } })).toBe("4"); // a cookie nobody named bypasses the cache,
    expect(await renders("/cached", { headers: { cookie: "analytics=1" } })).toBe("5"); // in both directions
    const cookie = await signUp(srv, "cache-user@example.com");
    expect(await renders("/cached", { headers: { cookie } })).toBe("6"); // a signed-in visitor is rendered for, every time
    expect(await renders("/cached", { headers: { cookie } })).toBe("7");
    expect(await renders("/cached")).toBe("1"); // and the anonymous entry is as it was
    // a page without the request in its handle is never kept
    const about = async () => (await fetch(`${srv.url}/about`).then((r) => r.text())).includes("About");
    expect(await about()).toBe(true);
  });

  test("a write to a table a kept page read ends it; a write to another table does not", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const seen = async () => /(\d+) items, rendered (\d+)/.exec((await fetch(`${srv.url}/cached-items`).then((r) => r.text())).replaceAll("<!-- -->", ""))?.slice(1).map(Number) as [number, number];
    const rpc = (name: string, args: object) => fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
    const [n, r] = (await seen())!;
    expect(await seen()).toEqual([n, r]); // kept
    await rpc("messages:setFlag", {}); // a table the page did not read
    expect(await seen()).toEqual([n, r]);
    await rpc("items:add", { from: 1000, count: 2 });
    for (let i = 0; i < 50 && (await seen())![0] === n; i++) await Bun.sleep(20);
    expect(await seen()).toEqual([n + 2, r + 1]); // rendered again, once, with the new rows
    expect(await seen()).toEqual([n + 2, r + 1]);
  });

  test("an unknown page is the error page, rendered as a whole", async () => {
    const res = await fetch(`${srv.url}/nope`);
    expect(res.status).toBe(404);
    expect(markers(await res.text())).toEqual([]);
  });

  test("in a browser: islands hydrate alone, navigate by loading, and the rest of the page is untouched", async () => {
    if (!browser) return console.warn("skipped: no browser");
    const cookie = await signUp(srv, "browser-islands@example.com", "Grace");
    const context = await browser.newContext();
    await context.addCookies(cookie.split("; ").map((kv) => ({ name: kv.slice(0, kv.indexOf("=")), value: kv.slice(kv.indexOf("=") + 1), url: srv.url })));
    const page = await context.newPage();
    const problems: string[] = [];
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/WebSocket is closed before/.test(m.text()) && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(`${srv.url}/`, { waitUntil: "networkidle" });
    expect(await page.textContent("#counter")).toBe("count 1");
    await page.click("#counter");
    expect(await page.textContent("#counter")).toBe("count 3");
    await page.click("#menu-button");
    expect(await page.textContent("#menu-open")).toContain("Grace");
    await page.evaluate(() => ((window as any).mark = "same document"));
    await page.click("#go-about"); // useNavigate inside an island: the page is swapped in, the document stays
    await page.waitForURL("**/about");
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "About");
    expect(await page.evaluate(() => (window as any).mark)).toBe("same document");
    // a link in the page (not in an island) does the same, and the islands of the new page hydrate
    await page.click("text=Home");
    await page.waitForSelector("#counter");
    expect(await page.evaluate(() => (window as any).mark)).toBe("same document");
    await page.click("#counter");
    expect(await page.textContent("#counter")).toBe("count 3");
    await page.click("text=Live");
    await page.waitForSelector("#inc");
    await page.click("#inc");
    expect(await page.textContent("#inc")).toBe("n = 1");
    expect(await page.evaluate(() => (window as any).mark)).toBe("same document");
    // back and forward
    await page.goBack();
    await page.waitForSelector("#counter");
    expect(new URL(page.url()).pathname).toBe("/");
    await page.click("#counter");
    expect(await page.textContent("#counter")).toBe("count 3");
    await page.goForward();
    await page.waitForSelector("#inc");
    expect(await page.evaluate(() => (window as any).mark)).toBe("same document");
    // a page that is not an island page is loaded the ordinary way
    await page.click("text=Old");
    await page.waitForURL("**/old");
    await page.waitForFunction(() => document.querySelector("#title")?.textContent === "Old");
    expect(await page.evaluate(() => (window as any).mark)).toBeUndefined();
    // an island that is a whole route
    await page.goto(`${srv.url}/live`, { waitUntil: "networkidle" });
    await page.click("#inc");
    expect(await page.textContent("#inc")).toBe("n = 1");
    // the whole-page route still navigates inside the document
    await page.goto(`${srv.url}/old`, { waitUntil: "networkidle" });
    await page.evaluate(() => ((window as any).mark = "same document"));
    await page.click("text=Home");
    await page.waitForSelector("#counter");
    expect(await page.evaluate(() => (window as any).mark)).toBe("same document");
    expect(problems).toEqual([]);
    await page.close();
  }, 60_000);
});

describe("an app with islands on and no island in it", () => {
  test("every page has only the navigation script", async () => {
    const none = await startFixture({ root: join(import.meta.dir, "fixture-islands-none"), islands: true });
    try {
      for (const path of ["/", "/about"]) {
        const page = await fetch(`${none.url}${path}`).then((r) => r.text());
        expect(scripts(page).length).toBe(1);
        expect(scripts(page)[0]).toMatch(/\/nav-.*\.js$/);
      }
    } finally {
      await none.stop({ graceful: false });
    }
  });
});
