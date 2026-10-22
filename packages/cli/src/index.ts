#!/usr/bin/env bun
import { migrate, startServer } from "@archlast-forge/runtime/server";
import { existsSync, mkdirSync, readFileSync, watch, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { checkFrontendImports, codegen } from "./codegen";
import { ensureDeps, findUp } from "./deps";

const USAGE = `archlast-forge <command> [--dir convex]

  dev        codegen, install server deps, start the server and watch convex/
  codegen    write convex/_generated/ and check that src/ only imports convex/_generated
  migrate    apply table/index migrations and report documents that don't match the schema
  start      start the production server
  dashboard  print the dashboard URL`;

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: { dir: { type: "string" }, help: { type: "boolean", short: "h" } },
});
const command = positionals[0];

function convexDir() {
  const dir = values.dir ?? (existsSync("convex/schema.ts") ? "convex" : existsSync("schema.ts") ? "." : "convex");
  const abs = resolve(dir);
  if (!existsSync(join(abs, "schema.ts"))) fail(`No schema.ts in ${abs}. Pass --dir <path to convex/>.`);
  return abs;
}

function fail(message: string): never {
  console.error(`✗ ${message}`);
  process.exit(1);
}

/** Dev-only secrets, persisted so sessions and the dashboard key survive restarts. */
function devSecrets(env: Record<string, string | undefined>) {
  const dir = env.DATA_DIR ?? "./data";
  const file = join(dir, ".dev-secrets.json");
  const saved: Record<string, string> = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  for (const key of ["BETTER_AUTH_SECRET", "ADMIN_KEY"]) env[key] ||= saved[key] ??= Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex");
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(saved, null, 2), { mode: 0o600 });
  return env;
}

async function generate(dir: string) {
  const modules = await codegen(dir);
  const violations = await checkFrontendImports(dir);
  if (violations.length)
    throw new Error(`Frontend code must import only convex/_generated:\n  ${violations.join("\n  ")}`);
  return modules;
}

const dashboard = async () => (await import("@archlast-forge/dashboard")).default;

/** Behind code-server's port proxy (VSCODE_PROXY_URI=https://{{port}}.host/), browsers use the proxy origin, so trust it too. */
function trustProxyOrigins(env: Record<string, string | undefined>) {
  const uri = env.VSCODE_PROXY_URI;
  if (!uri?.includes("{{port}}.")) return;
  const ports = (env.TRUSTED_ORIGINS ?? "").split(",").map((o) => /^http:\/\/localhost:(\d+)$/.exec(o.trim())?.[1]);
  const extra = ports.filter(Boolean).map((p) => new URL(uri.replace("{{port}}", p!)).origin);
  env.TRUSTED_ORIGINS = [env.TRUSTED_ORIGINS, ...extra].filter(Boolean).join(",");
}

async function dev() {
  const dir = convexDir();
  const env = devSecrets({ ...process.env });
  trustProxyOrigins(env);
  await ensureDeps(dir);
  const modules = await generate(dir);
  console.log(`✓ codegen: ${modules.length} modules`);
  const server = await startServer({ convexDir: dir, dev: true, env, dashboard: await dashboard() });
  console.log(`✓ archlast-forge dev on ${server.url}\n  dashboard: ${server.url}/_dashboard  (admin key: ${env.ADMIN_KEY})`);

  const changed = new Set<string>();
  let timer: Timer | undefined;
  let running = Promise.resolve();
  const onChange = (file: string) => {
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => (running = running.then(apply)), 150);
  };
  async function apply() {
    const files = [...changed];
    changed.clear();
    try {
      const depsChanged = files.some((f) => ["package.json", "bun.lock"].includes(basename(f)));
      const installed = depsChanged && (await ensureDeps(dir));
      const code = files.some((f) => /\.(ts|js)$/.test(f));
      if (!installed && !code) return;
      await generate(dir);
      await server.reload();
      console.log(`✓ function runtime restarted (${installed ? "dependencies" : "code"} changed)`);
    } catch (e) {
      console.error(`✗ ${(e as Error).message}`);
    }
  }
  watch(dir, { recursive: true }, (_event, file) => {
    if (!file || /(^|\/)(_generated|node_modules|\.)/.test(file)) return;
    if (/\.(ts|js)$/.test(file) || ["package.json", "bun.lock"].includes(basename(file))) onChange(file);
  });
  const lock = findUp(dir, "bun.lock");
  if (lock && !lock.startsWith(dir)) watch(lock, () => onChange(lock));
}

switch (values.help ? undefined : command) {
  case "dev":
    await dev().catch((e) => fail(e.message));
    break;
  case "codegen": {
    const dir = convexDir();
    await ensureDeps(dir).catch((e) => fail(e.message));
    const modules = await generate(dir).catch((e) => fail(e.message));
    console.log(`✓ wrote ${join(dir, "_generated")} (${modules.length} modules)`);
    break;
  }
  case "migrate": {
    const report = await migrate(convexDir()).catch((e) => fail(e.message));
    console.log(`✓ migrated ${report.tables.length} tables`);
    for (const { id, error } of report.invalid) console.error(`  ✗ ${id}: ${error}`);
    if (report.invalid.length) fail(`${report.invalid.length} documents don't match the schema`);
    break;
  }
  case "start": {
    const server = await startServer({ convexDir: convexDir(), dashboard: await dashboard() }).catch((e) => fail(e.message));
    console.log(`✓ archlast-forge on ${server.url}`);
    break;
  }
  case "dashboard":
    console.log(`http://localhost:${process.env.PORT ?? 3000}/_dashboard`);
    break;
  default:
    console.log(USAGE);
    if (command && !values.help) process.exit(1);
}
