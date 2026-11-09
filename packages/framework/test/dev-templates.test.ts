import { afterAll, beforeAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RunningServer } from "@archlast/forge-runtime/server";
import { readBuild } from "../src/build";
import { hasNativeEngine, startFixture } from "./helpers";

// Development with islands and templates: a saved file rebuilds, and the page is printed from the new template, or by React where the new code is not one.
const source = join(import.meta.dir, "fixture-templates");
const root = join(import.meta.dir, ".tmp", `dev-templates-${process.pid}`);
let srv: RunningServer;
let native = false;

beforeAll(async () => {
  native = await hasNativeEngine();
  if (!native) return;
  mkdirSync(root, { recursive: true });
  cpSync(source, root, { recursive: true, filter: (src) => !src.includes(`${source}/.forge`) });
  srv = await startFixture({ root, dev: true, islands: true, env: { HTTP_ENGINE: "archlast" } });
}, 60_000);
afterAll(async () => {
  await srv?.stop({ graceful: false });
  rmSync(join(import.meta.dir, ".tmp"), { recursive: true, force: true });
}, 30_000);

async function seen(path: string, text: string, ms = 10_000) {
  let html = "";
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    html = await fetch(`${srv.url}${path}`).then((r) => r.text());
    if (html.includes(text)) return html;
  }
  throw new Error(`"${text}" never showed on ${path}: ${html.slice(0, 400)}`);
}

/** The routes the last build printed from templates (the manifest is written just after the server switches to a build). */
async function compiled(route: string, want: boolean, ms = 5000) {
  let routes: string[] = [];
  for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) {
    routes = readBuild(root)?.manifest.templates?.routes ?? [];
    if (routes.includes(route) === want) return;
  }
  throw new Error(`${route} ${want ? "was not" : "was"} compiled: ${routes} ${JSON.stringify(readBuild(root)?.manifest.templates?.reasons)}`);
}

test("a saved page is printed from its new template; a saved page the compiler cannot read is printed by React", async () => {
  if (!native) return console.warn("skipped: the native engine is not built here");
  await seen("/", "Welcome");
  writeFileSync(join(root, "app/routes/index.tsx"), `export default function Home() { return <main id="main"><h1>Edited once</h1><ul>{[1, 2].map((n) => <li key={n}>row {n}</li>)}</ul></main>; }`);
  const once = await seen("/", "Edited once");
  expect(once).toContain("row ");
  expect(once).toContain("/_app/__dev.js");
  await compiled("routes/index", true);
  writeFileSync(join(root, "app/routes/index.tsx"), `export default function Home() { const w = ["b", "a"].sort().join("-"); return <main id="main"><h1>{\`Edited twice \${w}\`}</h1></main>; }`);
  expect(await seen("/", "Edited twice a-b")).toContain("/_app/__dev.js");
  await compiled("routes/index", false);
  writeFileSync(join(root, "app/routes/index.tsx"), `export default function Home() { return <main id="main"><h1>Edited thrice</h1></main>; }`);
  expect(await seen("/", "Edited thrice")).not.toContain("Edited twice");
}, 60_000);
