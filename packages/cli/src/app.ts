// Framework mode, from the CLI's side: find the framework package in the project, build the app, and describe the result.
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./common";
import { c, task } from "./ui";

type Server = typeof import("@archlast-forge/framework/server");
type Build = typeof import("@archlast-forge/framework/build");
type Parts = { server: Server; build: Build };

/**
 * Loads @archlast-forge/framework/<part> from the project. Inside the engine image the project's copy is a link to the engine's own,
 * and a checkout of this repository finds it next to the CLI.
 */
export async function loadFramework<P extends keyof Parts>(root: string, part: P): Promise<Parts[P]> {
  const spec = `@archlast-forge/framework/${part}`;
  const sibling = new URL(`../../framework/src/${part === "server" ? "server.tsx" : "build.ts"}`, import.meta.url).pathname;
  for (const from of [() => Bun.resolveSync(spec, root), () => sibling]) {
    try {
      const path = from();
      if (existsSync(path)) return (await import(path)) as Parts[P];
    } catch {
      // try the next place
    }
  }
  return fail(`This is a full-stack project, which needs @archlast-forge/framework. Install it with:\n  bun add @archlast-forge/framework`);
}

const kb = (bytes: number) => `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} kB`;

/** Builds the production bundles into <root>/.forge/build and prints what the browser will download. */
export async function buildFramework(root: string) {
  const { buildApp } = await loadFramework(root, "build");
  const { manifest, dir } = await task("Building the app", () => buildApp({ root, dev: false })).catch((e: Error) => fail(e.message));
  const client = join(dir, "client");
  const size = (file: string, ext = "") => (existsSync(join(client, file + ext)) ? statSync(join(client, file + ext)).size : 0);
  const chunks = readdirSync(client).filter((f) => f.endsWith(".js"));
  const total = chunks.reduce((n, f) => n + size(f), 0);
  const first = [manifest.entry, ...manifest.css];
  console.log(`  ${c.dim("first load")}  ${first.map((f) => `${f.replace(/-[a-z0-9]+(\.\w+)$/, "$1")} ${kb(size(f))} ${c.dim(`(${kb(size(f, ".br") || size(f, ".gz") || size(f))} compressed)`)}`).join(", ")}`);
  console.log(`  ${c.dim("all code ")}  ${chunks.length} files, ${kb(total)}; each page loads only the routes it shows`);
  return { manifest, dir };
}
