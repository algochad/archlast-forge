import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { checkFrontendImports, codegen } from "../../cli/src/codegen";
import type { BaseColor } from "../../create-archlast-forge/src/shadcn";
import { buildApp } from "../src/build";
import { launchBrowser } from "./browser";
import { hasNativeEngine, startFixture } from "./helpers";
import { templateProject, TMP } from "./template";

const shots = process.env.SCREENSHOTS;

/** The starter app, built and served, driven in a browser: the plain one, and the one with shadcn/ui. */
function suite(label: string, name: string, shadcn?: BaseColor) {
  describe(label, () => {
    let dir: string;
    let browser: Browser | undefined;
    let native = false;
    let srv: Awaited<ReturnType<typeof startFixture>>;

    beforeAll(async () => {
      dir = templateProject(name, "framework", [], shadcn);
      await codegen(join(dir, "forge"));
      browser = await launchBrowser();
      if (!browser) return;
      await buildApp({ root: dir, dev: false });
      native = await hasNativeEngine();
      srv = await startFixture({ root: dir, env: { HTTP_ENGINE: native ? "archlast" : "bun" } });
    }, 180_000);
    afterAll(async () => {
      await browser?.close();
      await srv?.stop({ graceful: false });
      rmSync(dir, { recursive: true, force: true });
    });

    const run = (name: string, fn: () => Promise<void>) => test(name, async () => (browser ? fn() : console.warn(`skipped: ${name}`)), 90_000);

    /** A page in its own context (own cookies), logging what the browser complains about. */
    async function visitor(scheme: "light" | "dark" = "light") {
      const context = await browser!.newContext({ colorScheme: scheme, viewport: { width: 1100, height: 760 } });
      const page = await context.newPage();
      const problems: string[] = [];
      // Chrome says this when a page is left while its live socket is still connecting, which quick navigations in a test (and a slow CI runner) cause. It is not the app's.
      page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/WebSocket is closed before the connection is established/.test(m.text()) && problems.push(`${m.type()}: ${m.text()}`));
      page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
      return { page, problems, context };
    }
    const shot = async (page: Page, what: string) => shots && (await page.screenshot({ path: join(shots, `${name}-${what}.png`) }));

    test("the template type-checks and only imports what the browser may", async () => {
      const check = Bun.spawnSync(["bun", "check"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
      expect(check.stdout.toString() + check.stderr.toString()).toContain("No type errors");
      expect(await checkFrontendImports(join(dir, "forge"))).toEqual([]);
    }, 60_000);

    test("an anonymous visitor's home page has no JavaScript of its own: only the navigation script", async () => {
      const html = await fetch(srv.url).then((r) => r.text());
      const scripts = [...html.matchAll(/<script[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
      expect(scripts.length).toBe(1);
      expect(scripts[0]).toMatch(/\/nav-[^/]*\.js$/);
      expect(html).not.toContain("forge-state");
    });

    test("the home page is kept by the engine for anonymous visitors, and its inline scripts run under the hash policy", async () => {
      if (!native) return console.warn("skipped: the native engine is not built here");
      await fetch(srv.url);
      const again = await fetch(srv.url);
      expect(again.headers.get("etag")).toBeTruthy(); // made by the engine, which answered from its cache
      const csp = again.headers.get("content-security-policy") ?? "";
      expect(csp).not.toContain("nonce-");
      const scripts = [...(await again.text()).matchAll(/<script(?![^>]*\ssrc=)(?![^>]*application\/json)[^>]*>([\s\S]*?)<\/script>/g)];
      for (const [, body] of scripts) expect(csp).toContain(`'sha256-${new Bun.CryptoHasher("sha256").update(body!).digest("base64")}'`);
    });

    describe("the template, in a browser", () => {
      run("the home page is rendered and sends you to sign in", async () => {
        const { page, problems } = await visitor();
        await page.goto(srv.url, { waitUntil: "networkidle" });
        expect(await page.title()).toMatch(/^template/);
        expect(await page.textContent("h1")).toBe("Realtime. Full-stack. One deploy.");
        await shot(page, "home-light");
        await page.click("text=Get started");
        await page.waitForURL("**/sign-in");
        await page.waitForFunction(() => document.title === "Sign in"); // the route's <title> is applied just after the navigation
        await shot(page, "sign-in");
        expect(problems).toEqual([]);
      });

      run("signing up lands in the chat, and a message appears at once and live in another window", async () => {
        const ada = await visitor();
        await ada.page.goto(`${srv.url}/sign-in`, { waitUntil: "networkidle" });
        await ada.page.click("text=Create an account");
        await ada.page.fill("#name", "Ada");
        await ada.page.fill("#email", "ada@example.com");
        await ada.page.fill("#password", "correct horse battery");
        await ada.page.click("button:has-text('Create account')");
        await ada.page.waitForURL("**/chat");
        expect(await ada.page.textContent(".who")).toContain("Ada");
        expect(await ada.page.textContent(".chat-empty")).toContain("No messages yet");

        await ada.page.fill('input[aria-label="Message"]', "Hello from Ada");
        await ada.page.click("button:has-text('Send')");
        await ada.page.waitForSelector(".msg.mine:has-text('Hello from Ada')");
        expect(await ada.page.inputValue('input[aria-label="Message"]')).toBe("");

        const grace = await visitor("dark");
        await grace.page.goto(`${srv.url}/sign-in`, { waitUntil: "networkidle" });
        await grace.page.click("text=Create an account");
        await grace.page.fill("#name", "Grace");
        await grace.page.fill("#email", "grace@example.com");
        await grace.page.fill("#password", "correct horse battery");
        await grace.page.click("button:has-text('Create account')");
        await grace.page.waitForURL("**/chat");
        expect(await grace.page.textContent(".msg:has-text('Hello from Ada')")).toContain("Ada"); // from the other user, already loaded
        await grace.page.fill('input[aria-label="Message"]', "Hi Ada, it's Grace");
        await grace.page.click("button:has-text('Send')");

        await ada.page.waitForSelector(".msg:not(.mine):has-text(\"Hi Ada, it's Grace\")"); // live, no reload
        await shot(ada.page, "chat-light");
        await shot(grace.page, "chat-dark");
        expect(ada.problems).toEqual([]);
        expect(grace.problems).toEqual([]);
      });

      run("the chat is server-rendered for a signed-in visitor, and a reload keeps you in", async () => {
        const { page, problems } = await visitor();
        await page.goto(`${srv.url}/sign-in`, { waitUntil: "networkidle" });
        await page.fill("#email", "ada@example.com");
        await page.fill("#password", "correct horse battery");
        await page.click("button:has-text('Sign in')");
        await page.waitForURL("**/chat");
        const html = await page.request.get(`${srv.url}/chat`).then((r) => r.text());
        expect(html).toContain("Hello from Ada");
        expect(html).toContain("Ada"); // the viewer is in the document, not fetched afterwards
        await page.reload({ waitUntil: "networkidle" });
        expect(await page.textContent(".who")).toContain("Ada");
        expect(problems).toEqual([]);
      });

      run("message times are in the visitor's zone, from a server in another one, and the page hydrates without a complaint", async () => {
        const serverZone = process.env.TZ;
        process.env.TZ = "UTC"; // the server renders in UTC; the visitor is in Los Angeles
        try {
          const context = await browser!.newContext({ timezoneId: "America/Los_Angeles" });
          const page = await context.newPage();
          const problems: string[] = [];
          page.on("console", (m) => ["error", "warning"].includes(m.type()) && !/WebSocket is closed before the connection is established/.test(m.text()) && problems.push(`${m.type()}: ${m.text().slice(0, 300)}`));
          page.on("pageerror", (e) => problems.push(`pageerror: ${e.message.slice(0, 300)}`));
          await page.goto(`${srv.url}/sign-in`, { waitUntil: "networkidle" });
          await page.fill("#email", "ada@example.com");
          await page.fill("#password", "correct horse battery");
          await page.click("button:has-text('Sign in')");
          await page.waitForURL("**/chat");
          await page.goto(`${srv.url}/chat`, { waitUntil: "networkidle" }); // a server-rendered load, with the messages preloaded by the loader
          const sent = await page.getAttribute(".msg time", "datetime");
          const here = new Intl.DateTimeFormat("en-US", { timeStyle: "short", timeZone: "America/Los_Angeles" }).format(new Date(sent!));
          expect(await page.textContent(".msg time")).toBe(here);
          expect(problems).toEqual([]);
          await context.close();
        } finally {
          if (serverZone === undefined) delete process.env.TZ;
          else process.env.TZ = serverZone;
        }
      });

      run("signing out returns to the home page and closes the chat", async () => {
        const { page, problems } = await visitor();
        await page.goto(`${srv.url}/sign-in`, { waitUntil: "networkidle" });
        await page.fill("#email", "ada@example.com");
        await page.fill("#password", "correct horse battery");
        await page.click("button:has-text('Sign in')");
        await page.waitForURL("**/chat");
        await page.click("button:has-text('Sign out')");
        await page.waitForURL(srv.url + "/");
        await page.waitForSelector("a:has-text('Sign in')");
        await page.goto(`${srv.url}/chat`);
        await page.waitForURL("**/sign-in");
        expect(problems).toEqual([]);
      });

      run("a wrong password says so, and unknown pages get the 404 page", async () => {
        const { page } = await visitor();
        await page.goto(`${srv.url}/sign-in`, { waitUntil: "networkidle" });
        await page.fill("#email", "ada@example.com");
        await page.fill("#password", "wrong password here");
        await page.click("button:has-text('Sign in')");
        await page.waitForSelector("[role=alert]");
        expect((await page.textContent("[role=alert]"))!.length).toBeGreaterThan(3);
        const missing = await page.goto(`${srv.url}/nowhere`);
        expect(missing!.status()).toBe(404);
        expect(await page.textContent("h1")).toBe("Page not found");
        await shot(page, "not-found");
      });

      if (shadcn)
        run("Tailwind is compiled into the page, the theme applies, and dark mode follows the system, toggles and sticks", async () => {
          const { page, problems } = await visitor();
          await page.goto(srv.url, { waitUntil: "networkidle" });
          const css = (selector: string, property: "backgroundColor" | "fontSize") => page.locator(selector).first().evaluate((el, p) => getComputedStyle(el)[p], property);
          expect(await css("text=Get started", "backgroundColor")).not.toBe("rgba(0, 0, 0, 0)"); // the button's utilities and theme variables reached it
          expect(parseFloat(await css("h1", "fontSize"))).toBeGreaterThan(40);
          const light = await css("body", "backgroundColor");
          const isDark = () => page.evaluate(() => document.documentElement.classList.contains("dark"));
          expect(await isDark()).toBe(false);
          await shot(page, "home-light");
          await page.click('button[aria-label="Toggle dark mode"]');
          expect(await isDark()).toBe(true);
          expect(await css("body", "backgroundColor")).not.toBe(light);
          await shot(page, "home-dark");
          await page.reload({ waitUntil: "networkidle" });
          expect(await isDark()).toBe(true); // remembered, and set before the first paint

          const system = await visitor("dark");
          await system.page.goto(srv.url, { waitUntil: "networkidle" });
          expect(await system.page.evaluate(() => document.documentElement.classList.contains("dark"))).toBe(true); // nothing saved: the system's choice
          expect(problems).toEqual([]); // no hydration mismatch from the theme script or the components
          expect(system.problems).toEqual([]);
        });
    });
  });
}

suite("the template", "template");
suite("the template with shadcn/ui", "template-ui", "neutral");

afterAll(() => rmSync(TMP, { recursive: true, force: true }));
