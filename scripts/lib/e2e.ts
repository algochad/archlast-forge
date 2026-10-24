// Shared by the end-to-end scripts: build a project from the packed tarballs, run commands in it, make assertions.
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const ROOT = resolve(import.meta.dir, "..", "..");
export const PACK = join(ROOT, ".pack");
const tarballs = readdirSync(PACK).filter((f) => f.endsWith(".tgz"));
if (!tarballs.length) throw new Error("No tarballs in .pack: run `bun scripts/pack.ts` first");

/** Every project and scaffolder install made here is removed when the script ends: each is about 100 MB. */
const scratch: string[] = [];
process.on("exit", () => scratch.forEach((d) => rmSync(d, { recursive: true, force: true })));

export function sh(cmd: string[], cwd: string, env: Record<string, string | undefined> = {}) {
  const p = Bun.spawnSync(cmd, { cwd, env: { ...process.env, ...env }, stdout: "pipe", stderr: "pipe" });
  return { ok: p.exitCode === 0, out: p.stdout.toString().trim(), err: p.stderr.toString().trim() };
}
export const must = (cmd: string[], cwd: string, env?: Record<string, string>) => {
  const r = sh(cmd, cwd, env);
  if (!r.ok) throw new Error(`${cmd.join(" ")} failed in ${cwd}\n${r.err || r.out}`);
  return r.out;
};
export const check = (name: string, ok: boolean, detail?: unknown) => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}`);
  if (!ok) throw new Error(`${name}${detail === undefined ? "" : `: ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};

export interface Project {
  dir: string;
  port: number;
  s3Port: number;
  base: string;
  cli(...args: string[]): ReturnType<typeof sh>;
  compose(...args: string[]): ReturnType<typeof sh>;
}

/** A project from the tarballs: scaffolded, installed, and set to listen on ports that are free here. */
export function createProject(name: string, mode: string, services: string[], port: number, s3Port: number): Project {
  const root = mkdtempSync(join(tmpdir(), "afx-e2e-"));
  const dir = join(root, name);
  const creator = mkdtempSync(join(tmpdir(), "afx-creator-"));
  scratch.push(root, creator);
  writeFileSync(join(creator, "package.json"), "{}");
  must(["bun", "add", join(PACK, tarballs.find((t) => t.startsWith("create-archlast-forge"))!)], creator);
  must(["bun", join(creator, "node_modules/create-archlast-forge/src/index.ts"), dir, "--mode", mode, "--services", services.join(",") || "none", "--yes", "--no-install", "--no-git"], ROOT);

  const overrides = Object.fromEntries(tarballs.map((t) => [t.replace(/-\d+\.\d+\.\d+.*\.tgz$/, "").replace(/^archlast-forge-/, "@archlast/forge-"), `file:${join(PACK, t)}`]));
  for (const file of [join(dir, "package.json"), join(dir, "forge", "package.json")]) {
    const pkg = JSON.parse(readFileSync(file, "utf8"));
    for (const field of ["dependencies", "devDependencies"]) for (const dep of Object.keys(pkg[field] ?? {})) if (overrides[dep]) pkg[field][dep] = overrides[dep];
    pkg.overrides = overrides;
    writeFileSync(file, JSON.stringify(pkg, null, 2));
  }
  must(["bun", "install"], dir);

  const envFile = join(dir, ".env");
  let env = readFileSync(envFile, "utf8").replace("BETTER_AUTH_URL=http://localhost:3000", `BETTER_AUTH_URL=http://localhost:${port}`).replace("PORT=3000", `PORT=${port}`);
  if (services.includes("s3")) env = env.replace("S3_PUBLIC_ENDPOINT=http://localhost:9000", `S3_PUBLIC_ENDPOINT=http://localhost:${s3Port}`).replace("S3_PORT=9000", `S3_PORT=${s3Port}`);
  writeFileSync(envFile, env);
  const composeArgs = ["compose", "--project-directory", dir, "-f", join(dir, "compose.yaml")];
  return {
    dir,
    port,
    s3Port,
    base: `http://localhost:${port}`,
    cli: (...args) => sh(["bunx", "archlast-forge", ...args], dir),
    compose: (...args) => sh(["docker", ...composeArgs, ...args], dir),
  };
}

export const json = (r: Response) => r.json() as Promise<any>;
export async function signUp(base: string, email: string, name: string) {
  const res = await fetch(`${base}/api/auth/sign-up/email`, { method: "POST", headers: { "content-type": "application/json", origin: base }, body: JSON.stringify({ email, password: "correct horse battery", name }) });
  if (!res.ok) throw new Error(`sign-up: ${res.status} ${await res.text()}`);
  return res.headers.getSetCookie().map((c) => c.split(";")[0]).join("; ");
}
export const call = async (base: string, fn: string, args: unknown, cookie = "") =>
  json(await fetch(`${base}/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json", cookie }, body: JSON.stringify(args) }));

