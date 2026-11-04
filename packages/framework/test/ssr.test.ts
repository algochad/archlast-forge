import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { RunningServer } from "@archlast/forge-runtime/server";
import { readBuild } from "../src/build";
import { fixture, signUp, startFixture, stateOf } from "./helpers";

let srv: RunningServer;
let cookie: string;
const get = (path: string, init?: RequestInit) => fetch(`${srv.url}${path}`, { redirect: "manual", ...init });
const html = async (path: string, init?: RequestInit) => (await get(path, init)).text();

const ADMIN = "a".repeat(32);

beforeAll(async () => {
  srv = await startFixture({ env: { ADMIN_KEY: ADMIN, DASHBOARD: "on" } });
  cookie = await signUp(srv, "ada@example.com", "Ada");
  // Two messages, so the home page has live data to preload.
  for (const body of ["first", "second"]) {
    const res = await fetch(`${srv.url}/rpc/messages:send`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify({ body }) });
    expect(res.status).toBe(200);
  }
});
afterAll(() => srv.stop({ graceful: false }));

describe("pages", () => {
  test("a page is a full document with its loader's live query already filled in", async () => {
    const res = await get("/");
    const page = await res.text();
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(page.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(page).toContain('<html lang="en">');
    expect(page).toContain("<li>second</li><li>first</li>"); // rendered on the server, newest first
    const state = stateOf(page);
    expect(state.hydration.loaderData["routes/index"]).toEqual({ title: "Home" });
    expect(JSON.stringify(state.queries)).toContain("second"); // seeded into the browser's live cache
    expect(state.viewer).toBeNull();
    expect(page).toContain("Signed out");
  });

  test("the document links its stylesheet and scripts, and preloads the route's code", async () => {
    const page = await html("/");
    const { manifest } = readBuild(fixture)!;
    expect(page).toContain(`<link rel="stylesheet" href="/_app/${manifest.css[0]}"`);
    expect(page).toContain(`<script type="module" src="/_app/${manifest.entry}"`);
    for (const chunk of manifest.routes["routes/index"]!.filter((f) => f !== manifest.entry)) expect(page).toContain(`rel="modulepreload"`), expect(page).toContain(`/_app/${chunk}`);
    expect(page.match(/<title>/g)?.length).toBe(1); // the route's <title>, hoisted into <head>
    expect(page).toMatch(/<head>.*<title>Home page<\/title>.*<\/head>/s);
  });

  test("params, nested layouts and loader data", async () => {
    const page = await html("/blog/hello-world");
    expect(page).toContain('id="blog-layout"');
    expect(page).toContain("<h3>hello-world</h3><p>HELLO-WORLD</p>");
    expect(await html("/blog")).toContain('id="blog-index"');
  });

  test("unknown paths are 404 pages inside the document; a thrown response sets its status", async () => {
    const nope = await get("/no/such/page");
    expect(nope.status).toBe(404);
    const body = await nope.text();
    expect(body).toContain("Page not found");
    expect(body).toContain('<html lang="en">');
    const missing = await get("/blog/missing");
    expect(missing.status).toBe(404);
    expect(await missing.text()).toContain("No such post");
  });

  test("a loader can redirect, based on who is asking", async () => {
    const anon = await get("/secret");
    expect(anon.status).toBe(302);
    expect(anon.headers.get("location")).toBe("/sign-in");
    const member = await get("/secret", { headers: { cookie } });
    expect(member.status).toBe(200);
    expect(await member.text()).toContain("Only for members");
  });

  test("the signed-in viewer is rendered on the server and handed to the browser", async () => {
    const page = await html("/", { headers: { cookie } });
    expect(page).toContain("Hi Ada");
    expect(stateOf(page).viewer).toMatchObject({ email: "ada@example.com", name: "Ada" });
    expect(await html("/", { headers: { cookie: "better-auth.session_token=forged" } })).toContain("Signed out");
  });

  test("errors: ForgeErrors reach the page, other failures are hidden outside dev", async () => {
    const forge = await get("/forge-error");
    expect(forge.status).toBe(500);
    const forgeBody = await forge.text();
    expect(forgeBody).toContain("NOPE");

    for (const path of ["/boom", "/crashing-query"]) {
      const res = await get(path, { headers: { "x-request-id": "req-fw-1" } });
      const body = await res.text();
      expect(res.status).toBe(500);
      expect(body).not.toContain("hunter2");
      expect(body).toMatch(/Server error \(request req-fw-1\)|Something went wrong/);
    }
  });

  test("a component that throws while rendering is a plain 500 with no details", async () => {
    const res = await get("/broken-render", { headers: { "x-request-id": "req-fw-2" } });
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain("secret detail");
  });

  test("what a visitor types can't break out of the page or its embedded data", async () => {
    const attack = `</script><script>window.pwn=1</script>\u2028<img src=x onerror=alert(1)>`;
    const page = await html(`/echo?q=${encodeURIComponent(attack)}`);
    expect(page).not.toContain("</script><script>window.pwn");
    expect(page).not.toContain("<img src=x");
    expect(page).toContain("&lt;img src=x onerror=alert(1)&gt;"); // escaped as text where it is shown
    expect(stateOf(page).hydration.loaderData["routes/echo"]).toEqual({ text: attack }); // and intact where it is data
    expect(page.match(/<script/g)!.length).toBe(2); // the data and the entry: nothing was added
  });

  test("only GET and HEAD reach pages", async () => {
    expect((await get("/", { method: "POST", body: "x" })).status).toBe(404);
    const head = await get("/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });
});

describe("assets and public files", () => {
  test("built files are immutable, compressed when the browser accepts it, and have the right type", async () => {
    const { manifest } = readBuild(fixture)!;
    const plain = await get(`/_app/${manifest.entry}`, { headers: { "accept-encoding": "identity" } });
    expect(plain.status).toBe(200);
    expect(plain.headers.get("content-type")).toContain("javascript");
    expect(plain.headers.get("cache-control")).toBe("public, max-age=31536000, immutable");
    const original = await plain.text();

    const br = await get(`/_app/${manifest.entry}`, { headers: { "accept-encoding": "gzip, br" } });
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("content-type")).toContain("javascript");
    expect(br.headers.get("vary")).toContain("accept-encoding");
    expect(Number(br.headers.get("content-length") ?? 0) || (await br.arrayBuffer()).byteLength).toBeLessThan(original.length / 2);

    const gz = await get(`/_app/${manifest.entry}`, { headers: { "accept-encoding": "gzip" } });
    expect(gz.headers.get("content-encoding")).toBe("gzip");

    const css = await get(`/_app/${manifest.css[0]}`);
    expect(css.headers.get("content-type")).toContain("css");
    expect(await css.text()).toContain("rebeccapurple");
  });

  test("a file that isn't there is a 404, and paths can't climb out", async () => {
    expect((await get("/_app/nothing.js")).status).toBe(404);
    for (const path of ["/_app/..%2f..%2fmanifest.json", "/_app/%2e%2e/manifest.json", "/_app/../manifest.json", "/_app/%00", "/..%2fpackage.json", "/%2e%2e/forge/schema.ts", "/.env", "/forge/schema.ts"]) {
      const res = await get(path);
      expect(res.status === 404 || res.status === 400).toBe(true);
      expect(await res.text()).not.toContain("defineSchema");
    }
  });

  test("public/ files are served at the root, dotfiles other than .well-known are not", async () => {
    const robots = await get("/robots.txt");
    expect(robots.status).toBe(200);
    expect(await robots.text()).toContain("User-agent");
    expect(await (await get("/.well-known/security.txt")).text()).toContain("contact");
    expect((await get("/.gitignore")).status).toBe(404);
  });
});

describe("the engine around it", () => {
  test("engine routes keep working next to the app", async () => {
    expect((await get("/health")).status).toBe(200);
    const rpc = await fetch(`${srv.url}/rpc/messages:count`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(((await rpc.json()) as any).result).toBe(2);
  });

  test("page renders are requests named by their route, with the loaders' calls in their trace; assets are not", async () => {
    await html("/blog/first-post");
    await html("/blog/second-post");
    await get(`/_app/${readBuild(fixture)!.manifest.entry}`);
    const read = async (op: string, input: object) => (await (await fetch(`${srv.url}/_admin/${op}?input=${encodeURIComponent(JSON.stringify(input))}`, { headers: { "x-admin-key": ADMIN } })).json()) as any;
    const range = { from: Date.now() - 600_000, to: Date.now() + 60_000 };
    let pages: any[] = [];
    for (let i = 0; i < 40 && !(pages.find((o) => o.operation === "GET /blog/:slug")?.count >= 2); i++) {
      await Bun.sleep(150);
      pages = (await read("obs.requests", { ...range, kind: "page" })).operations;
    }
    // Other tests here open blog pages too: at least these two.
    expect(pages.find((o) => o.operation === "GET /blog/:slug")?.count).toBeGreaterThanOrEqual(2);
    expect(pages.some((o) => o.operation.includes("/_app/"))).toBe(false);
    expect(pages.some((o) => o.operation === "GET (unmatched)")).toBe(true); // a 404 page is one name, whatever the URL was
    await html("/");
    let home: any[] = [];
    for (let i = 0; i < 40 && !home.length; i++) {
      await Bun.sleep(150);
      home = (await read("obs.operation", { ...range, kind: "page", operation: "GET /" })).calls.filter((c: any) => c.status === 200);
    }
    const trace = await read("obs.trace", { traceId: home[0].trace_id });
    // The loader's live query, run or answered from the cache, inside the page's trace.
    expect(trace.spans.some((s: any) => s.name === "messages:list")).toBe(true);
  });
});

test("app/root.tsx's authPlugins reach useAuth() on the server render", async () => {
  expect(await html("/plugin")).toContain("hello, server and browser");
});
