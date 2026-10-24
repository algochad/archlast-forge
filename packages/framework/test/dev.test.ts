import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunningServer } from "@archlast-forge/runtime/server";
import { fixture, startFixture } from "./helpers";

// Inside the package, so the copy resolves the same node_modules as the fixture.
const root = join(import.meta.dir, ".tmp", `dev-${process.pid}`);
let srv: RunningServer;

beforeAll(async () => {
  mkdirSync(root, { recursive: true });
  cpSync(fixture, root, { recursive: true, filter: (src) => !src.includes(`${fixture}/.forge`) });
  srv = await startFixture({ root, dev: true });
}, 30_000);
afterAll(async () => {
  await srv.stop({ graceful: false });
  rmSync(join(import.meta.dir, ".tmp"), { recursive: true, force: true });
}, 30_000);

/** Collects server-sent events from the dev reload channel. */
async function events() {
  const abort = new AbortController();
  const res = await fetch(`${srv.url}/_app/__events`, { signal: abort.signal });
  const reader = res.body!.getReader();
  const seen: { type: string; message?: string }[] = [];
  const decoder = new TextDecoder();
  void (async () => {
    let buffer = "";
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value);
        for (const part of buffer.split("\n\n").slice(0, -1)) if (part.startsWith("data: ")) seen.push(JSON.parse(part.slice(6)));
        buffer = buffer.slice(buffer.lastIndexOf("\n\n") + 2);
      }
    } catch {} // closed by the test
  })();
  return {
    seen,
    next: async (type: string, ms = 8000) => {
      for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(20)) {
        const found = seen.findIndex((e) => e.type === type);
        if (found >= 0) return seen.splice(0, found + 1).at(-1)!;
      }
      throw new Error(`no "${type}" event within ${ms} ms; saw ${JSON.stringify(seen)}`);
    },
    close: () => abort.abort(),
  };
}

const write = (file: string, text: string) => writeFileSync(join(root, file), text);
const page = async (path = "/") => fetch(`${srv.url}${path}`);

test("dev pages load the reload script and don't cache assets", async () => {
  const res = await page();
  const html = await res.text();
  expect(res.status).toBe(200);
  expect(html).toContain('src="/_app/__dev.js"');
  const script = await fetch(`${srv.url}/_app/__dev.js`);
  expect(script.headers.get("content-type")).toContain("javascript");
  expect(await script.text()).toContain("EventSource");
  const entry = /src="\/_app\/(entry\.client-[^"]+\.js)"/.exec(html)![1]!;
  expect((await fetch(`${srv.url}/_app/${entry}`)).headers.get("cache-control")).toBe("no-cache");
}, 30_000);

test("saving a file rebuilds and tells the browser to reload", async () => {
  const ev = await events();
  write("app/routes/about.tsx", `export default function About() { return <main><h1 id="about">About, edited</h1></main>; }`);
  await ev.next("reload");
  expect(await (await page("/about")).text()).toContain("About, edited");
  ev.close();
}, 30_000);

test("a new file is a new route, with no restart", async () => {
  const ev = await events();
  write("app/routes/fresh.tsx", `export default function Fresh() { return <p id="fresh">brand new</p>; }`);
  await ev.next("reload");
  const res = await page("/fresh");
  expect(res.status).toBe(200);
  expect(await res.text()).toContain("brand new");
  ev.close();
}, 30_000);

test("a build error shows on the page and in connected browsers, and fixing it recovers", async () => {
  const ev = await events();
  write("app/routes/about.tsx", `export default function About() { return <main>; }`); // syntax error
  const err = await ev.next("error");
  expect(err.message).toContain("about.tsx");
  const res = await page("/about");
  expect(res.status).toBe(500);
  const html = await res.text();
  expect(html).toContain("Build failed");
  expect(html).toContain("about.tsx");
  expect(html).toContain("/_app/__dev.js"); // so it reloads itself once fixed

  write("app/routes/about.tsx", `export default function About() { return <main><h1 id="about">About, fixed</h1></main>; }`);
  await ev.next("reload");
  expect(await (await page("/about")).text()).toContain("About, fixed");
  ev.close();
}, 30_000);

test("a route that conflicts with another is reported, not silently picked", async () => {
  const ev = await events();
  mkdirSync(join(root, "app/routes/about"), { recursive: true });
  write("app/routes/about/index.tsx", `export default function A() { return null; }`);
  const err = await ev.next("error");
  expect(err.message).toContain("both answer /about");
  rmSync(join(root, "app/routes/about"), { recursive: true });
  await ev.next("reload");
  ev.close();
}, 30_000);

test("changing a public file reloads without rebuilding", async () => {
  const ev = await events();
  const before = (await (await page()).text()).match(/entry\.client-[\w]+\.js/)![0];
  write("public/robots.txt", "User-agent: googlebot\n");
  await ev.next("reload");
  expect(await (await page("/robots.txt")).text()).toContain("googlebot");
  expect((await (await page()).text()).match(/entry\.client-[\w]+\.js/)![0]).toBe(before);
  ev.close();
}, 30_000);
