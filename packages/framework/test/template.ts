import { existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scaffold } from "../../create-archlast-forge/src/scaffold";
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
export function templateProject(name: string, mode: Mode = "framework", services: StackService[] = []) {
  const dir = join(TMP, `${name}-${process.pid}`);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  scaffold({ dir, mode, services });
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
