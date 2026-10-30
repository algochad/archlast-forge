import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scaffold } from "../../create-archlast-forge/src/scaffold";
import type { BaseColor } from "../../create-archlast-forge/src/shadcn";
import type { Mode, StackService } from "../../create-archlast-forge/src/stack";

const PACKAGES = join(import.meta.dir, "..", "..");
export const TMP = join(import.meta.dir, ".tmp");

const link = (target: string, at: string) => {
  mkdirSync(dirname(at), { recursive: true });
  rmSync(at, { recursive: true, force: true });
  symlinkSync(target, at);
};

/**
 * A project made from the real template, wired to the packages in this repository instead of the registry:
 * what `bun install` would do, without the network.
 */
export function templateProject(name: string, mode: Mode = "framework", services: StackService[] = [], shadcn?: BaseColor) {
  const dir = join(TMP, `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  scaffold({ dir, mode, services, shadcn });
  if (shadcn) installUi(dir);
  // Tests sign users up in quick succession; Better Auth's per-path limit (3 per 10 s) is for production traffic.
  writeFileSync(join(dir, "forge", "auth.ts"), `import { defineAuth } from "@archlast/forge-runtime";\nexport default defineAuth({ emailAndPassword: { enabled: true }, rateLimit: { enabled: false } });\n`);
  const own = join(PACKAGES, "framework", "node_modules");
  for (const pkg of ["framework", "react", "client", "runtime"]) {
    link(join(PACKAGES, pkg), join(dir, "node_modules", "@archlast", `forge-${pkg}`));
    link(join(PACKAGES, "runtime"), join(dir, "forge", "node_modules", "@archlast", "forge-runtime"));
  }
  for (const dep of ["react", "react-dom"]) link(realpathSync(join(own, dep)), join(dir, "node_modules", dep));
  for (const dep of ["react", "react-dom"]) if (existsSync(join(own, "@types", dep))) link(realpathSync(join(own, "@types", dep)), join(dir, "node_modules", "@types", dep));
  return dir;
}

/** Installs the packages shadcn/ui needs from the registry. This repo's packages and React stay the linked ones above, so there is one copy of React. */
function installUi(dir: string) {
  const file = join(dir, "package.json");
  const original = readFileSync(file, "utf8");
  const pkg = JSON.parse(original);
  const ui = (deps: Record<string, string>) => Object.fromEntries(Object.entries(deps).filter(([name]) => !/^@archlast\/|^react(-dom)?$|^@types\/react|^typescript$/.test(name)));
  writeFileSync(file, JSON.stringify({ name: pkg.name, private: true, dependencies: ui(pkg.dependencies), devDependencies: ui(pkg.devDependencies) }));
  const install = Bun.spawnSync(["bun", "install"], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (install.exitCode !== 0) throw new Error(`bun install failed: ${install.stderr.toString()}`);
  writeFileSync(file, original);
}
