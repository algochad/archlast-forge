// Writes a new project from the templates.
import { chmodSync, cpSync, existsSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { nameOf } from "./options";
import { addShadcn, type BaseColor } from "./shadcn";
import {
  DOCKERIGNORE,
  generateSecrets,
  renderCaddyfile,
  renderCompose,
  renderDockerfile,
  renderEnv,
  type Mode,
  type StackService,
} from "./stack";

const TEMPLATE = new URL("../template", import.meta.url).pathname;
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

export interface ScaffoldOptions {
  dir: string;
  mode: Mode;
  services: StackService[];
  /** Full-stack apps only: use shadcn/ui, with this base color. */
  shadcn?: BaseColor;
  /** The archlast-forge version the project depends on. Defaults to this package's. */
  version?: string;
  /** The project's name (package.json, compose.yaml's project and image). Defaults to the folder's: a monorepo's apps pass `<monorepo>-<app>`, so two monorepos' stacks never share one. */
  name?: string;
}

/** Writes a new project into `dir` (which may exist but must be empty) and returns its absolute path. */
export function scaffold({ dir, mode, services, shadcn, version = VERSION, name: given }: ScaffoldOptions): string {
  const target = resolve(dir);
  if (existsSync(target) && readdirSync(target).length) throw new Error(`${target} isn't empty`);
  if (shadcn && mode !== "framework") throw new Error("shadcn/ui is for full-stack apps: use --mode framework");
  const name = given ?? nameOf(target);
  for (const part of ["base", mode]) cpSync(join(TEMPLATE, part), target, { recursive: true });
  if (shadcn) addShadcn(target, shadcn);
  renameSync(join(target, "gitignore"), join(target, ".gitignore")); // npm drops .gitignore files from packages
  if (services.includes("s3")) cpSync(join(TEMPLATE, "extras", "files.ts"), join(target, "forge", "files.ts")); // something that uses the storage

  const fill = (path: string) => {
    for (const entry of readdirSync(path)) {
      const p = join(path, entry);
      if (statSync(p).isDirectory()) fill(p);
      else writeFileSync(p, readFileSync(p, "utf8").replaceAll("__NAME__", name).replaceAll("__VERSION__", version));
    }
  };
  fill(target);

  const write = (file: string, text: string, secret = false) => {
    writeFileSync(join(target, file), text);
    if (secret) chmodSync(join(target, file), 0o600);
  };
  write("archlast-forge.json", JSON.stringify({ mode, services }, null, 2) + "\n");
  write("Dockerfile", renderDockerfile(version));
  write(".dockerignore", DOCKERIGNORE);
  write("compose.yaml", renderCompose({ name, services, version }));
  write(".env.example", renderEnv(services));
  write(".env", renderEnv(services, generateSecrets()), true);
  if (services.includes("caddy")) write("Caddyfile", renderCaddyfile(services));
  addPrettier(target);
  format(target);
  return target;
}

/** Four-space indentation is the standard for projects; the rest is Prettier's defaults. */
const PRETTIERRC = `{ "tabWidth": 4 }\n`;
const PRETTIERIGNORE = `# Written by archlast-forge codegen
forge/_generated
`;
/** The Prettier projects depend on: the one this package formats new projects with. */
const PRETTIER: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).dependencies.prettier;
const CONFIG_FILE = /^(\.prettierrc(\.\w+)?|prettier\.config\.\w+)$/;

/**
 * Sets a project up for Prettier, each piece only where the project has none of its own: `.prettierrc` (no Prettier config at all),
 * `.prettierignore`, a `format` script and `prettier` in devDependencies. `scaffold` and `archlast-forge upgrade` use it. Returns what it added.
 */
export function addPrettier(root: string): string[] {
  const file = join(root, "package.json");
  if (!existsSync(file)) return [];
  const text = readFileSync(file, "utf8");
  const pkg = JSON.parse(text);
  const added: string[] = [];
  if (pkg.prettier === undefined && !readdirSync(root).some((f) => CONFIG_FILE.test(f))) {
    writeFileSync(join(root, ".prettierrc"), PRETTIERRC);
    added.push(".prettierrc");
  }
  if (!existsSync(join(root, ".prettierignore"))) {
    writeFileSync(join(root, ".prettierignore"), PRETTIERIGNORE);
    added.push(".prettierignore");
  }
  const before = added.length;
  if (!pkg.scripts?.format) {
    pkg.scripts = { ...pkg.scripts, format: "prettier --write ." };
    added.push('the "format" script');
  }
  if (!pkg.dependencies?.prettier && !pkg.devDependencies?.prettier) {
    pkg.devDependencies = Object.fromEntries(Object.entries({ ...pkg.devDependencies, prettier: PRETTIER }).sort(([a], [b]) => (a < b ? -1 : 1)));
    added.push(`prettier ${PRETTIER} in devDependencies`);
  }
  if (added.length > before) writeFileSync(file, JSON.stringify(pkg, null, /^[ \t]+(?=")/m.exec(text)?.[0] ?? 2) + "\n"); // the file's own indent
  return added;
}

const prettierBin = () => fileURLToPath(import.meta.resolve("prettier/bin/prettier.cjs"));

/**
 * Runs what the project's `bun run format` runs, with the config just written, so a new project starts out formatted. With `files` (paths
 * relative to `target`) it formats only those: commands that add to an existing project write files of their own and leave the rest as it is.
 */
export function format(target: string, files?: string[]) {
  if (files && !files.length) return;
  const r = Bun.spawnSync([process.execPath, prettierBin(), "--write", "--log-level", "warn", ...(files ?? ["."])], { cwd: target, stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Prettier couldn't format ${target}:\n${r.stderr.toString() || r.stdout.toString()}`);
}

/** `text` as Prettier formats a file at `file` (relative to `target`), with the project's own config: to compare generated text with what a scaffold wrote. */
export function formatText(target: string, file: string, text: string): string {
  const r = Bun.spawnSync([process.execPath, prettierBin(), "--stdin-filepath", file], { cwd: target, stdin: Buffer.from(text), stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`Prettier couldn't format ${file}:\n${r.stderr.toString()}`);
  return r.stdout.toString();
}

/** Whether Prettier would leave `file` (relative to `target`) as it is: a file that isn't is the user's own style, and is not reformatted. */
export function isFormatted(target: string, file: string): boolean {
  return Bun.spawnSync([process.execPath, prettierBin(), "--check", "--log-level", "silent", file], { cwd: target, stdout: "pipe", stderr: "pipe" }).exitCode === 0;
}
