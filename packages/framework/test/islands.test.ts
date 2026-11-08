import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RunningServer } from "@archlast/forge-runtime/server";
import type { Browser } from "playwright-core";
import { readBuild } from "../src/build";
import { launchBrowser } from "./browser";
import { startFixture } from "./helpers";

const root = join(import.meta.dir, "fixture-islands");
let srv: RunningServer;
let browser: Browser | undefined;

beforeAll(async () => {
  browser = await launchBrowser();
  srv = await startFixture({ root, islands: true });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await srv?.stop({ graceful: false });
});

const html = (path: string) => fetch(`${srv.url}${path}`).then((r) => r.text());
const markers = (page: string) => [...page.matchAll(/data-forge-island="([^"]+)"/g)].map((m) => m[1]);
const scripts = (page: string) => [...page.matchAll(/<script[^>]*src="([^"]+)"/g)].map((m) => m[1]!);

describe("pages with islands", () => {
  test("the build records the islands entry and which routes can use it", () => {
    const b = readBuild(root)!;
    expect(b.manifest.islands?.entry).toMatch(/^islands\.client-.*\.js$/);
    expect([...b.manifest.islands!.routes].sort()).toEqual(["routes/about", "routes/index", "routes/live"]);
  });

  test("a page renders its static parts as HTML and marks its islands, which load from their own entry", async () => {
    const page = await html("/");
    expect(page).toContain('<h1 id="title">Home</h1>');
    expect(markers(page).sort()).toEqual(["_c/counter.tsx#Counter", "_c/user-menu.tsx#UserMenu"]);
    expect(page).toContain("data-props=\"{&quot;start&quot;:1,&quot;step&quot;:2}\"");
    const entries = scripts(page);
    expect(entries.some((s) => /islands\.client-/.test(s))).toBe(true);
    expect(entries.some((s) => /entry\.client-/.test(s))).toBe(false);
    // no router state for the browser: nothing was handed over for a router to start from
    expect(page).toContain('"loaderData":{}');
  });

  test("a route that is an island itself is marked where the router renders it", async () => {
    const page = await html("/live");
    expect(markers(page).sort()).toEqual(["_c/user-menu.tsx#UserMenu", "routes/live.tsx#default"]);
  });

  test("a route the build could not place renders and hydrates as a whole, as without islands", async () => {
    const page = await html("/old");
    expect(markers(page)).toEqual([]);
    expect(scripts(page).some((s) => /entry\.client-/.test(s))).toBe(true);
    expect(scripts(page).some((s) => /islands\.client-/.test(s))).toBe(false);
  });

  test("an unknown page is the error page, rendered as a whole", async () => {
    const res = await fetch(`${srv.url}/nope`);
    expect(res.status).toBe(404);
    expect(markers(await res.text())).toEqual([]);
  });

  test("in a browser: islands hydrate alone, navigate by loading, and the rest of the page is untouched", async () => {
    if (!browser) return console.warn("skipped: no browser");
    const page = await browser.newPage();
    const problems: string[] = [];
    page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/WebSocket is closed before/.test(m.text()) && problems.push(m.text()));
    page.on("pageerror", (e) => problems.push(e.message));
    await page.goto(`${srv.url}/`, { waitUntil: "networkidle" });
    expect(await page.textContent("#counter")).toBe("count 1");
    await page.click("#counter");
    expect(await page.textContent("#counter")).toBe("count 3");
    await page.click("#menu-button");
    expect(await page.textContent("#menu-open")).toContain("nobody");
    await page.evaluate(() => ((window as any).mark = "same document"));
    await page.click("#go-about"); // useNavigate inside an island: a page load
    await page.waitForURL("**/about");
    await page.waitForSelector("#title");
    expect(await page.evaluate(() => (window as any).mark)).toBeUndefined();
    expect(await page.textContent("#title")).toBe("About");
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
