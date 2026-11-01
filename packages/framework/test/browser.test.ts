import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningServer } from "@archlast/forge-runtime/server";
import type { Browser, Page } from "playwright-core";
import { launchBrowser } from "./browser";
import { signUp, startFixture } from "./helpers";

let srv: RunningServer;
let browser: Browser | undefined;
let cookie: string;

beforeAll(async () => {
  browser = await launchBrowser();
  if (!browser) return;
  srv = await startFixture();
  cookie = await signUp(srv, "grace@example.com", "Grace");
});
afterAll(async () => {
  await browser?.close();
  await srv?.stop({ graceful: false });
});

const send = (body: string) => fetch(`${srv.url}/rpc/messages:send`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ body }) });

/** A page that records everything the browser complains about. */
async function open(path: string) {
  const page = await browser!.newContext().then((c) => c.newPage());
  const problems: string[] = [];
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  await page.goto(`${srv.url}${path}`, { waitUntil: "networkidle" });
  return { page, problems };
}

const run = (name: string, fn: () => Promise<void>) => test(name, async () => (browser ? fn() : console.warn(`skipped: ${name}`)), 60_000);

describe("in a real browser", () => {
  run("hydrates without a single warning, and the page is interactive", async () => {
    const { page, problems } = await open("/");
    expect(await page.textContent("#counter")).toBe("clicked 0");
    await page.click("#counter");
    expect(await page.textContent("#counter")).toBe("clicked 1");
    expect(problems).toEqual([]);
  });

  run("live queries start from the server's data and keep updating without a reload", async () => {
    await send("one");
    const { page } = await open("/");
    expect(await page.locator("#messages li").allTextContents()).toContain("one");
    await page.evaluate(() => ((window as any).__marker = 1));
    await send("two");
    await page.waitForFunction(() => document.querySelector("#messages")?.textContent?.includes("two"));
    expect((await page.locator("#messages li").allTextContents())[0]).toBe("two");
    expect(await page.evaluate(() => (window as any).__marker)).toBe(1);
  });

  run("links navigate without reloading, apply the stylesheet, and the back button works", async () => {
    const { page, problems } = await open("/");
    await page.evaluate(() => ((window as any).__marker = 1));
    await page.click("text=About");
    await page.waitForSelector("#about");
    expect(page.url()).toBe(`${srv.url}/about`);
    expect(await page.evaluate(() => getComputedStyle(document.querySelector("#about")!).color)).toBe("rgb(102, 51, 153)"); // rebeccapurple
    await page.click("text=Blog");
    await page.waitForSelector("#blog-index");
    expect(await page.textContent("#blog-layout h2")).toBe("The blog");
    await page.goBack();
    await page.waitForSelector("#about");
    expect(await page.evaluate(() => (window as any).__marker)).toBe(1); // never a full load
    expect(problems).toEqual([]);
  });

  run("a lazily loaded route can be the first page, and a loader runs again on navigation", async () => {
    const { page, problems } = await open("/blog/hello");
    expect(await page.textContent("#post p")).toBe("HELLO");
    await page.evaluate(() => ((window as any).__marker = 1));
    await page.goto(`${srv.url}/about`);
    expect(await page.textContent("#about")).toBe("About");
    expect(problems).toEqual([]);
  });

  run("an error boundary's \"try again\" works once the query can succeed", async () => {
    const { page } = await open("/gated");
    await page.waitForSelector("#err");
    expect(await page.textContent("#err")).toContain("not yet");
    await fetch(`${srv.url}/rpc/messages:setFlag`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    await page.click("#retry");
    await page.waitForFunction(() => document.querySelector("#ready")?.textContent === "ready", undefined, { timeout: 5000 }); // not the same error again
  });

  run("error pages hydrate too", async () => {
    const { page, problems } = await open("/boom");
    expect(await page.textContent("h1")).toBe("500");
    expect(await page.content()).not.toContain("hunter2");
    const missing = await open("/nope");
    expect(await missing.page.textContent("h1")).toBe("404");
    expect(problems.concat(missing.problems).filter((p) => !p.includes("status of 404") && !p.includes("status of 500"))).toEqual([]);
  });

  run("numbered pages and a growing list from one paginated query: rendered on the server, then live", async () => {
    const add = (from: number, count: number) => fetch(`${srv.url}/rpc/items:add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ from, count }) });
    await add(1, 7);
    const { page, problems } = await open("/pages?page=2");
    // The server rendered page 2 with its total, and the first window of the list; hydration kept it.
    expect(await page.textContent("#table")).toBe("4,5,6");
    expect(await page.textContent("#where")).toBe("page 2 of 3 (7 items)");
    expect(await page.textContent("#list")).toBe("1,2");
    await page.click("#next");
    await page.waitForFunction(() => document.querySelector("#table")?.textContent === "7");
    expect(await page.textContent("#where")).toBe("page 3 of 3 (7 items), last");
    // Live: new items fill the last page and the count follows.
    await add(8, 2);
    await page.waitForFunction(() => document.querySelector("#table")?.textContent === "7,8,9");
    expect(await page.textContent("#where")).toBe("page 3 of 3 (9 items), last");
    await page.click("#more");
    await page.waitForFunction(() => document.querySelector("#list")?.textContent === "1,2,3,4");
    expect(problems).toEqual([]);
  });

  run("signing in updates the page in place, and the next loader sees the new user straight away", async () => {
    const { page, problems } = await open("/sign-in");
    expect(await page.textContent("#who")).toBe("Signed out");
    await page.evaluate(() => ((window as any).__marker = 1));
    await page.fill('input[name="email"]', "lin@example.com");
    await page.fill('input[name="password"]', "correct horse battery");
    await page.click("button");
    await page.waitForSelector("#secret"); // /secret redirects anonymous visitors, so the loader saw the fresh session
    expect(await page.textContent("#who")).toBe("Hi lin");
    expect(await page.evaluate(() => (window as any).__marker)).toBe(1);
    await page.reload({ waitUntil: "networkidle" });
    expect(await page.textContent("#who")).toBe("Hi lin"); // rendered by the server this time
    expect(problems).toEqual([]);
  });
});
