// The commands that change a project that exists: `monorepo`, `add`, `remove`, `workspace` and `stack`. The work is in evolve.ts and stack-edit.ts;
// this is what a person at a terminal sees: the plan, the confirmation, the install and codegen that follow, and what is left to do by hand.
import { DESKTOP_MODES, parseMicroservices, TRANSPORTS, type DesktopMode, type Transport } from "create-archlast-forge";
import { parseBaseColor } from "create-archlast-forge/shadcn";
import { parseServiceList, SERVICES, type Mode } from "create-archlast-forge/stack";
import { findWorkspaceRoot, loadWorkspace, WORKSPACE_FILE } from "create-archlast-forge/workspace";
import { existsSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fail, generate } from "./common";
import { ensureDeps } from "./deps";
import { addApp, addDesktopTo, addMobileTo, addService, convertToMonorepo, removeApp, syncWorkspace, type Change } from "./evolve";
import { changeStack } from "./stack-edit";
import { c, ok, step, warn } from "./ui";

/** The options of these commands, as the command line gives them. */
export interface GrowOptions {
  mode?: string;
  transport?: string;
  microservices?: string;
  services?: string;
  shadcn?: boolean;
  noShadcn?: boolean;
  baseColor?: string;
  yes?: boolean;
  dryRun?: boolean;
  noInstall?: boolean;
  mobile?: boolean;
  desktop?: string;
}

/** Asks before something that moves or deletes folders; with no terminal to ask on, it says to pass --yes and changes nothing. */
function confirmed(question: string, yes?: boolean): boolean {
  if (yes) return true;
  if (!process.stdin.isTTY) fail(`${question}\nThis changes folders and there is no terminal to ask on, so nothing was changed: run it again with --yes.`);
  return confirm(question);
}

const parseTransport = (text: string): Transport =>
  (TRANSPORTS as readonly string[]).includes(text) ? (text as Transport) : fail(`Unknown transport "${text}". Choose ${TRANSPORTS.join(", ")}.`);
const parseDesktop = (text: string): DesktopMode =>
  (DESKTOP_MODES as readonly string[]).includes(text) ? (text as DesktopMode) : fail(`Unknown desktop mode "${text}". Choose ${DESKTOP_MODES.join(" or ")}.`);

/** Reports what a change did, installs what it needs, and writes the types of the apps it changed. */
async function finish(change: Change, o: { noInstall?: boolean }, next?: string) {
  if (o.noInstall && next) next = `bun install, then ${next}`;
  for (const line of change.summary) ok(line);
  if (!o.noInstall) {
    step("bun install");
    const r = Bun.spawnSync([process.execPath, "install"], { cwd: change.root, stdout: "inherit", stderr: "inherit" });
    if (r.exitCode !== 0) warn("bun install failed: fix what it says, then run it again.");
    else
      for (const app of change.apps) {
        const forge = join(change.root, "apps", app, "forge");
        // Codegen writes forge/_generated (the types the monorepo's packages re-export); a failure here is not the change's.
        await ensureDeps(forge)
          .then(() => generate(forge))
          .catch((e: Error) => warn(`codegen in apps/${app} didn't finish: ${e.message}. \`archlast-forge codegen --dir apps/${app}/forge\` tries again.`));
      }
  }
  for (const note of change.notes) warn(note);
  if (next) console.log(`\n  ${c.dim("next")}  ${next}\n`);
}

/** `archlast-forge monorepo`: this project becomes the main app of a monorepo. */
export async function monorepo(root: string, o: GrowOptions) {
  const inside = findWorkspaceRoot(root);
  if (inside) fail(`${root} is already part of the monorepo at ${inside}. Add to it with \`archlast-forge add service <name>\` or \`add app <name>\`.`);
  const options = {
    dir: root,
    microservices: o.microservices ? parseMicroservices(o.microservices) : undefined,
    transport: o.transport ? parseTransport(o.transport) : undefined,
    mobile: o.mobile,
    desktop: o.desktop ? parseDesktop(o.desktop) : undefined,
  };
  const plan = convertToMonorepo({ ...options, dryRun: true });
  console.log(`${c.bold("Turning")} ${root} ${c.bold("into a monorepo:")}`);
  for (const line of plan.summary) console.log(`  ${c.dim("•")} ${line}`);
  console.log(c.dim("  Your code isn't reformatted; .env, data, compose.yaml, the lockfile and git history come along."));
  if (o.dryRun) return console.log("\nDry run: nothing was changed.");
  if (!confirmed("\nMove everything into apps/ and make this folder the monorepo's root?", o.yes)) return console.log("Nothing was changed.");
  await finish(convertToMonorepo(options), o, "bun run dev   (every app at once, with turbo)");
}

/** `archlast-forge add service|app|mobile|desktop`. */
export async function add(dir: string, what: string | undefined, name: string | undefined, o: GrowOptions) {
  const usage = "Usage: archlast-forge add service <name> | add app <name> [--mode framework|backend] [--services postgres,redis] [--no-shadcn] | add mobile | add desktop <full|client>";
  if (what === "service") {
    if (!name) fail(usage);
    return finish(addService(dir, name), o, `bun run dev   (apps/${name} starts with the others)`);
  }
  if (what === "app") {
    if (!name) fail(usage);
    const mode = (o.mode ?? "framework") as Mode;
    if (mode !== "framework" && mode !== "backend") fail(`Unknown mode "${o.mode}". Choose framework or backend.`);
    const shadcn = mode === "framework" && !o.noShadcn ? parseBaseColor(o.baseColor ?? "neutral") : undefined;
    if (mode === "backend" && (o.shadcn || o.baseColor)) fail("shadcn/ui is for full-stack apps: use --mode framework.");
    return finish(addApp(dir, name, { mode, shadcn, services: o.services ? parseServiceList(o.services) : undefined }), o, "bun run dev");
  }
  if (what === "mobile") return finish(addMobileTo(dir), o, "cd apps/mobile && bun run dev");
  if (what === "desktop") {
    if (!name) fail(usage);
    return finish(addDesktopTo(dir, parseDesktop(name)), o, "cd apps/desktop && bun run dev   (needs Rust and Tauri's prerequisites)");
  }
  fail(usage);
}

/** `archlast-forge remove <name>`. */
export async function remove(dir: string, name: string | undefined, o: GrowOptions) {
  if (!name) fail("Usage: archlast-forge remove <service | app | mobile | desktop>");
  const root = findWorkspaceRoot(dir);
  if (root && !existsSync(join(root, "apps", name))) fail(`There is no apps/${name} in ${root}.`);
  if (!confirmed(`Delete apps/${name}, with its code, its data and its .env, and what this monorepo has that calls it?`, o.yes)) return console.log("Nothing was deleted.");
  await finish(removeApp(dir, name), o, "git status shows what went; `git checkout .` and `git clean` bring it back if it is in a repository");
}

const kindOf = (root: string, name: string) => {
  const file = join(root, "apps", name, "archlast-forge.json");
  return existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).mode === "framework" ? "full-stack app" : "backend") : "";
};

/** `archlast-forge workspace [sync]`: what the monorepo is made of, or write its shared packages again from apps/. */
export async function workspace(dir: string, action: string | undefined, o: GrowOptions) {
  const root = findWorkspaceRoot(dir) ?? fail(`${dir} isn't in a monorepo. \`archlast-forge monorepo\` makes one from this project.`);
  if (action === "sync") return finish(syncWorkspace(root), o);
  if (action) fail("Usage: archlast-forge workspace | workspace sync");
  const { name, ws, inferred } = loadWorkspace(root);
  const label = ws.transport === "forge-rpc" ? "Forge RPC" : ws.transport.toUpperCase();
  const rows: [string, string, string][] = [[ws.main, `main app, ${kindOf(root, ws.main)}`, "http://localhost:3000"]];
  for (const [n, a] of Object.entries(ws.apps)) rows.push([n, a.kind === "service" ? `service, ${label} on ${a.rpcPort}` : kindOf(root, n), `http://localhost:${a.port}`]);
  if (ws.mobile) rows.push(["mobile", "Expo app", ""]);
  if (ws.desktop) rows.push(["desktop", `Tauri app (${ws.desktop})`, ""]);
  const services = Object.values(ws.apps).some((a) => a.kind === "service");
  console.log(`\n  ${c.bold(name)}  ${c.dim(relative(process.cwd(), root) || ".")}${services ? `  ${c.dim(`services talk over ${label}`)}` : ""}\n`);
  const width = Math.max(...rows.map((r) => r[0].length));
  const width2 = Math.max(...rows.map((r) => r[1].length));
  for (const [n, what, url] of rows) console.log(`  ${c.bold(`apps/${n}`.padEnd(width + 5))}  ${what.padEnd(width2)}  ${c.dim(url)}`);
  console.log(inferred ? `\n  ${c.dim(`No ${WORKSPACE_FILE}: this was worked out from the folders. The first change writes it.`)}\n` : "");
}

/** `archlast-forge stack [add|remove] <postgres,redis,s3,caddy>`: the services in this app's compose.yaml. */
export function stack(root: string, action: string | undefined, list: string | undefined) {
  const config = existsSync(join(root, "archlast-forge.json")) ? JSON.parse(readFileSync(join(root, "archlast-forge.json"), "utf8")) : undefined;
  if (!action) {
    if (!config) fail(`No archlast-forge.json in ${root}: run this in a project made by \`archlast-forge init\`.`);
    console.log(
      `\n  ${c.bold("stack")}  ${(config.services as string[]).join(", ") || "no services"}\n  ${c.dim(`available: ${Object.keys(SERVICES).join(", ")}  ·  archlast-forge stack add|remove <list>`)}\n`,
    );
    return;
  }
  if ((action !== "add" && action !== "remove") || !list) fail("Usage: archlast-forge stack | stack add <postgres,redis,s3,caddy> | stack remove <list>");
  const change = changeStack(root, { [action]: parseServiceList(list) });
  for (const line of change.summary) ok(line);
  for (const note of change.notes) warn(note);
}
