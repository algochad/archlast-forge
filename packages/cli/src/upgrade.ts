// `archlast-forge upgrade`: moves a project, backend or full-stack app, to another release of archlast-forge.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { addPrettier } from "create-archlast-forge";
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
