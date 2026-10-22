#!/usr/bin/env bun
// Sets one version on every published package (they're released in lockstep): bun scripts/version.ts 0.2.0
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const version = process.argv[2];
if (!version || !/^\d+\.\d+\.\d+(-[\w.]+)?$/.test(version)) {
  console.error("Usage: bun scripts/version.ts <x.y.z>");
  process.exit(1);
}
const root = join(import.meta.dir, "..", "packages");
for (const dir of readdirSync(root)) {
  const file = join(root, dir, "package.json");
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  pkg.version = version;
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`${pkg.name} → ${version}`);
}
