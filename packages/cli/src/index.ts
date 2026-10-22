#!/usr/bin/env bun
import { ops } from "@archlast-forge/runtime/server";
import { watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { devSecrets, fail, findConvexDir, generate, trustProxyOrigins, VERSION } from "./common";
import { ensureDeps, findUp } from "./deps";
import * as dockerEngine from "./docker";
import { engineServe, prepare } from "./engine";
import { serve } from "./serve";

const USAGE = `archlast-forge ${VERSION}

Development
  dev                     codegen, then run the engine in Docker and watch convex/
      --no-docker         run in this process instead
      --with <list>       also start service containers: postgres, redis, s3
      --run "<cmd>"       also run a command alongside, e.g. --run vite
  codegen                 write convex/_generated/ and check that src/ imports only convex/_generated

Production
  build [--tag <image>]   build an app image: the engine plus your code and dependencies
  start                   run in production: --image <tag> [--env-file <file>] in Docker, or --no-docker here
  stop | logs | status    control this project's engine container

Data
  migrate                 sync tables and indexes; report documents that don't match the schema
      --run-migrations [name…]  run data migrations (resumable)   --status   list them
  export <file>           all documents as JSON Lines
  import <file>           restore an export (--replace clears the tables first)
  backup <file>           SQLite database copy (use pg_dump for Postgres)

Config
  env list | env get <NAME> | env set <NAME> <value> | env rm <NAME>
  admin add <email> [--role owner|admin|viewer] [--password <pw>] | admin list | admin remove <email>
  dashboard               print the dashboard URL

Engine
  engine build            build the engine image from this repository

Options: --dir <convex dir>  --port <n>  --no-docker`;

const { positionals, values } = parseArgs({
  args: Bun.argv.slice(2),
  allowPositionals: true,
  options: {
    dir: { type: "string" },
    port: { type: "string" },
    "no-docker": { type: "boolean" },
    docker: { type: "boolean" },
    with: { type: "string" },
    tag: { type: "string" },
    image: { type: "string" },
    "run-migrations": { type: "boolean" },
    status: { type: "boolean" },
    replace: { type: "boolean" },
    role: { type: "string" },
    password: { type: "string" },
    "env-file": { type: "string" },
    run: { type: "string" },
    dev: { type: "boolean" },
    help: { type: "boolean", short: "h" },
  },
});
const [command, ...rest] = positionals;
const port = Number(values.port ?? process.env.PORT ?? 3000);
const inContainer = process.env.ARCHLAST_ENGINE === "1";

/** Docker unless told otherwise, or unavailable (with a hint), or already inside the engine. */
function useDocker() {
  if (values["no-docker"] || inContainer || process.env.ARCHLAST_NO_DOCKER === "1") return false;
  if (dockerEngine.dockerAvailable()) return true;
  if (values.docker) fail("Docker isn't available. Install it, or pass --no-docker to run in this process.");
  console.log("! Docker isn't available; running in this process (--no-docker)");
  return false;
}

function devEnv(dir: string) {
  const env = devSecrets({ ...process.env }, join(process.env.DATA_DIR ?? join(dir, "data")));
  env.DATA_DIR ??= join(dir, "data");
  trustProxyOrigins(env);
  return env;
}

/** `--run "vite"`: a companion process for the frontend, stopped with the CLI. */
function companion() {
  if (!values.run) return;
  const proc = Bun.spawn(["sh", "-c", values.run], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  process.on("exit", () => proc.kill());
}

async function dev() {
  const dir = findConvexDir(values.dir);
  const env = devEnv(dir);
  companion();
  await ensureDeps(dir); // host install: editor types; the engine installs its own copy
  console.log(`✓ codegen: ${(await generate(dir)).length} modules`);

  if (useDocker()) {
    const name = dockerEngine.runEngine({
      convexDir: dir,
      port,
      dev: true,
      env: { BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET!, ADMIN_KEY: env.ADMIN_KEY!, BETTER_AUTH_URL: `http://localhost:${port}`, TRUSTED_ORIGINS: env.TRUSTED_ORIGINS ?? "" },
      services: values.with ? (values.with.split(",").map((s) => s.trim()) as dockerEngine.Service[]) : [],
    });
    console.log(`✓ engine container ${name} on http://localhost:${port}\n  dashboard: http://localhost:${port}/_dashboard  (admin key: ${env.ADMIN_KEY})`);
    // The engine watches the mounted source; the host only keeps codegen current.
    watchSource(dir, async (files) => {
      if (files.some((f) => ["package.json", "bun.lock"].includes(basename(f)))) await ensureDeps(dir);
      await generate(dir);
    });
    await dockerEngine.attach(name, true);
    return;
  }

  const server = await serve({
    convexDir: dir,
    dev: true,
    env: { ...env, PORT: String(port) },
    watchDir: dir,
    onChange: async (files) => {
      const source = files.filter((f) => !f.includes("_generated"));
      if (!source.length) return false; // our own codegen output
      const installed = source.some((f) => ["package.json", "bun.lock"].includes(basename(f))) && (await ensureDeps(dir));
      const code = source.some((f) => /\.(ts|js)$/.test(f));
      if (!installed && !code) return false;
      await generate(dir);
      return true;
    },
  });
  console.log(`✓ archlast-forge dev on ${server.url}\n  dashboard: ${server.url}/_dashboard  (admin key: ${env.ADMIN_KEY})`);
  const lock = findUp(dir, "bun.lock");
  if (lock && !lock.startsWith(dir)) watch(lock, () => void ensureDeps(dir).then(async (did) => void (did && (await server.reload()))));
}

function watchSource(dir: string, onChange: (files: string[]) => Promise<void>) {
  let timer: Timer | undefined;
  const changed = new Set<string>();
  watch(dir, { recursive: true }, (_e, file) => {
    if (!file || /(^|\/)(_generated|node_modules|data|\.)/.test(file)) return;
    changed.add(file);
    clearTimeout(timer);
    timer = setTimeout(() => {
      const files = [...changed];
      changed.clear();
      onChange(files).catch((e) => console.error(`✗ ${e.message}`));
    }, 150);
  });
}

/** Where data and config commands run: inside the running engine container, or in this process. */
function engineTarget(dir: string) {
  if (!useDocker()) return null;
  return dockerEngine.runningContainer(dir) ?? null;
}

async function withProject<T>(fn: (p: ops.ProjectDb) => Promise<T>) {
  const p = await ops.openProject(findConvexDir(values.dir), { ...process.env, DATA_DIR: process.env.DATA_DIR ?? join(findConvexDir(values.dir), "data") });
  try {
    return await fn(p);
  } finally {
    await p.close();
  }
}

async function withDb<T>(fn: (db: Awaited<ReturnType<typeof ops.openDb>>) => Promise<T>) {
  const db = await ops.openDb({ ...process.env, DATA_DIR: process.env.DATA_DIR ?? join(findConvexDir(values.dir), "data") });
  try {
    return await fn(db);
  } finally {
    await db.close();
  }
}

/** Runs this command inside the engine container if one is up for the project. */
function forwarded(dir: string, args: string[]) {
  const target = engineTarget(dir);
  if (!target) return false;
  const r = dockerEngine.execInEngine(target, args);
  if (!r.ok) process.exit(1);
  return true;
}

/** Applies config changes to a running server: SIGHUP the container, or ask a local server to reload. */
async function reloadRunning(dir: string) {
  const target = engineTarget(dir);
  if (target) {
    dockerEngine.docker(["kill", "--signal", "HUP", target]);
    return console.log("✓ engine reloaded");
  }
  const key = process.env.ADMIN_KEY ?? devEnv(dir).ADMIN_KEY;
  const res = await fetch(`http://localhost:${port}/_admin/reload`, { method: "POST", headers: { "x-admin-key": key!, "x-forge-admin": "1" } }).catch(() => null);
  console.log(res?.ok ? "✓ running server reloaded" : "  (no running server picked it up; it applies on next start)");
}

const commands: Record<string, () => Promise<unknown>> = {
  dev,
  async codegen() {
    const dir = findConvexDir(values.dir);
    await ensureDeps(dir).catch((e) => fail(e.message));
    const modules = await generate(dir).catch((e) => fail(e.message));
    console.log(`✓ wrote ${join(dir, "_generated")} (${modules.length} modules)`);
  },

  async build() {
    const dir = findConvexDir(values.dir);
    await generate(dir);
    const tag = values.tag ?? `${dockerEngine.projectName(dir)}:latest`;
    dockerEngine.buildAppImage(dir, tag);
    console.log(`✓ built ${tag}\n  run it: archlast-forge start --image ${tag}   (or docker run -p 3000:3000 -v data:/data --env-file .env ${tag})`);
  },
  async start() {
    const dir = findConvexDir(values.dir);
    if (useDocker()) {
      const image = values.image ?? fail("Pass --image <tag> (from `archlast-forge build`), or --no-docker to run in this process.");
      const name = dockerEngine.runEngine({
        convexDir: dir,
        port,
        dev: false,
        env: {},
        image,
        envFile: values["env-file"],
        services: values.with ? (values.with.split(",") as dockerEngine.Service[]) : [],
      });
      return console.log(`✓ ${name} running ${image} on port ${port} (restarts automatically; \`archlast-forge logs\` to follow)`);
    }
    const server = await serve({ convexDir: dir, dev: false, env: process.env });
    console.log(`✓ archlast-forge on ${server.url}`);
  },
  async stop() {
    const dir = findConvexDir(values.dir);
    for (const name of [dockerEngine.containerName(dir), dockerEngine.containerName(dir, true)])
      if (dockerEngine.isRunning(name)) dockerEngine.docker(["stop", "-t", "15", name], { inherit: true });
  },
  async logs() {
    const name = dockerEngine.runningContainer(findConvexDir(values.dir)) ?? fail("No engine container is running for this project");
    await dockerEngine.attach(name, false);
  },
  async status() {
    const name = dockerEngine.containerName(findConvexDir(values.dir));
    const r = dockerEngine.docker(["ps", "-a", "--filter", `name=^${name}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"]);
    console.log(r.out || `no containers for ${name}`);
  },

  async migrate() {
    const dir = findConvexDir(values.dir);
    if (forwarded(dir, ["migrate", ...rest, ...(values["run-migrations"] ? ["--run-migrations"] : []), ...(values.status ? ["--status"] : [])])) return;
    await withProject(async (p) => {
      if (values.status) {
        for (const m of await ops.migrationStatus(p)) console.log(`${m.state.padEnd(8)} ${m.name}  (${m.table}, ${m.processed} processed)${m.error ? `  ✗ ${m.error}` : ""}`);
        return;
      }
      if (values["run-migrations"]) {
        const ran = await ops.runMigrations(p, rest, (name, n) => process.stdout.write(`\r  ${name}: ${n} documents`)).catch((e) => fail(e.message));
        return console.log(ran.length ? `\n✓ ran ${ran.join(", ")}` : "✓ no pending migrations");
      }
      console.log(`✓ migrated ${Object.keys(p.project.tables).length} tables`);
      const invalid = await ops.invalidDocuments(p);
      for (const { id, error } of invalid.slice(0, 50)) console.error(`  ✗ ${id}: ${error}`);
      if (invalid.length) fail(`${invalid.length} documents don't match the schema; write a migration and run \`archlast-forge migrate --run-migrations\``);
    });
  },
  async export() {
    const file = rest[0] ?? fail("Usage: archlast-forge export <file>");
    const dir = findConvexDir(values.dir);
    const target = engineTarget(dir);
    if (target) {
      if (!dockerEngine.execInEngine(target, ["export", "/tmp/export.jsonl"]).ok) process.exit(1);
      if (!dockerEngine.copyFrom(target, "/tmp/export.jsonl", resolve(file))) fail("docker cp failed");
      return console.log(`✓ copied to ${file}`);
    }
    await withProject(async (p) => console.log(`✓ exported ${await ops.exportData(p, file)} documents to ${file}`));
  },
  async import() {
    const file = rest[0] ?? fail("Usage: archlast-forge import <file> [--replace]");
    const dir = findConvexDir(values.dir);
    const target = engineTarget(dir);
    if (target) {
      if (!dockerEngine.copyTo(target, resolve(file), "/tmp/import.jsonl")) fail("docker cp failed");
      if (!dockerEngine.execInEngine(target, ["import", "/tmp/import.jsonl", ...(values.replace ? ["--replace"] : [])]).ok) process.exit(1);
      return;
    }
    await withProject(async (p) => console.log(`✓ imported ${await ops.importData(p, file, { replace: values.replace }).catch((e) => fail(e.message))} documents`));
  },
  async backup() {
    const file = rest[0] ?? fail("Usage: archlast-forge backup <file>");
    const dir = findConvexDir(values.dir);
    const target = engineTarget(dir);
    if (target) {
      if (!dockerEngine.execInEngine(target, ["backup", "/tmp/backup.db"]).ok) process.exit(1);
      if (!dockerEngine.copyFrom(target, "/tmp/backup.db", resolve(file))) fail("docker cp failed");
      return console.log(`✓ copied to ${file}`);
    }
    await withProject(async (p) => {
      await ops.backup(p, resolve(file)).catch((e) => fail(e.message));
      console.log(`✓ backed up to ${file}`);
    });
  },

  async env() {
    const [action, name, value] = rest;
    const dir = findConvexDir(values.dir);
    if (forwarded(dir, ["env", ...rest])) {
      if (action === "set" || action === "rm") await reloadRunning(dir);
      return;
    }
    await withDb(async (db) => {
      if (action === "list" || !action) for (const e of await ops.listEnv(db)) console.log(`${e.name}=${e.value}`);
      else if (action === "get") console.log((await ops.listEnv(db)).find((e) => e.name === name)?.value ?? fail(`${name} isn't set`));
      else if (action === "set" && name && value !== undefined) await ops.setEnv(db, name, value).catch((e) => fail(e.message));
      else if (action === "rm" && name) await ops.removeEnv(db, name);
      else fail("Usage: archlast-forge env list | get <NAME> | set <NAME> <value> | rm <NAME>");
    });
    if (action === "set" || action === "rm") {
      console.log(`✓ ${action === "set" ? "set" : "removed"} ${name}`);
      if (!inContainer) await reloadRunning(dir);
    }
  },
  async admin() {
    const [action, email] = rest;
    const dir = findConvexDir(values.dir);
    const args = ["admin", ...rest, ...(values.role ? ["--role", values.role] : []), ...(values.password ? ["--password", values.password] : [])];
    if (forwarded(dir, args)) return;
    await withDb(async (db) => {
      if (action === "list" || !action) for (const a of await ops.listAdmins(db)) console.log(`${a.role.padEnd(6)} ${a.email}`);
      else if (action === "add" && email) {
        const password = values.password ?? Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString("base64url");
        await ops.addAdmin(db, email, password, (values.role ?? "admin") as ops.AdminRole).catch((e) => fail(e.message));
        console.log(`✓ ${email} (${values.role ?? "admin"})${values.password ? "" : `  password: ${password}`}`);
      } else if (action === "remove" && email) {
        await ops.removeAdmin(db, email).catch((e) => fail(e.message));
        console.log(`✓ removed ${email}`);
      } else fail("Usage: archlast-forge admin add <email> [--role owner|admin|viewer] [--password <pw>] | list | remove <email>");
    });
  },
  async dashboard() {
    console.log(`http://localhost:${port}/_dashboard`);
  },

  async engine() {
    const [action] = rest;
    if (action === "build") return dockerEngine.buildEngine(values.tag);
    if (action === "serve") return engineServe(Boolean(values.dev));
    if (action === "prepare") return prepare();
    fail("Usage: archlast-forge engine build [--tag <image>]");
  },
};

const run = values.help || !command ? undefined : commands[command];
if (!run) {
  console.log(USAGE);
  if (command && !values.help) process.exit(1);
} else await run().catch((e) => fail((e as Error).message));
