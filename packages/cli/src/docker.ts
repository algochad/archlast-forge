// Host side of the Docker engine: the CLI starts, stops and talks to the engine container.
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fail, VERSION } from "./common";
import { projectRoot } from "./project";

const DOCKER = process.env.DOCKER ?? "docker";
const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
export const ENGINE_DOCKERFILE = join(REPO_ROOT, "docker", "engine.Dockerfile");

/** Released to GHCR by the release workflow; `engine build` tags local builds the same way. */
export const engineImage = () => process.env.ARCHLAST_ENGINE_IMAGE ?? `ghcr.io/algochad/archlast-forge-engine:${VERSION}`;

export function docker(args: string[], opts: { inherit?: boolean; input?: string } = {}) {
  const proc = Bun.spawnSync([DOCKER, ...args], {
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
  });
  return { ok: proc.exitCode === 0, out: proc.stdout?.toString().trim() ?? "", err: proc.stderr?.toString().trim() ?? "" };
}

let available: boolean | undefined;
export const dockerAvailable = () => {
  try {
    return (available ??= Bun.spawnSync([DOCKER, "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0);
  } catch {
    return (available = false); // no docker binary at all: Bun throws instead of failing the command
  }
};

/** Stable per-project name, from the directory holding forge/. */
export function projectName(forgeDir: string) {
  const root = ["forge", "convex"].includes(basename(forgeDir)) ? dirname(forgeDir) : forgeDir;
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  return `${slug}-${Bun.hash(root).toString(16).slice(0, 6)}`;
}
/** Production and dev containers of a project have separate names, so one never replaces the other. */
export const containerName = (forgeDir: string, dev = false) => `archlast-forge-${projectName(forgeDir)}${dev ? "-dev" : ""}`;

/** The project's running engine container (production first), if any. */
export const runningContainer = (forgeDir: string) => [containerName(forgeDir), containerName(forgeDir, true)].find(isRunning);

export const isRunning = (name: string) => docker(["inspect", "-f", "{{.State.Running}}", name]).out === "true";

/** Builds the engine image from this repository. */
export function buildEngine(tag = engineImage()) {
  if (!existsSync(ENGINE_DOCKERFILE)) fail(`No engine Dockerfile at ${ENGINE_DOCKERFILE}; set ARCHLAST_ENGINE_IMAGE to a published image instead.`);
  console.log(`→ building ${tag}`);
  if (!docker(["build", "-f", ENGINE_DOCKERFILE, "-t", tag, REPO_ROOT], { inherit: true }).ok) fail("Engine image build failed");
  return tag;
}

export function ensureEngineImage() {
  const image = engineImage();
  if (docker(["image", "inspect", image]).ok) return image;
  if (existsSync(ENGINE_DOCKERFILE)) return buildEngine(image);
  console.log(`→ pulling ${image}`);
  if (docker(["pull", image], { inherit: true }).ok) return image;
  fail(`Engine image ${image} isn't available. Set ARCHLAST_ENGINE_IMAGE to one you can pull or build.`);
}

const SERVICES = {
  postgres: {
    image: "postgres:17-alpine",
    env: { POSTGRES_USER: "forge", POSTGRES_PASSWORD: "forge", POSTGRES_DB: "forge" },
    volume: "/var/lib/postgresql/data",
    port: 5432,
    provides: (address: string) => ({ DATABASE_URL: `postgres://forge:forge@${address}/forge` }),
  },
  redis: { image: "redis:7-alpine", env: {}, volume: "/data", port: 6379, provides: (address: string) => ({ REDIS_URL: `redis://${address}` }) },
  s3: {
    image: "rustfs/rustfs:latest",
    env: { RUSTFS_ACCESS_KEY: "forgeadmin", RUSTFS_SECRET_KEY: "forgeadmin", RUSTFS_CORS_ALLOWED_ORIGINS: "*" },
    volume: "/data",
    cmd: ["/data"],
    port: 9000,
    // shortcut: with the engine in a container, one project per machine can publish 9000; set S3_ENDPOINT yourself for more.
    publish: "9000:9000",
    provides: (address: string, host: boolean) => ({
      S3_ENDPOINT: `http://${address}`,
      S3_PUBLIC_ENDPOINT: host ? `http://${address}` : process.env.S3_PUBLIC_ENDPOINT || "http://localhost:9000",
      S3_BUCKET: "forge",
      S3_ACCESS_KEY_ID: "forgeadmin",
      S3_SECRET_ACCESS_KEY: "forgeadmin",
      S3_REGION: "us-east-1",
    }),
  },
} as const;
export type Service = keyof typeof SERVICES;

/** The host port Docker published for a container port. */
function publishedPort(container: string, port: number) {
  const out = docker(["port", container, `${port}/tcp`]).out;
  const found = /:(\d+)\s*$/m.exec(out);
  if (!found) fail(`Couldn't find the published port of ${container} (docker port said: ${out || "nothing"})`);
  return Number(found![1]);
}

/** Blocks until a service answers, so the engine doesn't start against a database that is still initializing. */
function waitReady(container: string, service: Service) {
  const probe = { postgres: ["pg_isready", "-U", "forge", "-d", "forge"], redis: ["redis-cli", "ping"], s3: undefined }[service];
  if (!probe) return;
  for (let i = 0; i < 120; i++) {
    if (docker(["exec", container, ...probe]).ok) return;
    Bun.sleepSync(500);
  }
  fail(`${service} didn't become ready in 60 s. See: docker logs ${container}`);
}

export interface StartedServices {
  env: Record<string, string>;
  /** For display: "postgres on localhost:54321". */
  where: string[];
}

/** Service containers this process started, so `dev` can stop exactly those when it ends. */
const startedHere = new Set<string>();

/** Stops the service containers this process started. Their data stays in the named volumes. */
export function stopStartedServices() {
  for (const container of startedHere) docker(["stop", "-t", "3", container]);
  startedHere.clear();
}

/**
 * Starts service containers on the project's network and returns the env vars that point the engine at them.
 * `host: true` is for an engine running on this machine: ports are published on 127.0.0.1 and the URLs say localhost.
 * Otherwise the engine is a container on the same network and uses the containers' names.
 */
export function startServices(name: string, services: Service[], opts: { host?: boolean } = {}): StartedServices {
  const out: StartedServices = { env: {}, where: [] };
  if (!services.length) return out;
  docker(["network", "create", name]);
  for (const s of services) {
    const def = SERVICES[s];
    if (!def) fail(`Unknown service "${s}" (postgres, redis, s3)`);
    const container = `${name}-${s}`;
    if (!isRunning(container)) {
      docker(["rm", "-f", container]);
      const envArgs = Object.entries(def.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const cmd = "cmd" in def ? [...def.cmd] : [];
      const publish = opts.host ? ["-p", `127.0.0.1::${def.port}`] : "publish" in def ? ["-p", def.publish] : [];
      const run = docker(["run", "-d", "--name", container, "--network", name, "-v", `${container}:${def.volume}`, ...publish, ...envArgs, def.image, ...cmd]);
      if (!run.ok) fail(`Couldn't start ${s}: ${run.err}`);
      startedHere.add(container);
    }
    waitReady(container, s);
    const address = opts.host ? `localhost:${publishedPort(container, def.port)}` : `${container}:${def.port}`;
    Object.assign(out.env, (def.provides as (a: string, h: boolean) => Record<string, string>)(address, Boolean(opts.host)));
    out.where.push(`${s} on ${address}`);
  }
  if (services.includes("s3")) {
    // The bucket must exist before the first upload.
    for (let i = 0; i < 30; i++) {
      const mb = docker(["run", "--rm", "--network", name, "-e", "AWS_ACCESS_KEY_ID=forgeadmin", "-e", "AWS_SECRET_ACCESS_KEY=forgeadmin", "-e", "AWS_DEFAULT_REGION=us-east-1", "amazon/aws-cli", "--endpoint-url", `http://${name}-s3:9000`, "s3", "mb", "s3://forge"]);
      if (mb.ok || /BucketAlready/.test(mb.err)) break;
      Bun.sleepSync(1000);
    }
  }
  return out;
}

export interface RunOptions {
  forgeDir: string;
  port: number;
  dev: boolean;
  env: Record<string, string>;
  services?: Service[];
  image?: string;
  /** Defaults to forge/.env when it exists. */
  envFile?: string;
}

/** Runs the engine container. In dev, forge/ is mounted read-only and the engine watches it. */
export function runEngine(o: RunOptions) {
  const name = containerName(o.forgeDir, o.dev);
  const image = o.image ?? ensureEngineImage();
  docker(["rm", "-f", name]);
  const serviceEnv = startServices(name, o.services ?? []).env;
  const env = { PORT: "3000", DATA_DIR: "/data", ...serviceEnv, ...o.env };
  const envFile = o.envFile ?? join(o.forgeDir, ".env");
  const args = [
    "run",
    "-d",
    "--name",
    name,
    "-p",
    `${o.port}:3000`,
    "-v",
    `${name}-data:/data`,
    "--add-host",
    "host.docker.internal:host-gateway",
    ...((o.services ?? []).length ? ["--network", name] : []),
    ...(existsSync(envFile) ? ["--env-file", envFile] : []),
    ...Object.entries(env).flatMap(([k, v]) => ["-e", `${k}=${v}`]),
    ...(o.dev ? ["-v", `${o.forgeDir}:/src/forge:ro`, "-v", `${name}-modules:/app/forge/node_modules`] : ["--restart", "unless-stopped"]),
    image,
    "engine",
    "serve",
    ...(o.dev ? ["--dev"] : []),
  ];
  const run = docker(args);
  if (!run.ok) fail(`docker run failed: ${run.err}`);
  return name;
}

/** Follows the container's logs; Ctrl-C stops the container (dev). */
export function attach(name: string, stopOnExit: boolean) {
  const logs = Bun.spawn([DOCKER, "logs", "-f", "--since", "0s", name], { stdout: "inherit", stderr: "inherit" });
  const stop = () => {
    if (stopOnExit) {
      console.log(`\nstopping ${name}…`);
      docker(["stop", "-t", "15", name]); // SIGTERM: the engine drains connections first
      stopStartedServices();
    }
    logs.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return logs.exited;
}

/**
 * Builds a production image: the engine plus this project's code and dependencies.
 * A project made by `archlast-forge init` has its own Dockerfile and builds from its root; older ones get a generated one around forge/.
 */
export function buildAppImage(forgeDir: string, tag: string) {
  const image = ensureEngineImage();
  const root = projectRoot(forgeDir);
  if (existsSync(join(root, "Dockerfile")) && existsSync(join(root, "archlast-forge.json"))) {
    console.log(`→ building ${tag} from ${image}`);
    if (!docker(["build", "-t", tag, "-f", join(root, "Dockerfile"), "--build-arg", `ENGINE_IMAGE=${image}`, root], { inherit: true }).ok) fail("App image build failed");
    return tag;
  }
  const ctx = mkdtempSync(join(tmpdir(), "afx-build-"));
  try {
    cpSync(forgeDir, join(ctx, "forge"), {
      recursive: true,
      filter: (src) => !relative(forgeDir, src).split("/").some((seg) => seg === "node_modules" || seg === "data" || seg === ".env" || seg === ".git"),
    });
    writeFileSync(
      join(ctx, "Dockerfile"),
      `FROM ${image}\nCOPY forge /src/forge\nRUN bun /engine/packages/cli/src/index.ts engine prepare\nENV NODE_ENV=production\n`,
    );
    console.log(`→ building ${tag} from ${image}`);
    if (!docker(["build", "-t", tag, ctx], { inherit: true }).ok) fail("App image build failed");
  } finally {
    rmSync(ctx, { recursive: true, force: true });
  }
  return tag;
}

/** Runs a CLI command inside the running engine container. */
export function execInEngine(name: string, args: string[], opts: { inherit?: boolean } = { inherit: true }) {
  return docker(["exec", name, "bun", "/engine/packages/cli/src/index.ts", ...args, "--dir", "/app/forge", "--no-docker"], opts);
}

export const copyFrom = (name: string, path: string, to: string) => docker(["cp", `${name}:${path}`, to]).ok;
export const copyTo = (name: string, from: string, path: string) => docker(["cp", from, `${name}:${path}`]).ok;
