#!/usr/bin/env bun
// bun create archlast-forge my-app   (or: bunx create-archlast-forge my-app)
import { cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const TEMPLATE = new URL("../template", import.meta.url).pathname;
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

/** Copies the template into `dir`, filling in the app name and package versions. */
export function scaffold(dir: string, version = VERSION) {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} isn't empty`);
  const name = basename(target).toLowerCase().replace(/[^a-z0-9-]+/g, "-");
  cpSync(TEMPLATE, target, { recursive: true });
  renameSync(join(target, "gitignore"), join(target, ".gitignore")); // npm drops .gitignore files from packages
  const fill = (path: string) => {
    for (const entry of readdirSync(path)) {
      const p = join(path, entry);
      if (statSync(p).isDirectory()) fill(p);
      else writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__VERSION__", version));
    }
  };
  fill(target);
  return target;
}

if (import.meta.main) {
  const dir = process.argv[2];
  if (!dir) {
    console.log("Usage: bun create archlast-forge <directory>");
    process.exit(1);
  }
  try {
    const target = scaffold(dir);
    console.log(`✓ created ${target}\n\nNext:\n  cd ${dir}\n  bun install\n  bun run dev        # backend (Docker) + Vite; add --no-docker to run without Docker\n`);
  } catch (e) {
    console.error(`✗ ${(e as Error).message}`);
    process.exit(1);
  }
}
