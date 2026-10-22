import { existsSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";

export function findUp(dir: string, name: string): string | undefined {
  for (let d = dir; ; d = dirname(d)) {
    if (existsSync(join(d, name))) return join(d, name);
    if (dirname(d) === d) return undefined;
  }
}

const depsHash = async (pkg: string, lock?: string) =>
  String(Bun.hash((await Bun.file(pkg).text()) + (lock && existsSync(lock) ? await Bun.file(lock).text() : "")));

/**
 * Runs `bun install` for convex/package.json when it or the lockfile changed since the last install.
 * Lifecycle scripts are off unless the manifest lists `trustedDependencies` (then Bun runs only those).
 */
export async function ensureDeps(convexDir: string): Promise<boolean> {
  const pkg = join(convexDir, "package.json");
  if (!existsSync(pkg)) return false;
  const lock = findUp(convexDir, "bun.lock");
  const stamp = join(convexDir, "_generated", ".depshash");
  if (existsSync(stamp) && (await Bun.file(stamp).text()) === (await depsHash(pkg, lock))) return false;
  const manifest = await Bun.file(pkg).json();
  const args = manifest.trustedDependencies ? ["install"] : ["install", "--ignore-scripts"];
  console.log(`→ installing server dependencies: bun ${args.join(" ")} (${convexDir})`);
  const proc = Bun.spawnSync([process.execPath, ...args], { cwd: convexDir, stdout: "inherit", stderr: "inherit" });
  if (proc.exitCode !== 0)
    throw new Error(`bun install failed in ${convexDir} (exit ${proc.exitCode}). Fix convex/package.json; native packages may need "trustedDependencies".`);
  mkdirSync(dirname(stamp), { recursive: true });
  await Bun.write(stamp, await depsHash(pkg, findUp(convexDir, "bun.lock")));
  return true;
}
