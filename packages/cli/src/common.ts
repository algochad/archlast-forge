import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { checkFrontendImports, codegen } from "./codegen";
import { c } from "./ui";

export function fail(message: string): never {
  console.error(`${c.red("✗")} ${message}`);
  process.exit(1);
}

/** The folder holding schema.ts and your functions: `forge/`, or the current directory if it has schema.ts. A project still using the old `convex/` name keeps working, with a nudge to rename it. */
export function findForgeDir(dir?: string) {
  let picked = dir;
  if (!picked) {
    if (existsSync("forge/schema.ts")) picked = "forge";
    else if (existsSync("schema.ts")) picked = ".";
    else if (existsSync("convex/schema.ts")) {
      console.warn("! Using convex/, the old name for this folder. Rename it to forge/ (and update imports of ../convex/_generated).");
      picked = "convex";
    } else picked = "forge";
  }
  const abs = resolve(picked);
  if (!existsSync(join(abs, "schema.ts"))) fail(`No schema.ts in ${abs}. Pass --dir <path to forge/>.`);
  return abs;
}

/** Dev-only secrets, persisted so sessions and the dashboard key survive restarts. */
export function devSecrets(env: Record<string, string | undefined>, dir: string) {
  const file = join(dir, ".dev-secrets.json");
  const saved: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const key of ["BETTER_AUTH_SECRET", "ADMIN_KEY"]) env[key] ||= saved[key] ??= Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return env;
}

/** Behind code-server's port proxy (VSCODE_PROXY_URI=https://{{port}}.host/), browsers use the proxy origin, so trust it too. */
export function trustProxyOrigins(env: Record<string, string | undefined>) {
  const uri = env.VSCODE_PROXY_URI;
  if (!uri?.includes("{{port}}.")) return;
  const ports = (env.TRUSTED_ORIGINS ?? "").split(",").map((o) => /^http:\/\/localhost:(\d+)$/.exec(o.trim())?.[1]);
  const extra = ports.filter(Boolean).map((p) => new URL(uri.replace("{{port}}", p!)).origin);
  env.TRUSTED_ORIGINS = [env.TRUSTED_ORIGINS, ...extra].filter(Boolean).join(",");
}

export async function generate(dir: string) {
  const modules = await codegen(dir);
  const violations = await checkFrontendImports(dir);
  if (violations.length) throw new Error(`Frontend code must import only forge/_generated (and not Forge RPC, which is for backends):\n  ${violations.join("\n  ")}`);
  return modules;
}

export const loadDashboard = async () => (await import("@archlast/forge-dashboard")).default;
/** The API docs page and explorer, served when API_DOCS is on. */
export const loadApiDocs = async () => (await import("@archlast/forge-dashboard/api-docs")).default;

/** The CLI's own version; the engine image is tagged with it. */
export const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
