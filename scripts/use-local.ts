#!/usr/bin/env bun
// Use this checkout's packages in another project before (or without) publishing them to npm:
//   bun scripts/use-local.ts ../my-other-project
// It packs every package, points the project's @archlast-forge/* and create-archlast-forge dependencies at the tarballs in .pack/, and installs.
// Run it again after changing archlast-forge to pick the changes up.
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const project = resolve(process.argv[2] ?? "");
if (!process.argv[2] || !existsSync(join(project, "package.json"))) {
  console.error("Usage: bun scripts/use-local.ts <project directory>   (it must have a package.json)");
  process.exit(1);
}
const run = (cmd: string[], cwd: string) => {
  if (Bun.spawnSync(cmd, { cwd, stdout: "inherit", stderr: "inherit" }).exitCode !== 0) process.exit(1);
};
run(["bun", "scripts/pack.ts"], ROOT);

const overrides: Record<string, string> = {};
for (const f of readdirSync(join(ROOT, ".pack")).filter((f) => f.endsWith(".tgz"))) {
  const name = f.replace(/-\d+\.\d+\.\d+.*\.tgz$/, "").replace(/^archlast-forge-/, "@archlast-forge/");
  overrides[name] = `file:${join(ROOT, ".pack", f)}`;
}
// forge/ has its own package.json in a project made by archlast-forge.
for (const file of [join(project, "package.json"), join(project, "forge", "package.json")].filter(existsSync)) {
  const pkg = JSON.parse(readFileSync(file, "utf8"));
  for (const field of ["dependencies", "devDependencies"]) for (const dep of Object.keys(pkg[field] ?? {})) if (overrides[dep]) pkg[field][dep] = overrides[dep];
  pkg.overrides = { ...pkg.overrides, ...overrides }; // transitive ones too
  writeFileSync(file, JSON.stringify(pkg, null, 2) + "\n");
}
// A tarball keeps its name when it changes, so bun would reuse what it installed last time.
for (const stale of ["node_modules", "bun.lock", "forge/node_modules", "forge/bun.lock", "forge/_generated/.depshash"]) rmSync(join(project, stale), { recursive: true, force: true });
run(["bun", "install"], project);
console.log(`\n✓ ${project} now uses the packages in ${join(ROOT, ".pack")}`);
