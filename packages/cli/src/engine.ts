// Runs inside the engine container. The host's convex/ is mounted read-only at SRC; the engine keeps a copy at APP
// (its own filesystem), installs its dependencies there for Linux, and serves it.
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fail } from "./common";
import { serve } from "./serve";

export const SRC = process.env.ARCHLAST_SRC ?? "/src/convex";
export const APP = process.env.ARCHLAST_APP ?? "/app/convex";
const ENGINE_RUNTIME = new URL("../../runtime", import.meta.url).pathname;

const skipped = (rel: string) => rel.split("/").some((seg) => seg === "node_modules" || seg === "data" || (seg.startsWith(".") && seg !== "."));

/** Copies the project into the engine's filesystem; removed files are removed too. */
export function sync(files?: string[]) {
  mkdirSync(APP, { recursive: true });
  if (!files) {
    cpSync(SRC, APP, { recursive: true, force: true, filter: (src) => !skipped(relative(SRC, src)) });
    return;
  }
  for (const rel of files) {
    if (skipped(rel)) continue;
    const from = join(SRC, rel);
    const to = join(APP, rel);
    if (existsSync(from)) {
      mkdirSync(dirname(to), { recursive: true });
      cpSync(from, to, { force: true });
    } else rmSync(to, { force: true });
  }
}

/**
 * Installs convex/package.json's dependencies inside the container (native packages build for Linux).
 * @archlast-forge/* and workspace: entries are left out: the engine provides the runtime itself.
 */
export function installDeps() {
  const pkgFile = join(SRC, "package.json");
  const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {};
  const keep = (deps: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(deps).filter(([name, spec]) => !name.startsWith("@archlast-forge/") && !String(spec).startsWith("workspace:")));
  const manifest = { name: "convex-app", private: true, type: "module", dependencies: keep(pkg.dependencies), trustedDependencies: pkg.trustedDependencies };
  writeFileSync(join(APP, "package.json"), JSON.stringify(manifest, null, 2));
  const args = ["install", ...(pkg.trustedDependencies ? [] : ["--ignore-scripts"])];
  console.log(`→ installing server dependencies: bun ${args.join(" ")}`);
  const proc = Bun.spawnSync([process.execPath, ...args], { cwd: APP, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0) throw new Error(`bun install failed (exit ${proc.exitCode}). Fix convex/package.json; native packages may need "trustedDependencies".`);
  const link = join(APP, "node_modules", "@archlast-forge", "runtime");
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(ENGINE_RUNTIME, link);
}

/** `engine prepare`: used when building an app image, so the container starts without installing. */
export function prepare() {
  if (!existsSync(join(SRC, "schema.ts"))) fail(`No schema.ts in ${SRC}`);
  sync();
  installDeps();
}

/** `engine serve`: the container's main process. */
export async function engineServe(dev: boolean) {
  if (!existsSync(join(SRC, "schema.ts"))) fail(`No schema.ts in ${SRC}. Mount your convex/ directory there.`);
  sync();
  if (!existsSync(join(APP, "node_modules", "@archlast-forge", "runtime"))) installDeps();
  const env = { ...process.env, DATA_DIR: process.env.DATA_DIR ?? "/data" };
  const server = await serve({
    convexDir: APP,
    dev,
    env,
    watchDir: dev ? SRC : undefined,
    onChange: async (files) => {
      sync(files);
      if (files.some((f) => f.endsWith("package.json"))) installDeps();
      return true;
    },
  });
  console.log(`✓ archlast-forge engine on ${server.url} (${dev ? "dev" : "production"})`);
}
