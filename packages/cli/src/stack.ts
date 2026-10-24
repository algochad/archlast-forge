// The production stack: `up` builds the app image and starts everything in compose.yaml, `down` stops it.
import { generateSecrets, renderEnv, type StackService } from "create-archlast-forge/stack";
import { existsSync, readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { fail } from "./common";
import { dockerAvailable, engineImage, ensureEngineImage } from "./docker";
import { banner, c, ok, task, warn } from "./ui";

const DOCKER = process.env.DOCKER ?? "docker";

const composeFile = (root: string) => join(root, "compose.yaml");

function requireStack(root: string) {
  if (!dockerAvailable()) fail("Docker isn't available. Install it and make sure it is running; the stack runs in containers.");
  if (!existsSync(composeFile(root)))
    fail(`No compose.yaml in ${root}. Projects made with \`archlast-forge init\` have one; for an older project, create the stack with:\n  bun create archlast-forge <new-folder> --mode backend\nand copy compose.yaml, Dockerfile and .dockerignore across.`);
}

/** Runs `docker compose` for the project without blocking the spinner. */
async function compose(root: string, args: string[], opts: { inherit?: boolean } = {}) {
  const proc = Bun.spawn([DOCKER, "compose", "--project-directory", root, "-f", composeFile(root), ...args], {
    env: { ...process.env, ENGINE_IMAGE: process.env.ENGINE_IMAGE ?? engineImage() },
    stdin: "ignore",
    stdout: opts.inherit ? "inherit" : "pipe",
    stderr: opts.inherit ? "inherit" : "pipe",
  });
  const [out, err, code] = await Promise.all([proc.stdout ? new Response(proc.stdout).text() : "", proc.stderr ? new Response(proc.stderr).text() : "", proc.exited]);
  return { ok: code === 0, out: out.trim(), err: err.trim() };
}

/** Creates .env with fresh secrets if there isn't one. It is never overwritten: it holds the keys to the data. */
export function ensureEnv(root: string, services: StackService[]): boolean {
  const file = join(root, ".env");
  if (existsSync(file)) return false;
  writeFileSync(file, renderEnv(services, generateSecrets()));
  chmodSync(file, 0o600);
  return true;
}

const envValue = (root: string, key: string) => new RegExp(`^${key}=(.*)$`, "m").exec(existsSync(join(root, ".env")) ? readFileSync(join(root, ".env"), "utf8") : "")?.[1]?.trim();

/** Builds and starts the stack, and waits until the app reports healthy. */
export async function up(root: string, services: StackService[], opts: { rebuild?: boolean } = {}) {
  requireStack(root);
  if (ensureEnv(root, services)) ok("Created .env with fresh secrets (keep it out of git; it holds the keys to your data)");
  ensureEngineImage();

  await task("Building the app image", async () => {
    const r = await compose(root, ["build", ...(opts.rebuild ? ["--no-cache"] : [])]);
    if (!r.ok) throw new Error(r.err || r.out);
  }).catch((e: Error) => fail(`The app image didn't build. The end of the output:\n\n${e.message.split("\n").slice(-15).join("\n")}`));

  let upResult: { ok: boolean; err: string } | undefined;
  await task(`Starting ${services.length ? `the app and ${services.filter((s) => s !== "caddy").join(", ") || "its proxy"}` : "the app"}`, async () => {
    upResult = await compose(root, ["up", "-d", "--no-build", "--wait", "--wait-timeout", "240"]);
    if (!upResult.ok) throw new Error(upResult.err);
  }).catch(async () => {
    console.error(`\n${upResult?.err.split("\n").slice(-6).join("\n")}\n`);
    const logs = await compose(root, ["logs", "--tail", "30", "app"]);
    console.error(c.dim(logs.out || logs.err));
    fail("The stack didn't become healthy. The app's last log lines are above; `archlast-forge logs` follows them.");
  });

  const url = envValue(root, "BETTER_AUTH_URL") ?? "http://localhost:3000";
  banner(`${c.green("●")} ${c.bold("up")}`, [
    ["App", url],
    ["Dashboard", `${url}/_dashboard`],
    ["Admin key", "ADMIN_KEY in .env"],
    ["Logs", "archlast-forge logs"],
    ["Stop", "archlast-forge down"],
  ]);
  if (envValue(root, "ALLOW_INSECURE_HTTP") === "1" && !services.includes("caddy")) warn("Serving plain http, which is fine for trying it out. Put it behind https (add Caddy, or your own proxy) before real users arrive.");
}

export async function down(root: string, opts: { volumes?: boolean } = {}) {
  requireStack(root);
  const r = await task(opts.volumes ? "Stopping the stack and deleting its data" : "Stopping the stack", () => compose(root, ["down", ...(opts.volumes ? ["--volumes"] : [])]));
  if (!r.ok) fail(r.err);
  if (!opts.volumes) console.log(c.dim("  Data stays in Docker volumes. `archlast-forge down --volumes` deletes it."));
}

/** True when the project's stack has containers (running or not). */
export async function hasStack(root: string): Promise<boolean> {
  if (!existsSync(composeFile(root)) || !dockerAvailable()) return false;
  const r = await compose(root, ["ps", "-a", "-q"]);
  return r.ok && r.out.length > 0;
}

export async function logs(root: string, service?: string) {
  requireStack(root);
  await compose(root, ["logs", "--follow", "--tail", "100", ...(service ? [service] : [])], { inherit: true });
}

export async function status(root: string) {
  requireStack(root);
  await compose(root, ["ps", "-a"], { inherit: true });
}
