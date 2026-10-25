#!/usr/bin/env bun
import { ops } from "@archlast/forge-runtime/server";
import { watch } from "node:fs";
import { basename, join, resolve } from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { buildFramework, loadFramework } from "./app";
import { devSecrets, fail, findForgeDir, generate, trustProxyOrigins, VERSION } from "./common";
import { ensureDeps, findUp } from "./deps";
import * as dockerEngine from "./docker";
import { engineServe, prepare } from "./engine";
import { loadProjectConfig, projectRoot, type ProjectConfig } from "./project";
import { serve } from "./serve";
import * as stack from "./stack";
import { banner, c, ok, step, warn } from "./ui";

// `init` has its own options and prompts: hand everything after it to the scaffolder.
if (Bun.argv[2] === "init") {
  await (await import("create-archlast-forge")).main(Bun.argv.slice(3));
  process.exit(0);
}

const USAGE = `${c.bold("archlast-forge")} ${VERSION}

${c.bold("Start")}
  init [dir]              create a project: a full-stack app or a backend, with the services you pick
      --mode <framework|backend>   --services <postgres,redis,s3,caddy | none>   --yes   --no-install   --no-git

${c.bold("Develop")}
  dev                     run with live reload: a full-stack app on this machine, a backend's engine in Docker
      --port <n>          port to listen on (default 3000)
      --with <list>       services to start: postgres, redis, s3 (default: the ones in archlast-forge.json)
      --no-docker         run a backend's engine in this process
      --run "<cmd>"       also run a command alongside, e.g. a separate frontend
  codegen                 write forge/_generated/ and check what your frontend imports

${c.bold("Ship")}
  up                      build the image and start the stack in compose.yaml: the app and its services
  down [--volumes]        stop the stack (--volumes also deletes its data)
  logs [service]          follow the logs
  status                  show what is running
  build [--tag <image>]   build the app image   (--no-docker: only the production bundles of a full-stack app)
  start                   run in production: --no-docker here, or --image <tag> in Docker

${c.bold("Data")}
  migrate                 sync tables and indexes; report documents that don't match the schema
      --run-migrations [name…]  run data migrations (resumable)   --status   list them
  export <file>           all documents as JSON Lines
  import <file>           restore an export (--replace clears the tables first)
  backup <file>           SQLite database copy (use pg_dump for Postgres)

${c.bold("Config")}
  env list | env get <NAME> | env set <NAME> <value> | env rm <NAME>
  admin add <email> [--role owner|admin|viewer] [--password <pw>] | admin list | admin remove <email>
  dashboard               print the dashboard URL

${c.bold("Engine")}
  engine build            build the engine image from this repository
  stop                    stop a single engine container (older projects)

Options: --dir <forge dir>  --port <n>  --no-docker`;

/** A mistyped option is a one-line message, not a stack trace. */
function parseCommandLine<T extends ParseArgsConfig>(config: T) {
  try {
    return parseArgs(config);
  } catch (e) {
    return fail(`${(e as Error).message.replace(/\.$/, "")}. Run \`archlast-forge --help\` to see the options.`);
  }
}

const { positionals, values } = parseCommandLine({
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
    volumes: { type: "boolean" },
    rebuild: { type: "boolean" },
    dev: { type: "boolean" },
    help: { type: "boolean", short: "h" },
    version: { type: "boolean", short: "v" },
  },
});
if (values.version) {
  console.log(VERSION);
  process.exit(0);
}
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
  // The app's own address is trusted, and a proxy in front of it (code-server's port forwarding) is worked out from that one.
  env.TRUSTED_ORIGINS ||= `http://localhost:${port}`;
  env.BETTER_AUTH_URL = `http://localhost:${port}`; // a project's .env (made for the stack) must not point sessions at another address
  trustProxyOrigins(env);
  return env;
}

/** `--run "vite"`: a companion process for the frontend, stopped with the CLI. */
function companion() {
  if (!values.run) return;
  const proc = Bun.spawn(["sh", "-c", values.run], { stdout: "inherit", stderr: "inherit", stdin: "inherit" });
  process.on("exit", () => proc.kill());
}

/** The services `dev` starts: --with, or the ones in archlast-forge.json (Caddy is only for production). */
function devServices(cfg?: ProjectConfig): dockerEngine.Service[] {
  const wanted = values.with ? values.with.split(",").map((x) => x.trim()) : (cfg?.services ?? []);
  return wanted.filter((x) => x !== "caddy" && x !== "none") as dockerEngine.Service[];
}

/** Regenerates types and installs dependencies when forge/ changes; false means nothing needs a reload. */
function forgeChanged(dir: string) {
  return async (files: string[]) => {
    const source = files.filter((f) => !f.includes("_generated"));
    if (!source.length) return false; // our own codegen output
    const installed = source.some((f) => ["package.json", "bun.lock"].includes(basename(f))) && (await ensureDeps(dir));
    const code = source.some((f) => /\.(ts|js)$/.test(f));
    if (!installed && !code) return false;
    await generate(dir);
    return true;
  };
}

/** A full-stack app: the engine and the app in this process, services (if any) in Docker with ports on localhost. */
async function devFramework(dir: string, cfg: ProjectConfig) {
  const began = performance.now();
  const root = projectRoot(dir);
  const env = devEnv(dir);
  await ensureDeps(dir);
  ok(`codegen: ${(await generate(dir)).length} modules`);

  const services = devServices(cfg);
  let where: string[] = [];
  const noDocker = Boolean(values["no-docker"] || process.env.ARCHLAST_NO_DOCKER === "1");
  if (services.length && noDocker) warn(`--no-docker: not starting ${services.join(", ")}; using SQLite. Set DATABASE_URL, REDIS_URL or S3_* yourself to use others.`);
  else if (services.length) {
    if (!dockerEngine.dockerAvailable()) fail(`This project uses ${services.join(", ")}, which run in Docker, and Docker isn't available.\nStart Docker, or run \`archlast-forge dev --no-docker\` to develop on SQLite.`);
    step(`starting ${services.join(", ")}`);
    const started = dockerEngine.startServices(dockerEngine.containerName(dir, true), services, { host: true });
    Object.assign(env, started.env);
    where = started.where;
    process.on("exit", dockerEngine.stopStartedServices); // Ctrl-C ends the session, so it ends its services too
  }

  companion(); // --run "<cmd>"
  const { createApp } = await loadFramework(root, "server");
  const app = await createApp({ root, dev: true });
  const server = await serve({ forgeDir: dir, dev: true, env: { ...env, PORT: String(port) }, app, watchDir: dir, onChange: forgeChanged(dir) });
  banner(`${c.bold("archlast-forge")} ${VERSION}  ${c.dim("·")}  full-stack app  ${c.dim(`· ready in ${Math.round(performance.now() - began)} ms`)}`, [
    ["App", server.url],
    ["Dashboard", `${server.url}/_dashboard`],
    ["Admin key", env.ADMIN_KEY!],
    ...where.map((w): [string, string] => ["Service", w]),
  ]);
  console.log(c.dim("  Save a file and the page reloads. Ctrl-C stops everything.\n"));
  const lock = findUp(dir, "bun.lock");
  if (lock && !lock.startsWith(dir)) watch(lock, () => void ensureDeps(dir).then(async (did) => void (did && (await server.reload()))));
}

async function dev() {
  const dir = findForgeDir(values.dir);
  const cfg = loadProjectConfig(dir);
  if (cfg?.mode === "framework") return devFramework(dir, cfg);

  const env = devEnv(dir);
  companion();
  await ensureDeps(dir); // host install: editor types; the engine installs its own copy
  ok(`codegen: ${(await generate(dir)).length} modules`);

  if (useDocker()) {
    const name = dockerEngine.runEngine({
      forgeDir: dir,
      port,
      dev: true,
      env: { BETTER_AUTH_SECRET: env.BETTER_AUTH_SECRET!, ADMIN_KEY: env.ADMIN_KEY!, BETTER_AUTH_URL: `http://localhost:${port}`, TRUSTED_ORIGINS: env.TRUSTED_ORIGINS ?? "" },
      services: devServices(cfg),
    });
    banner(`${c.bold("archlast-forge")} ${VERSION}  ${c.dim("·")}  backend  ${c.dim("· engine in Docker")}`, [
      ["API", `http://localhost:${port}`],
      ["Dashboard", `http://localhost:${port}/_dashboard`],
      ["Admin key", env.ADMIN_KEY!],
      ["Container", name],
    ]);
    // The engine watches the mounted source; the host only keeps codegen current.
    watchSource(dir, async (files) => {
      if (files.some((f) => ["package.json", "bun.lock"].includes(basename(f)))) await ensureDeps(dir);
      await generate(dir);
    });
    await dockerEngine.attach(name, true);
    console.log(`${name} stopped`);
    process.exit(0); // the container is gone; don't linger on the file watcher
  }

  const skipped = devServices(cfg);
  if (skipped.length) warn(`Not starting ${skipped.join(", ")} without Docker; using SQLite. Set DATABASE_URL, REDIS_URL or S3_* yourself to use others.`);
  const server = await serve({ forgeDir: dir, dev: true, env: { ...env, PORT: String(port) }, watchDir: dir, onChange: forgeChanged(dir) });
  banner(`${c.bold("archlast-forge")} ${VERSION}  ${c.dim("·")}  backend  ${c.dim("· in this process")}`, [
    ["API", server.url],
    ["Dashboard", `${server.url}/_dashboard`],
    ["Admin key", env.ADMIN_KEY!],
  ]);
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
  // The app of a compose stack, then a single engine container.
  return stack.appContainer(projectRoot(dir)) ?? dockerEngine.runningContainer(dir) ?? null;
}

/**
 * Runs a data command in the running server (imports reach its subscribers), or here when no server answers.
 * Reaching the server needs ADMIN_KEY (the environment, or the dev secrets).
 */
async function data(cmd: string, args: Record<string, unknown> = {}): Promise<any> {
  const dir = findForgeDir(values.dir);
  const key = process.env.ADMIN_KEY ?? devEnv(dir).ADMIN_KEY;
  const res = await fetch(`http://localhost:${port}/_cli`, {
    method: "POST",
    headers: { "x-admin-key": key!, "content-type": "application/json" },
    body: JSON.stringify({ cmd, args }),
  }).catch(() => null);
  if (res && res.status !== 404) {
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; message?: string };
    if (res.status === 401) fail(`The server on port ${port} rejected the admin key; set ADMIN_KEY to the one it runs with.`);
    if (!res.ok) fail(body.message ?? `The server answered ${res.status}`);
    return body.result;
  }
  const env = { ...process.env, DATA_DIR: process.env.DATA_DIR ?? join(dir, "data") };
  try {
    if (/^(env|admin)\./.test(cmd)) {
      const db = await ops.openDb(env);
      try {
        return await ops.runCommand({ db }, cmd, args);
      } finally {
        await db.close();
      }
    }
    const p = await ops.openProject(dir, env);
    try {
      return await ops.runCommand(p, cmd, args);
    } finally {
      await p.close();
    }
  } catch (e) {
    return fail((e as Error).message);
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
    const dir = findForgeDir(values.dir);
    await ensureDeps(dir).catch((e) => fail(e.message));
    const modules = await generate(dir).catch((e) => fail(e.message));
    console.log(`✓ wrote ${join(dir, "_generated")} (${modules.length} modules)`);
  },

  async build() {
    const dir = findForgeDir(values.dir);
    const cfg = loadProjectConfig(dir);
    await generate(dir);
    if (!useDocker()) {
      if (cfg?.mode !== "framework") return console.log("Nothing to build without Docker: a backend runs straight from forge/ (`archlast-forge start --no-docker`).");
      await buildFramework(projectRoot(dir));
      return console.log(`\nRun it here with: archlast-forge start --no-docker`);
    }
    const tag = values.tag ?? `${dockerEngine.projectName(dir)}:latest`;
    dockerEngine.buildAppImage(dir, tag);
    ok(`built ${tag}`);
    console.log(`  run the whole stack: archlast-forge up\n  or just this image:  archlast-forge start --image ${tag}   (or docker run -p 3000:3000 -v data:/data --env-file .env ${tag})`);
  },
  async up() {
    const dir = findForgeDir(values.dir);
    const cfg = loadProjectConfig(dir) ?? fail("This folder has no archlast-forge.json. Create a project with `archlast-forge init`, or run a single image with `archlast-forge build` and `start --image`.");
    await ensureDeps(dir).catch((e) => fail(e.message));
    await generate(dir).catch((e) => fail(e.message));
    await stack.up(projectRoot(dir), cfg.services, { rebuild: values.rebuild });
  },
  async down() {
    await stack.down(projectRoot(findForgeDir(values.dir)), { volumes: values.volumes });
  },
  async start() {
    const dir = findForgeDir(values.dir);
    const cfg = loadProjectConfig(dir);
    if (useDocker()) {
      // A project with a stack starts as a stack; --image runs one image on its own.
      if (cfg && !values.image) return commands.up!();
      const image = values.image ?? fail("Pass --image <tag> (from `archlast-forge build`), or --no-docker to run in this process.");
      const name = dockerEngine.runEngine({
        forgeDir: dir,
        port,
        dev: false,
        env: {},
        image,
        envFile: values["env-file"],
        services: values.with ? (values.with.split(",") as dockerEngine.Service[]) : [],
      });
      return ok(`${name} running ${image} on port ${port} (restarts automatically; \`archlast-forge logs\` to follow)`);
    }
    let app;
    if (cfg?.mode === "framework") {
      const root = projectRoot(dir);
      app = await (await loadFramework(root, "server")).createApp({ root, dev: false }).catch((e: Error) => fail(e.message.includes("No production build") ? `${e.message}` : e.message));
    }
    // Next to forge/, where `dev` keeps it, unless DATA_DIR says otherwise.
    const server = await serve({ forgeDir: dir, dev: false, env: { ...process.env, DATA_DIR: process.env.DATA_DIR ?? join(dir, "data"), PORT: String(port) }, app });
    ok(`archlast-forge on ${server.url}${app ? " (app and API)" : ""}`);
  },
  async stop() {
    const dir = findForgeDir(values.dir);
    if (await stack.hasStack(projectRoot(dir))) return stack.down(projectRoot(dir));
    for (const name of [dockerEngine.containerName(dir), dockerEngine.containerName(dir, true)])
      if (dockerEngine.isRunning(name)) dockerEngine.docker(["stop", "-t", "15", name], { inherit: true });
  },
  async logs() {
    const dir = findForgeDir(values.dir);
    if (await stack.hasStack(projectRoot(dir))) return stack.logs(projectRoot(dir), rest[0]);
    const name = dockerEngine.runningContainer(dir) ?? fail("Nothing is running for this project (`archlast-forge up` starts the stack)");
    await dockerEngine.attach(name, false);
  },
  async status() {
    const dir = findForgeDir(values.dir);
    if (await stack.hasStack(projectRoot(dir))) return stack.status(projectRoot(dir));
    const name = dockerEngine.containerName(dir);
    const r = dockerEngine.docker(["ps", "-a", "--filter", `name=^${name}`, "--format", "{{.Names}}\t{{.Status}}\t{{.Ports}}"]);
    console.log(r.out || `no containers for ${name}`);
  },

  async migrate() {
    const dir = findForgeDir(values.dir);
    if (forwarded(dir, ["migrate", ...rest, ...(values["run-migrations"] ? ["--run-migrations"] : []), ...(values.status ? ["--status"] : [])])) return;
    if (values.status) {
      for (const m of await data("migrate.status")) console.log(`${m.state.padEnd(8)} ${m.name}  (${m.table}, ${m.processed} processed)${m.error ? `  ✗ ${m.error}` : ""}`);
      return;
    }
    if (values["run-migrations"]) {
      const ran: string[] = await data("migrate.run", { names: rest });
      return console.log(ran.length ? `✓ ran ${ran.join(", ")}` : "✓ no pending migrations");
    }
    const { tables, invalid } = await data("migrate.check");
    console.log(`✓ migrated ${tables} tables`);
    for (const { id, error } of invalid.slice(0, 50)) console.error(`  ✗ ${id}: ${error}`);
    if (invalid.length) fail(`${invalid.length} documents don't match the schema; write a migration and run \`archlast-forge migrate --run-migrations\``);
  },
  async export() {
    const file = rest[0] ?? fail("Usage: archlast-forge export <file>");
    const dir = findForgeDir(values.dir);
    const target = engineTarget(dir);
    if (target) {
      if (!dockerEngine.execInEngine(target, ["export", "/tmp/export.jsonl"]).ok) process.exit(1);
      if (!dockerEngine.copyFrom(target, "/tmp/export.jsonl", resolve(file))) fail("docker cp failed");
      return console.log(`✓ copied to ${file}`);
    }
    console.log(`✓ exported ${await data("export", { file: resolve(file) })} documents to ${file}`);
  },
  async import() {
    const file = rest[0] ?? fail("Usage: archlast-forge import <file> [--replace]");
    const dir = findForgeDir(values.dir);
    const target = engineTarget(dir);
    if (target) {
      if (!dockerEngine.copyTo(target, resolve(file), "/tmp/import.jsonl")) fail("docker cp failed");
      if (!dockerEngine.execInEngine(target, ["import", "/tmp/import.jsonl", ...(values.replace ? ["--replace"] : [])]).ok) process.exit(1);
      return;
    }
    console.log(`✓ imported ${await data("import", { file: resolve(file), replace: values.replace })} documents`);
  },
  async backup() {
    const file = rest[0] ?? fail("Usage: archlast-forge backup <file>");
    const dir = findForgeDir(values.dir);
    const target = engineTarget(dir);
    if (target) {
      if (!dockerEngine.execInEngine(target, ["backup", "/tmp/backup.db"]).ok) process.exit(1);
      if (!dockerEngine.copyFrom(target, "/tmp/backup.db", resolve(file))) fail("docker cp failed");
      return console.log(`✓ copied to ${file}`);
    }
    await data("backup", { file: resolve(file) });
    console.log(`✓ backed up to ${file}`);
  },

  async env() {
    const [action, name, value] = rest;
    const dir = findForgeDir(values.dir);
    if (forwarded(dir, ["env", ...rest])) {
      if (action === "set" || action === "rm") await reloadRunning(dir);
      return;
    }
    if (action === "list" || !action) for (const e of await data("env.list")) console.log(`${e.name}=${e.value}`);
    else if (action === "get") console.log((await data("env.list")).find((e: { name: string }) => e.name === name)?.value ?? fail(`${name} isn't set`));
    else if (action === "set" && name && value !== undefined) await data("env.set", { name, value });
    else if (action === "rm" && name) await data("env.rm", { name });
    else fail("Usage: archlast-forge env list | get <NAME> | set <NAME> <value> | rm <NAME>");
    if (action === "set" || action === "rm") {
      console.log(`✓ ${action === "set" ? "set" : "removed"} ${name}`);
      if (!inContainer) await reloadRunning(dir);
    }
  },
  async admin() {
    const [action, email] = rest;
    const dir = findForgeDir(values.dir);
    const args = ["admin", ...rest, ...(values.role ? ["--role", values.role] : []), ...(values.password ? ["--password", values.password] : [])];
    if (forwarded(dir, args)) return;
    if (action === "list" || !action) for (const a of await data("admin.list")) console.log(`${a.role.padEnd(6)} ${a.email}`);
    else if (action === "add" && email) {
      const password = values.password ?? Buffer.from(crypto.getRandomValues(new Uint8Array(15))).toString("base64url");
      await data("admin.add", { email, password, role: values.role ?? "admin" });
      console.log(`✓ ${email} (${values.role ?? "admin"})${values.password ? "" : `  password: ${password}`}`);
    } else if (action === "remove" && email) {
      await data("admin.remove", { email });
      console.log(`✓ removed ${email}`);
    } else fail("Usage: archlast-forge admin add <email> [--role owner|admin|viewer] [--password <pw>] | admin list | admin remove <email>");
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
