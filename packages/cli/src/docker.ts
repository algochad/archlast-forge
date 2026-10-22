// Host side of the Docker engine: the CLI starts, stops and talks to the engine container.
import { cpSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative } from "node:path";
import { fail, VERSION } from "./common";

const DOCKER = process.env.DOCKER ?? "docker";
const REPO_ROOT = new URL("../../..", import.meta.url).pathname.replace(/\/$/, "");
export const ENGINE_DOCKERFILE = join(REPO_ROOT, "docker", "engine.Dockerfile");

export const engineImage = () => process.env.ARCHLAST_ENGINE_IMAGE ?? `archlast-forge/engine:${VERSION}`;

export function docker(args: string[], opts: { inherit?: boolean; input?: string } = {}) {
  const proc = Bun.spawnSync([DOCKER, ...args], {
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
    stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
  });
  return { ok: proc.exitCode === 0, out: proc.stdout?.toString().trim() ?? "", err: proc.stderr?.toString().trim() ?? "" };
}

let available: boolean | undefined;
export const dockerAvailable = () => (available ??= Bun.spawnSync([DOCKER, "info"], { stdout: "ignore", stderr: "ignore" }).exitCode === 0);

/** Stable per-project name, from the directory holding convex/. */
export function projectName(convexDir: string) {
  const root = basename(convexDir) === "convex" ? dirname(convexDir) : convexDir;
  const slug = basename(root).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "app";
  return `${slug}-${Bun.hash(root).toString(16).slice(0, 6)}`;
}
/** Production and dev containers of a project have separate names, so one never replaces the other. */
export const containerName = (convexDir: string, dev = false) => `archlast-forge-${projectName(convexDir)}${dev ? "-dev" : ""}`;

/** The project's running engine container (production first), if any. */
export const runningContainer = (convexDir: string) => [containerName(convexDir), containerName(convexDir, true)].find(isRunning);

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
  fail(`Engine image ${image} not found. Pull it, or set ARCHLAST_ENGINE_IMAGE.`);
}

const SERVICES = {
  postgres: {
    image: "postgres:17-alpine",
    env: { POSTGRES_USER: "forge", POSTGRES_PASSWORD: "forge", POSTGRES_DB: "forge" },
    volume: "/var/lib/postgresql/data",
    provides: (host: string) => ({ DATABASE_URL: `postgres://forge:forge@${host}:5432/forge` }),
  },
  redis: { image: "redis:7-alpine", env: {}, volume: "/data", provides: (host: string) => ({ REDIS_URL: `redis://${host}:6379` }) },
  s3: {
    image: "rustfs/rustfs:latest",
    env: { RUSTFS_ACCESS_KEY: "forgeadmin", RUSTFS_SECRET_KEY: "forgeadmin", RUSTFS_CORS_ALLOWED_ORIGINS: "*" },
    volume: "/data",
    cmd: ["/data"],
    provides: (host: string) => ({ S3_ENDPOINT: `http://${host}:9000`, S3_BUCKET: "forge", S3_ACCESS_KEY_ID: "forgeadmin", S3_SECRET_ACCESS_KEY: "forgeadmin", S3_REGION: "us-east-1" }),
  },
} as const;
export type Service = keyof typeof SERVICES;

/** Starts service containers on the project's network; returns the env vars that point the engine at them. */
function startServices(name: string, services: Service[]) {
  const env: Record<string, string> = {};
  if (!services.length) return env;
  docker(["network", "create", name]);
  for (const s of services) {
    const def = SERVICES[s];
    if (!def) fail(`Unknown service "${s}" (postgres, redis, s3)`);
    const host = `${name}-${s}`;
    if (!isRunning(host)) {
      docker(["rm", "-f", host]);
      const envArgs = Object.entries(def.env).flatMap(([k, v]) => ["-e", `${k}=${v}`]);
      const cmd = "cmd" in def ? [...def.cmd] : [];
      const run = docker(["run", "-d", "--name", host, "--network", name, "-v", `${host}:${def.volume}`, ...envArgs, def.image, ...cmd]);
      if (!run.ok) fail(`Couldn't start ${s}: ${run.err}`);
      console.log(`✓ ${s} container ${host}`);
    }
    Object.assign(env, def.provides(host));
  }
  if (services.includes("s3")) {
    // The bucket must exist before the first upload.
    for (let i = 0; i < 30; i++) {
      const mb = docker(["run", "--rm", "--network", name, "-e", "AWS_ACCESS_KEY_ID=forgeadmin", "-e", "AWS_SECRET_ACCESS_KEY=forgeadmin", "-e", "AWS_DEFAULT_REGION=us-east-1", "amazon/aws-cli", "--endpoint-url", `http://${name}-s3:9000`, "s3", "mb", "s3://forge"]);
      if (mb.ok || /BucketAlready/.test(mb.err)) break;
      Bun.sleepSync(1000);
    }
  }
  return env;
}

export interface RunOptions {
  convexDir: string;
  port: number;
  dev: boolean;
  env: Record<string, string>;
  services?: Service[];
  image?: string;
  /** Defaults to convex/.env when it exists. */
  envFile?: string;
}

/** Runs the engine container. In dev, convex/ is mounted read-only and the engine watches it. */
export function runEngine(o: RunOptions) {
  const name = containerName(o.convexDir, o.dev);
  const image = o.image ?? ensureEngineImage();
  docker(["rm", "-f", name]);
  const serviceEnv = startServices(name, o.services ?? []);
  const env = { PORT: "3000", DATA_DIR: "/data", ...serviceEnv, ...o.env };
  const envFile = o.envFile ?? join(o.convexDir, ".env");
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
    ...(o.dev ? ["-v", `${o.convexDir}:/src/convex:ro`, "-v", `${name}-modules:/app/convex/node_modules`] : ["--restart", "unless-stopped"]),
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
    }
    logs.kill();
    process.exit(0);
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  return logs.exited;
}

/** Builds a production image: the engine plus this project's code and dependencies. */
export function buildAppImage(convexDir: string, tag: string) {
  const image = ensureEngineImage();
  const ctx = mkdtempSync(join(tmpdir(), "afx-build-"));
  try {
    cpSync(convexDir, join(ctx, "convex"), {
      recursive: true,
      filter: (src) => !relative(convexDir, src).split("/").some((seg) => seg === "node_modules" || seg === "data" || seg === ".env" || seg === ".git"),
    });
    writeFileSync(
      join(ctx, "Dockerfile"),
      `FROM ${image}\nCOPY convex /src/convex\nRUN bun /engine/packages/cli/src/index.ts engine prepare\nENV NODE_ENV=production\n`,
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
  return docker(["exec", name, "bun", "/engine/packages/cli/src/index.ts", ...args, "--dir", "/app/convex", "--no-docker"], opts);
}

export const copyFrom = (name: string, path: string, to: string) => docker(["cp", `${name}:${path}`, to]).ok;
export const copyTo = (name: string, from: string, path: string) => docker(["cp", from, `${name}:${path}`]).ok;
