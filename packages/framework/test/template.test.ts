import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import type { Browser, Page } from "playwright-core";
import { checkFrontendImports, codegen } from "../../cli/src/codegen";
import { buildApp } from "../src/build";
import { launchBrowser } from "./browser";
import { startFixture } from "./helpers";
import { templateProject, TMP } from "./template";

let dir: string;
let browser: Browser | undefined;
let srv: Awaited<ReturnType<typeof startFixture>>;
const shots = process.env.SCREENSHOTS;

beforeAll(async () => {
  dir = templateProject("template");
  await codegen(join(dir, "forge"));
  browser = await launchBrowser();
  if (!browser) return;
  await buildApp({ root: dir, dev: false });
  srv = await startFixture({ root: dir });
}, 120_000);
afterAll(async () => {
  await browser?.close();
  await srv?.stop({ graceful: false });
  rmSync(TMP, { recursive: true, force: true });
});

const run = (name: string, fn: () => Promise<void>) => test(name, async () => (browser ? fn() : console.warn(`skipped: ${name}`)), 90_000);

/** A page in its own context (own cookies), logging what the browser complains about. */
async function visitor(scheme: "light" | "dark" = "light") {
  const context = await browser!.newContext({ colorScheme: scheme, viewport: { width: 1100, height: 760 } });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("console", (m) => ["error", "warning"].includes(m.type()) && problems.push(`${m.type()}: ${m.text()}`));
  page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
  return { page, problems, context };
}
const shot = async (page: Page, name: string) => shots && (await page.screenshot({ path: join(shots, `${name}.png`) }));

test("the template type-checks and only imports what the browser may", async () => {
  const check = Bun.spawnSync(["bun", "check"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  expect(check.stdout.toString() + check.stderr.toString()).toContain("No type errors");
  expect(await checkFrontendImports(join(dir, "forge"))).toEqual([]);
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
});
