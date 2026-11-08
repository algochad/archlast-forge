import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RunningServer } from "@archlast/forge-runtime/server";
import { readBuild } from "../src/build";
import { hasNativeEngine, signUp, startFixture } from "./helpers";

// The same app served twice by the native engine: once printing the pages it can from templates, once by React alone (FORGE_TEMPLATES=0 at build time).
// What a browser would show must be the same.
const root = join(import.meta.dir, "fixture-templates");
let templated: RunningServer;
let reacted: RunningServer;
let native = false;

beforeAll(async () => {
  native = await hasNativeEngine();
  if (!native) return;
  process.env.FORGE_TEMPLATES = "0";
  try {
    reacted = await startFixture({ root, islands: true, env: { HTTP_ENGINE: "archlast" } });
  } finally {
    delete process.env.FORGE_TEMPLATES;
  }
  templated = await startFixture({ root, islands: true, env: { HTTP_ENGINE: "archlast" } });
}, 180_000);
afterAll(async () => {
  await templated?.stop({ graceful: false });
  await reacted?.stop({ graceful: false });
});

/** What a browser would see, with what only a byte comparison would notice taken out: attribute order, React's text separators, the scripts and resource links. */
function normal(html: string) {
  return html
    .replaceAll("<!-- -->", "")
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/g, "")
    .replace(/<link\b[^>]*rel="(?:modulepreload|stylesheet|preload)"[^>]*\/?>/g, "")
    .replace(/<(\w+)((?:\s[^>]*?)?)(\/?)>/g, (_, tag, attrs, close) => `<${tag}${(attrs.match(/\s[^\s=]+(?:="[^"]*")?/g) ?? []).map((a: string) => a.replace(/\snonce="[^"]*"/, "")).filter(Boolean).sort().join("")}${close}>`)
    .replace(/<head>([\s\S]*?)<\/head>/, (_, inner: string) => `<head>${(inner.match(/<(?:title|meta|link)\b[^>]*>(?:[^<]*<\/title>)?/g) ?? []).sort().join("")}</head>`)
    .replace(/\s+/g, " ")
    .trim();
}

const get = (s: RunningServer, path: string, cookie?: string) => fetch(`${s.url}${path}`, cookie ? { headers: { cookie } } : undefined).then(async (r) => ({ status: r.status, html: await r.text(), headers: r.headers }));

describe("pages printed by the engine from templates", () => {
  test("the build compiled the pages it understands and says why it left the others", () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const t = readBuild(root)!.manifest.templates!;
    expect([...t.routes].sort()).toEqual(["routes/index", "routes/items/index"]);
    expect(t.reasons["routes/odd"]).toContain("call");
  });

  for (const path of ["/", "/items", "/odd", "/nope"]) {
    test(`${path}: the same page as React prints`, async () => {
      if (!native) return console.warn("skipped: the native engine is not built here");
      const [a, b] = await Promise.all([get(templated, path), get(reacted, path)]);
      expect(a.status).toBe(b.status);
      expect(normal(a.html)).toBe(normal(b.html));
      expect(a.headers.get("content-type")).toContain("text/html");
      expect(a.headers.get("x-forge-template")).toBeNull(); // the note to the engine is never sent
      expect(a.headers.get("content-security-policy")).toBeTruthy();
    });
  }

  test("a signed-in visitor sees their own page, printed from the same template", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const cookie = await signUp(templated, "tpl@example.com", "Ada <Lovelace>");
    const cookie2 = await signUp(reacted, "tpl@example.com", "Ada <Lovelace>");
    const [a, b] = await Promise.all([get(templated, "/", cookie), get(reacted, "/", cookie2)]);
    expect(normal(a.html)).toBe(normal(b.html));
    expect(a.html).toContain("Welcome back, Ada &lt;Lovelace&gt;");
    expect(a.html).toContain('id="member"');
    // and the page for a visitor who is not signed in has none of it
    expect((await get(templated, "/")).html).not.toContain("Welcome back");
  });

  test("the active link follows the address", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const items = (await get(templated, "/items")).html;
    expect(items).toMatch(/<a [^>]*href="\/items"[^>]*aria-current="page"|<a [^>]*aria-current="page"[^>]*href="\/items"/);
    const home = (await get(templated, "/")).html;
    expect(home).not.toMatch(/href="\/items"[^>]*aria-current/);
  });

  test("HEAD and a conditional request work on a printed page", async () => {
    if (!native) return console.warn("skipped: the native engine is not built here");
    const head = await fetch(`${templated.url}/items`, { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});
