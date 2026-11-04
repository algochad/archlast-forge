// `archlast-forge upgrade`: moves a project, backend or full-stack app, to another release of archlast-forge, or every app and package of a monorepo.
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { addPrettier } from "create-archlast-forge";
import { findWorkspaceRoot } from "create-archlast-forge/workspace";
import { generate } from "./common";
import { ensureDeps } from "./deps";
import { projectRoot } from "./project";
import { ok, step } from "./ui";

const SEMVER = String.raw`\d+\.\d+\.\d+(?:-[\w.]+)?`;
/** A dependency on one of the packages released together (scripts/version.ts), at a version or a ^/~ range: `workspace:`, `file:` and tags are left alone. */
const DEPENDENCY = new RegExp(String.raw`"(@archlast/forge-[\w-]+|create-archlast-forge)"(\s*:\s*)"([~^]?)(${SEMVER})"`, "g");
/** The engine image `init` writes into the Dockerfile and compose.yaml, when its tag is a version. */
const IMAGE = new RegExp(String.raw`(ghcr\.io/algochad/archlast-forge-engine:)(${SEMVER})(?![\w.-])`, "g");

export interface UpgradeChange {
  file: string;
  name: string;
  from: string;
  to: string;
}

/**
 * Points the project at `version`: the archlast-forge packages in package.json and forge/package.json, and the engine image in the
 * Dockerfile and compose.yaml. The files are edited as text, so their formatting and everything else in them stay as they were.
 */
export function upgradeFiles(forgeDir: string, version: string): UpgradeChange[] {
  const root = projectRoot(forgeDir);
  const changes: UpgradeChange[] = [];
  const edit = (path: string, re: RegExp, change: (m: string[]) => { name: string; from: string; to: string; replacement: string }) => {
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    const next = text.replace(re, (...m: string[]) => {
      const { replacement, ...ch } = change(m);
      if (ch.from === ch.to) return m[0]!;
      changes.push({ file: relative(root, path), ...ch });
      return replacement;
    });
    if (next !== text) writeFileSync(path, next);
  };
  for (const path of new Set([join(root, "package.json"), join(forgeDir, "package.json")]))
    edit(path, DEPENDENCY, ([, name, sep, prefix, from]) => ({ name: name!, from: prefix! + from, to: prefix! + version, replacement: `"${name}"${sep}"${prefix}${version}"` }));
  for (const file of ["Dockerfile", "compose.yaml"]) edit(join(root, file), IMAGE, ([, image, from]) => ({ name: "engine image", from: from!, to: version, replacement: image + version }));
  changes.push(...rootBunTypes(root, forgeDir));
  return changes;
}

/** `"types": []`, as older full-stack scaffolds wrote it in the root tsconfig.json. */
const NO_TYPES = /("types"\s*:\s*)\[\s*\]/;

/**
 * A full-stack app's root type-check reads the forge/ files its pages reach through `forge/_generated/api`, and those use `process.env`,
 * `Bun` and `node:` modules. Older scaffolds gave the root no types (`"types": []`), so the check failed with "Cannot find name 'process'":
 * the root gets Bun's types, as forge/ has them.
 */
function rootBunTypes(root: string, forgeDir: string): UpgradeChange[] {
  const tsconfig = join(root, "tsconfig.json");
  const manifest = join(root, "package.json");
  if (root === forgeDir || !existsSync(tsconfig) || !existsSync(manifest)) return [];
  const text = readFileSync(tsconfig, "utf8");
  if (!NO_TYPES.test(text)) return [];
  const changes: UpgradeChange[] = [{ file: "tsconfig.json", name: "compilerOptions.types", from: "[]", to: '["bun"]' }];
  writeFileSync(tsconfig, text.replace(NO_TYPES, '$1["bun"]'));
  const raw = readFileSync(manifest, "utf8");
  const pkg = JSON.parse(raw) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  if (!pkg.devDependencies?.["@types/bun"] && !pkg.dependencies?.["@types/bun"]) {
    let forgeTypes: string | undefined;
    try {
      forgeTypes = JSON.parse(readFileSync(join(forgeDir, "package.json"), "utf8")).devDependencies?.["@types/bun"];
    } catch {}
    const to = forgeTypes ?? "1.4.4";
    pkg.devDependencies = Object.fromEntries(Object.entries({ ...pkg.devDependencies, "@types/bun": to }).sort(([a], [b]) => a.localeCompare(b)));
    const indent = /^\{\n([ \t]+)"/.exec(raw)?.[1] ?? 2;
    writeFileSync(manifest, JSON.stringify(pkg, null, indent) + "\n");
    changes.push({ file: "package.json", name: "@types/bun", from: "none", to });
  }
  return changes;
}

/**
 * A monorepo moves as one: the packages of one release are meant to run together (a service and the app that calls it over Forge RPC, the phone
 * app and the engine it talks to), and a caret range on 0.x doesn't cross a minor, so one left behind stays behind. Each app that is a project
 * (an archlast-forge.json) is upgraded as `upgradeFiles` does it; the other apps and packages (the phone app, desktop app, packages/api) only
 * have their dependencies on the packages moved. Paths in the result are relative to the monorepo's root.
 */
export function upgradeWorkspaceFiles(root: string, version: string): UpgradeChange[] {
  const changes: UpgradeChange[] = [];
  const manifest = (dir: string) => {
    const path = join(dir, "package.json");
    if (!existsSync(path)) return;
    const text = readFileSync(path, "utf8");
    const next = text.replace(DEPENDENCY, (whole, name: string, sep: string, prefix: string, from: string) => {
      if (from === version) return whole;
      changes.push({ file: relative(root, path), name, from: prefix + from, to: prefix + version });
      return `"${name}"${sep}"${prefix}${version}"`;
    });
    if (next !== text) writeFileSync(path, next);
  };
  manifest(root);
  for (const group of ["apps", "packages"]) {
    const dir = join(root, group);
    for (const name of existsSync(dir) ? readdirSync(dir).sort() : []) {
      const app = join(dir, name);
      if (group === "apps" && existsSync(join(app, "archlast-forge.json")))
        changes.push(...upgradeFiles(join(app, "forge"), version).map((c) => ({ ...c, file: relative(root, join(app, c.file)) })));
      else manifest(app);
    }
  }
  return changes;
}

/** The release `spec` (a version, or a dist-tag such as `latest`) names, asked of the registry the project installs from. */
export function resolveRelease(spec: string, cwd: string): string {
  const r = Bun.spawnSync([process.execPath, "info", `@archlast/forge-runtime@${spec}`, "version"], { cwd, stdout: "pipe", stderr: "pipe" });
  const version = r.stdout.toString().trim();
  if (r.exitCode === 0 && new RegExp(`^${SEMVER}$`).test(version)) return version;
  const lines = r.stderr.toString().trim().split("\n");
  const why = (lines.find((l) => l.startsWith("error:")) ?? lines.at(-1))?.replace(/^error: /, "") || `bun info exited ${r.exitCode}`;
  throw new Error(`Couldn't find archlast-forge ${spec} on the registry (${why}). \`bun info @archlast/forge-runtime versions\` lists those that exist.`);
}

/**
 * Upgrades the project: rewrites the versions, sets up Prettier where the project has nothing of it yet (as `init` does for a new project),
 * installs, and regenerates forge/_generated with the CLI just installed.
 */
export async function upgrade(forgeDir: string, spec = "latest") {
  const monorepo = findWorkspaceRoot(forgeDir);
  if (monorepo) return upgradeMonorepo(monorepo, spec);
  const root = projectRoot(forgeDir);
  const version = resolveRelease(spec, root);
  const changes = upgradeFiles(forgeDir, version);
  const added = addPrettier(root);
  if (!changes.length && !added.length) return ok(`Nothing to change: the project is on ${version}`);
  for (const ch of changes) console.log(`  ${ch.file.padEnd(20)} ${ch.name}  ${ch.from} → ${ch.to}`);
  for (const a of added) console.log(`  + ${a}`);

  if (root !== forgeDir && existsSync(join(root, "package.json"))) {
    step(`installing: bun install (${root})`);
    const r = Bun.spawnSync([process.execPath, "install"], { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
    if (r.exitCode !== 0) throw new Error(`bun install failed (exit ${r.exitCode}). The versions are already changed in the files above: fix the install, then run bun install.`);
  }
  await ensureDeps(forgeDir);

  // The generated types belong to the version: write them with the CLI that was just installed, when the project has one of its own.
  const cli = join(root, "node_modules", ".bin", "archlast-forge");
  if (existsSync(cli)) {
    const r = Bun.spawnSync([process.execPath, cli, "codegen", "--dir", forgeDir], { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
    if (r.exitCode !== 0) throw new Error("codegen failed after the upgrade; see above");
  } else await generate(forgeDir);
  if (changes.length) ok(`Upgraded to ${version}. Commit the changes; \`archlast-forge up\` rebuilds the stack on the new engine image.`);
  else ok(`Set up Prettier; the project was already on ${version}. Commit the changes.`);
  // Formatting existing code is a diff of its own, so it is the project's call: the setup is added, the code is left as it is.
  if (added.includes(".prettierrc")) console.log("  Prettier is set up with four spaces to an indent; `bun run format` formats the project.");
}

/** Upgrades every app and package of the monorepo at `root`: the versions, one `bun install` at the root, then each project's server dependencies and generated types. */
async function upgradeMonorepo(root: string, spec: string) {
  const version = resolveRelease(spec, root);
  const changes = upgradeWorkspaceFiles(root, version);
  if (!changes.length) return ok(`Nothing to change: the monorepo is on ${version}`);
  for (const ch of changes) console.log(`  ${ch.file.padEnd(34)} ${ch.name}  ${ch.from} → ${ch.to}`);

  step(`installing: bun install (${root})`);
  const r = Bun.spawnSync([process.execPath, "install"], { cwd: root, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
  if (r.exitCode !== 0) throw new Error(`bun install failed (exit ${r.exitCode}). The versions are already changed in the files above: fix the install, then run bun install.`);

  const apps = join(root, "apps");
  for (const name of readdirSync(apps).sort()) {
    const app = join(apps, name);
    if (!existsSync(join(app, "archlast-forge.json"))) continue;
    const forgeDir = join(app, "forge");
    await ensureDeps(forgeDir);
    // The generated types belong to the version: write them with the CLI that was just installed, from the app's own node_modules or the root's.
    const cli = [join(app, "node_modules", ".bin", "archlast-forge"), join(root, "node_modules", ".bin", "archlast-forge")].find(existsSync);
    if (cli) {
      const c = Bun.spawnSync([process.execPath, cli, "codegen", "--dir", forgeDir], { cwd: app, stdout: "inherit", stderr: "inherit", stdin: "ignore" });
      if (c.exitCode !== 0) throw new Error(`codegen in apps/${name} failed after the upgrade; see above`);
    } else await generate(forgeDir);
  }
  ok(`Upgraded the monorepo to ${version}. Commit the changes; \`archlast-forge up\` in an app rebuilds its stack on the new engine image.`);
}
