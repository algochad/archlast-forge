// Runs inside the engine container. The host's forge/ is mounted read-only at SRC; the engine keeps a copy at APP
// (its own filesystem), installs its dependencies there for Linux, and serves it.
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import type { AppHost } from "@archlast/forge-runtime/server";
import { loadFramework } from "./app";
import { fail, generate } from "./common";
import { loadProjectConfig } from "./project";
import { serve } from "./serve";

export const SRC = process.env.ARCHLAST_SRC ?? "/src/forge";
export const APP = process.env.ARCHLAST_APP ?? "/app/forge";
const ENGINE_PACKAGES = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
const ENGINE_RUNTIME = join(ENGINE_PACKAGES, "runtime");
/** The project around forge/: where a full-stack app's app/, public/ and package.json are (mounted or copied in at SRC's parent), and where they run from. */
const PROJECT_SRC = dirname(SRC);
const PROJECT_APP = dirname(APP);

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
 * Installs forge/package.json's dependencies inside the container (native packages build for Linux).
 * @archlast/forge-* and workspace: entries are left out: the engine provides the runtime itself.
 */
export function installDeps() {
  const pkgFile = join(SRC, "package.json");
  const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {};
  const keep = (deps: Record<string, string> = {}) =>
    Object.fromEntries(Object.entries(deps).filter(([name, spec]) => !name.startsWith("@archlast/forge-") && !String(spec).startsWith("workspace:")));
  const manifest = { name: "forge-app", private: true, type: "module", dependencies: keep(pkg.dependencies), trustedDependencies: pkg.trustedDependencies };
  writeFileSync(join(APP, "package.json"), JSON.stringify(manifest, null, 2));
  const args = ["install", ...(pkg.trustedDependencies ? [] : ["--ignore-scripts"])];
  console.log(`→ installing server dependencies: bun ${args.join(" ")}`);
  let proc = Bun.spawnSync([process.execPath, ...args], { cwd: APP, stdout: "inherit", stderr: "inherit" });
  const lock = ["bun.lock", "bun.lockb"].map((f) => join(APP, f)).find(existsSync);
  if (proc.exitCode !== 0 && lock) {
    // The lockfile came from the host, where forge/package.json also listed @archlast/forge-* packages (possibly from a local path) that this copy leaves out.
    console.log("! the copied lockfile didn't fit; installing again without it");
    rmSync(lock);
    proc = Bun.spawnSync([process.execPath, ...args], { cwd: APP, stdout: "inherit", stderr: "inherit" });
  }
  if (proc.exitCode !== 0) throw new Error(`bun install failed (exit ${proc.exitCode}). Fix forge/package.json; native packages may need "trustedDependencies".`);
  const link = join(APP, "node_modules", "@archlast", "forge-runtime");
  mkdirSync(dirname(link), { recursive: true });
  rmSync(link, { recursive: true, force: true });
  symlinkSync(ENGINE_RUNTIME, link);
}

/** Packages the engine provides itself, so an app and the engine always share one copy of each. */
const provided = (name: string) => name.startsWith("@archlast/forge-") || name === "react" || name === "react-dom";

/**
 * A full-stack app: copy app/ and public/ in, install the dependencies the engine doesn't provide, link the ones it does
 * (react among them: one copy, or hooks break), and build the browser and server bundles.
 */
async function prepareApp() {
  for (const f of ["app", "public", "tsconfig.json", "archlast-forge.json"]) if (existsSync(join(PROJECT_SRC, f))) cpSync(join(PROJECT_SRC, f), join(PROJECT_APP, f), { recursive: true, force: true });
  const pkgFile = join(PROJECT_SRC, "package.json");
  const pkg = existsSync(pkgFile) ? JSON.parse(readFileSync(pkgFile, "utf8")) : {};
  const dependencies = Object.fromEntries(Object.entries<string>(pkg.dependencies ?? {}).filter(([name, spec]) => !provided(name) && !String(spec).startsWith("workspace:")));
  writeFileSync(join(PROJECT_APP, "package.json"), JSON.stringify({ name: "app", private: true, type: "module", dependencies, trustedDependencies: pkg.trustedDependencies }, null, 2));
  if (Object.keys(dependencies).length) {
    console.log(`→ installing the app's dependencies: bun install (${Object.keys(dependencies).join(", ")})`);
    const proc = Bun.spawnSync([process.execPath, "install", ...(pkg.trustedDependencies ? [] : ["--ignore-scripts"])], { cwd: PROJECT_APP, stdout: "inherit", stderr: "inherit" });
    if (proc.exitCode !== 0) throw new Error(`bun install failed for the app (exit ${proc.exitCode}). Fix package.json.`);
  }
  const link = (target: string, name: string) => {
    const at = join(PROJECT_APP, "node_modules", name);
    mkdirSync(dirname(at), { recursive: true });
    rmSync(at, { recursive: true, force: true });
    symlinkSync(target, at);
  };
  for (const name of ["framework", "react", "client", "runtime"]) link(join(ENGINE_PACKAGES, name), `@archlast/forge-${name}`);
  for (const name of ["react", "react-dom"]) link(dirname(realpathSync(Bun.resolveSync(`${name}/package.json`, join(ENGINE_PACKAGES, "framework")))), name);

  await generate(APP);
  const { buildApp } = await loadFramework(PROJECT_APP, "build");
  const { manifest } = await buildApp({ root: PROJECT_APP, dev: false }).catch((e: Error) => fail(e.message));
  console.log(`✓ built the app (${Object.keys(manifest.routes).length} routes)`);
}

/** `engine prepare`: used when building an app image, so the container starts without installing or building. */
export async function prepare() {
  if (!existsSync(join(SRC, "schema.ts"))) fail(`No schema.ts in ${SRC}`);
  sync();
  installDeps();
  if (loadProjectConfig(SRC)?.mode === "framework") await prepareApp();
}

/** `engine serve`: the container's main process. */
export async function engineServe(dev: boolean) {
  if (!existsSync(join(SRC, "schema.ts"))) fail(`No schema.ts in ${SRC}. Mount your forge/ directory there.`);
  sync();
  if (!existsSync(join(APP, "node_modules", "@archlast", "forge-runtime"))) installDeps();
  const env = { ...process.env, DATA_DIR: process.env.DATA_DIR ?? "/data" };

  let app: AppHost | undefined;
  if (loadProjectConfig(SRC)?.mode === "framework") {
    if (dev) fail("A full-stack app runs on your machine in development: `archlast-forge dev` (it uses Docker only for services).");
    if (!existsSync(join(PROJECT_APP, ".forge", "build", "latest.json"))) await prepareApp();
    app = await (await loadFramework(PROJECT_APP, "server")).createApp({ root: PROJECT_APP, dev: false });
  }
  const server = await serve({
    forgeDir: APP,
    dev,
    env,
    watchDir: dev ? SRC : undefined,
    app,
    onChange: async (files) => {
      sync(files);
      if (files.some((f) => f.endsWith("package.json"))) installDeps();
      return true;
    },
  });
  console.log(`✓ archlast-forge engine on ${server.url} (${dev ? "development" : "production"}${app ? ", with the app" : ""})`);
}
