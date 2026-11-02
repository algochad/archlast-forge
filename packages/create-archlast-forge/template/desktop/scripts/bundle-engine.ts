// What the desktop app ships, made before `tauri dev` and `tauri build` (tauri.conf.json): the app in apps/__MAIN__, built for production,
// with its production dependencies, the engine's starter, and the Bun runtime that runs it (the sidecar Tauri starts).
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

const here = join(import.meta.dir, "..");
const web = join(here, "..", "__MAIN__");
const out = join(here, "src-tauri", "app-bundle");
const run = (cmd: string[], cwd: string) => {
  const r = Bun.spawnSync(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"] });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")} failed in ${cwd}`);
};

run([process.execPath, "run", "build"], web); // archlast-forge build --no-docker: the pages' production bundles in .forge/build
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
for (const entry of ["package.json", "forge", "app", "public", ".forge/build", "tsconfig.json"])
  if (existsSync(join(web, entry))) cpSync(join(web, entry), join(out, entry), { recursive: true, filter: (src) => !/[\\/](node_modules|data)([\\/]|$)/.test(src.slice(web.length)) });
copyFileSync(join(here, "engine", "desktop-engine.ts"), join(out, "desktop-engine.ts"));
run([process.execPath, "install", "--production"], out);
run([process.execPath, "install", "--production"], join(out, "forge"));

// Tauri finds a sidecar by the platform it runs on: binaries/bun-<target triple>.
const triple = /host: (\S+)/.exec(Bun.spawnSync(["rustc", "-vV"]).stdout.toString())?.[1];
if (!triple) throw new Error("rustc -vV didn't say the host's target triple: install Rust (Tauri needs it)");
const bin = join(here, "src-tauri", "binaries", `bun-${triple}${process.platform === "win32" ? ".exe" : ""}`);
mkdirSync(join(here, "src-tauri", "binaries"), { recursive: true });
copyFileSync(process.execPath, bin);
chmodSync(bin, 0o755);
console.log(`✓ the web app and Bun ${Bun.version} are ready for the desktop app (${out})`);
