import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import type { RunningServer } from "@archlast/forge-runtime/server";
import type { Browser, BrowserContext } from "playwright-core";
import { isHydrationMismatch } from "../src/hydration";
import { validZone, windowOf, zoneFromCookie } from "../src/time";
import { launchBrowser } from "./browser";
import { startFixture, stateOf } from "./helpers";

// The page's server runs in UTC. The browsers below are in Los Angeles (UTC-7 on the fixture's date) or Manila (UTC+8), and their clocks can run ahead.
const SERVER_ZONE = "UTC";
const HOUR = 3_600_000;
const ADMITTED = Date.UTC(2026, 9, 21, 22, 0, 0);

let srv: RunningServer;
let browser: Browser | undefined;
let before: string | undefined;

beforeAll(async () => {
  before = process.env.TZ;
  process.env.TZ = SERVER_ZONE;
  expect(new Date(ADMITTED).getTimezoneOffset()).toBe(0);
  browser = await launchBrowser();
  srv = await startFixture();
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await srv?.stop({ graceful: false });
  if (before === undefined) delete process.env.TZ;
  else process.env.TZ = before;
});

const text = (html: string, id: string) => new RegExp(`id="${id}"[^>]*>(.*?)</p>`).exec(html.replaceAll("<!-- -->", ""))?.[1];
const page = (path: string, cookie?: string) => fetch(`${srv.url}${path}`, cookie ? { headers: { cookie } } : undefined).then((r) => r.text());

describe("the viewer's time zone, as the server learns it", () => {
  test("a zone name is accepted only when it names a zone, whatever the cookie says", () => {
    for (const ok of ["UTC", "America/Los_Angeles", "Asia/Manila", "America/Argentina/Buenos_Aires", "Etc/GMT+5"]) expect(validZone(ok)).toBe(true);
    for (const bad of ["", "Mars/Olympus_Mons", "<script>alert(1)</script>", "UTC; Path=/", "a".repeat(65), "America/Los Angeles", 5, null, undefined]) expect(validZone(bad)).toBe(false);
  });

  test("it is read from the forge-tz cookie among others, decoded, and ignored when it is not a zone", () => {
    expect(zoneFromCookie("theme=dark; forge-tz=Asia/Manila; session=abc")).toBe("Asia/Manila");
    expect(zoneFromCookie("forge-tz=America%2FLos_Angeles")).toBe("America/Los_Angeles");
    expect(zoneFromCookie("forge-tz=Nowhere/Land")).toBeUndefined();
    expect(zoneFromCookie("forge-tz=%E0%A4%A")).toBeUndefined(); // not valid percent-encoding
    expect(zoneFromCookie("xforge-tz=Asia/Manila")).toBeUndefined();
    expect(zoneFromCookie(null)).toBeUndefined();
  });

  test("the clock is rounded down to its interval, and two moments in the same interval agree", () => {
    expect(windowOf(125_000, 60_000)).toBe(120_000);
    expect(windowOf(119_999, 60_000)).toBe(60_000);
    expect(windowOf(ADMITTED + 17, 1000)).toBe(ADMITTED);
  });

  test("the server renders in UTC for a visitor it knows nothing about, and in the cookie's zone for one it does", async () => {
    const first = await page("/times");
    expect(text(first, "when")).toBe("Oct 21, 2026, 10:00 PM");
    expect(text(first, "zone")).toBe("UTC");
    expect(stateOf(first)).toMatchObject({ timeZone: "UTC" });
    expect(typeof stateOf(first).now).toBe("number");

    const manila = await page("/times", "forge-tz=Asia/Manila");
    expect(text(manila, "when")).toBe("Oct 22, 2026, 6:00 AM");
    expect(stateOf(manila).timeZone).toBe("Asia/Manila");
  });

  test("a cookie that is not a zone is not used and never reaches the page", async () => {
    for (const cookie of ["forge-tz=Nowhere/Land", 'forge-tz="><script>alert(1)</script>', "forge-tz=" + "A".repeat(500)]) {
      const html = await page("/times", cookie);
      expect(stateOf(html).timeZone).toBe("UTC");
      expect(html).not.toContain("alert(1)");
      expect(html).not.toContain("Nowhere");
    }
  });

  test("the page is still private, still varies on the cookie, and the instant it was rendered at is the request's", async () => {
    const t0 = Date.now();
    const res = await fetch(`${srv.url}/times`);
    const html = await res.text();
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("vary")).toBe("cookie");
    expect(stateOf(html).now).toBeGreaterThanOrEqual(t0);
    expect(stateOf(html).now).toBeLessThanOrEqual(Date.now());
  });
});

describe("recognizing a hydration mismatch", () => {
  test("in React's development message and in the minified one", () => {
    expect(isHydrationMismatch(new Error("Hydration failed because the server rendered text didn't match the client."))).toBe(true);
    expect(isHydrationMismatch(new Error("Minified React error #418; visit https://react.dev/errors/418?args[]=text&args[]="))).toBe(true);
    expect(isHydrationMismatch(new Error("Minified React error #423; visit https://react.dev/errors/423"))).toBe(true);
    expect(isHydrationMismatch(new Error("Minified React error #4180; unrelated"))).toBe(false);
    expect(isHydrationMismatch(new Error("Cannot read properties of undefined"))).toBe(false);
  });
});

/** Everything a browser at `zone` with a clock `skew` ms ahead of the server's says while the page loads, and what became of the server's HTML. */
async function visit(path: string, o: { zone: string; skew?: number; context?: BrowserContext; server?: RunningServer } = { zone: "UTC" }) {
  const url = (o.server ?? srv).url;
  const context = o.context ?? (await browser!.newContext({ timezoneId: o.zone }));
  if (o.skew) await context.clock.setFixedTime(new Date(Date.now() + o.skew));
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && problems.push(`${m.type()}: ${m.text().slice(0, 1200)}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 1200)}`));
  await page.addInitScript(() => {
    const seen: string[] = [];
    Object.assign(window, { __seen: seen });
    const note = () => {
      const t = document.querySelector("#when")?.textContent;
      if (t && seen.at(-1) !== t) seen.push(t);
    };
    new MutationObserver(note).observe(document, { childList: true, subtree: true, characterData: true });
    document.addEventListener("DOMContentLoaded", () => {
      Object.assign(window, { __main: document.querySelector("main") });
      note();
    });
  });
  await page.goto(`${url}${path}`, { waitUntil: "networkidle" });
  await page.waitForTimeout(200);
  const after = await page.evaluate(() => ({
    kept: (window as unknown as { __main: Element }).__main === document.querySelector("main"),
    seen: (window as unknown as { __seen: string[] }).__seen,
  }));
  return { context, page, problems, ...after };
}

const run = (name: string, fn: () => Promise<void>) => test(name, async () => (browser ? fn() : console.warn(`skipped: ${name}`)), 60_000);

describe("in a browser in another time zone, with a clock that has moved on", () => {
  const LA = { zone: "America/Los_Angeles", skew: 36 * HOUR };

  run("formatting the obvious way is wrong on the first paint, and React throws the server's page away", async () => {
    const html = await page("/times-naive");
    expect(text(html, "when")).toBe("Oct 21, 2026, 10:00 PM");
    expect(text(html, "stay")).toBe(`Day ${Math.floor((Date.now() - ADMITTED) / (24 * HOUR)) + 1}`);
    const v = await visit("/times-naive", LA);
    expect(v.seen).toEqual(["Oct 21, 2026, 10:00 PM", "Oct 21, 2026, 3:00 PM"]); // the visitor sees the wrong time, then the right one
    expect(v.kept).toBe(false); // the server's <main> was replaced
    expect(v.problems.some((p) => /Minified React error #418|Hydration failed/.test(p))).toBe(true);
    await v.context.close();
  });

  run("with useTimeZone and useNow the first paint is the server's, then moves to the browser's own, with no error and the page kept", async () => {
    const v = await visit("/times", LA);
    expect(v.problems).toEqual([]);
    expect(v.kept).toBe(true);
    expect(v.seen).toEqual(["Oct 21, 2026, 10:00 PM", "Oct 21, 2026, 3:00 PM"]);
    expect(await v.page.textContent("#zone")).toBe("America/Los_Angeles");
    const day = Math.floor((Date.now() + LA.skew - ADMITTED) / (24 * HOUR)) + 1; // the browser's clock, once hydrated
    expect(await v.page.textContent("#stay")).toBe(`Day ${day}`);
    await v.context.close();
  });

  run("the browser remembers its zone, and the next visit is right from the first byte", async () => {
    const first = await visit("/times", LA);
    const cookies = await first.context.cookies(srv.url);
    expect(cookies.find((c) => c.name === "forge-tz")?.value).toBe("America/Los_Angeles");
    const cookie = cookies.map((c) => `${c.name}=${c.value}`).join("; ");
    expect(text(await page("/times", cookie), "when")).toBe("Oct 21, 2026, 3:00 PM"); // what the server sends the second time
    const second = await visit("/times", { ...LA, context: first.context });
    expect(second.problems).toEqual([]);
    expect(second.seen).toEqual(["Oct 21, 2026, 3:00 PM"]); // never the wrong time
    await first.context.close();
  });

  run("a visitor who has travelled sees their old zone for an instant and the right one after, with no error", async () => {
    const context = await browser!.newContext({ timezoneId: "America/Los_Angeles" });
    await context.addCookies([{ name: "forge-tz", value: "Asia/Manila", url: srv.url }]);
    const v = await visit("/times", { zone: "America/Los_Angeles", context });
    expect(v.problems).toEqual([]);
    expect(v.kept).toBe(true);
    expect(v.seen).toEqual(["Oct 22, 2026, 6:00 AM", "Oct 21, 2026, 3:00 PM"]);
    expect((await context.cookies(srv.url)).find((c) => c.name === "forge-tz")?.value).toBe("America/Los_Angeles");
    await context.close();
  });

  run("an argument worked out from the clock is a hydration error in the component, and not when the loader hands it over", async () => {
    // The browser's clock is in the next minute: its own "last 24 hours" starts at another instant than the server's, so it misses the preloaded entry.
    const bad = await visit("/range-naive", { zone: "UTC", skew: 90_000 });
    expect(bad.problems.some((p) => /Minified React error #418|Hydration failed/.test(p))).toBe(true);
    expect(bad.kept).toBe(false);
    await bad.context.close();

    const good = await visit("/range", { zone: "UTC", skew: 90_000 });
    expect(good.problems).toEqual([]);
    expect(good.kept).toBe(true);
    expect(await good.page.locator("#rows li").allTextContents()).toEqual(["first", "second", "third"]);
    await good.context.close();
  });
});

describe("the clock", () => {
  run("agrees with the server while hydrating, then follows the browser's, and keeps ticking", async () => {
    const html = await page("/clock");
    const served = stateOf(html).now;
    expect(Number(text(html, "seconds"))).toBe(windowOf(served, 1000));
    expect(Number(text(html, "minutes"))).toBe(windowOf(served, 60_000));

    const v = await visit("/clock", { zone: "UTC" });
    expect(v.problems).toEqual([]);
    expect(v.kept).toBe(true);
    const first = Number(await v.page.textContent("#seconds"));
    expect(first).toBeGreaterThanOrEqual(windowOf(served, 1000)); // the browser's own time, the server's second or a later one
    expect(first % 1000).toBe(0);
    await v.page.waitForFunction((was) => Number(document.querySelector("#seconds")!.textContent) >= was + 2000, first, { timeout: 8000 }); // it ticks
    const minutes = Number(await v.page.textContent("#minutes"));
    expect(minutes % 60_000).toBe(0);
    expect(Math.abs(minutes - Date.now())).toBeLessThan(120_000);
    await v.context.close();
  });

  run("a clock that is ahead of the server's changes the text in place, not the page", async () => {
    const v = await visit("/clock", { zone: "UTC", skew: 5 * 60_000 });
    expect(v.problems).toEqual([]);
    expect(v.kept).toBe(true);
    expect(Number(await v.page.textContent("#minutes"))).toBeGreaterThanOrEqual(windowOf(Date.now() + 5 * 60_000 - 1000, 60_000));
    await v.context.close();
  });
});

describe("in development", () => {
  let dev: RunningServer | undefined;
  beforeAll(async () => {
    if (browser) dev = await startFixture({ dev: true });
  }, 120_000);
  afterAll(() => dev?.stop({ graceful: false }));

  run("a mismatch names the way out in the console and on the page, and the fixed page says nothing", async () => {
    const bad = await visit("/times-naive", { zone: "America/Los_Angeles", skew: 36 * HOUR, server: dev });
    expect(bad.problems.some((p) => p.includes("Hydration failed because the server rendered text didn't match the client"))).toBe(true);
    expect(bad.problems.some((p) => p.includes("[archlast-forge]") && p.includes("useTimeZone()") && p.includes("useNow()"))).toBe(true);
    expect(await bad.page.getByText("Hydration mismatch").count()).toBe(1);
    await bad.context.close();

    const good = await visit("/times", { zone: "America/Los_Angeles", skew: 36 * HOUR, server: dev });
    expect(good.problems).toEqual([]);
    expect(await good.page.getByText("Hydration mismatch").count()).toBe(0);
    await good.context.close();
  });
});
