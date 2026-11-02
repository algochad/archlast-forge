// Changing a project that exists: turning an app into a monorepo, and adding or removing services and apps in one. The commands are in the CLI
// (`archlast-forge monorepo`, `add`, `remove`, `workspace sync`); everything here works on files, so tests and other tools can call it too.
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import type { DesktopMode } from "create-archlast-forge";
import {
  addDesktopApp,
  addMobile,
  ensureToken,
  finishServices,
  newCtx,
  patchJson,
  writeBarrel,
  writeRoot,
  writeService,
  writeShared,
  type Ctx,
  type Transport,
} from "create-archlast-forge/monorepo";
import { defaultServices, nameOf } from "create-archlast-forge/options";
import { format, scaffold, VERSION, type ScaffoldOptions } from "create-archlast-forge/scaffold";
import type { Mode, StackService } from "create-archlast-forge/stack";
import {
  camel,
  checkAppName,
  findWorkspaceRoot,
  isMonorepo,
  loadWorkspace,
  nextPorts,
  packageOf,
  servicesOf,
  TRANSPORTS,
  writeWorkspace,
  type Workspace,
} from "create-archlast-forge/workspace";

/** What a change did: for the CLI to report, and to run codegen where code was written. */
export interface Change {
  /** The monorepo's root. */
  root: string;
  /** What was done, a line each. */
  summary: string[];
  /** What is left for the user, because it is in code the change doesn't own. */
  notes: string[];
  /** The apps (folders of apps/) whose forge/ was written or changed. */
  apps: string[];
}

const NOT_A_MONOREPO = (dir: string) =>
  `${resolve(dir)} isn't in a monorepo. Make one from this project with \`archlast-forge monorepo\`, or start one with \`archlast-forge init --monorepo\`.`;

/** The monorepo `dir` is in, ready to change. */
function open(dir: string): Ctx {
  const root = findWorkspaceRoot(dir);
  if (!root) throw new Error(NOT_A_MONOREPO(dir));
  const { name, ws } = loadWorkspace(root);
  return newCtx(root, name, VERSION, ws);
}

const done = (c: Ctx, summary: string[], apps: string[]): Change => {
  writeWorkspace(c.root, c.ws);
  format(c.root, c.written);
  return { root: c.root, summary, notes: c.notes, apps };
};

const appDir = (c: Ctx, app: string) => join(c.root, "apps", app);

/** A service: its own backend in apps/<name>, and in the main app a class that calls it, a controller and an action over that class. */
export function addService(dir: string, svc: string): Change {
  const c = open(dir);
  const { ws } = c;
  checkAppName(svc, Object.keys(ws.apps));
  if (existsSync(appDir(c, svc))) throw new Error(`apps/${svc} already exists. Pick another name, or move that folder.`);
  const mine = [`${svc}.service.ts`, `${svc}.controller.ts`, `${camel(svc)}.ts`].find((f) => existsSync(join(appDir(c, ws.main), "forge", f)));
  if (mine) throw new Error(`apps/${ws.main}/forge/${mine} already exists, and the main app's calls to ${svc} are written there. Pick another name.`);

  ws.apps[svc] = { kind: "service", ...nextPorts(ws) };
  writeService(c, svc);
  finishServices(c, [svc]);
  const { port, rpcPort } = ws.apps[svc]!;
  return done(
    c,
    [
      `apps/${svc}: the ${svc} service, served by ${ws.transport === "forge-rpc" ? "Forge RPC" : ws.transport} on ${rpcPort}, dev on ${port}`,
      `apps/${ws.main}/forge: ${svc}.service.ts, ${svc}.controller.ts and ${camel(svc)}.ts call it`,
    ],
    [svc, ws.main],
  );
}

export interface AddAppOptions {
  /** A full-stack app (the default) or a backend. */
  mode?: Mode;
  shadcn?: ScaffoldOptions["shadcn"];
  /** The stack services in its compose.yaml. Default: the mode's. */
  services?: StackService[];
}

/** Another app in apps/: a whole project of its own (a full-stack app or a backend), with its types in packages/api. */
export function addApp(dir: string, name: string, o: AddAppOptions = {}): Change {
  const c = open(dir);
  const { ws } = c;
  checkAppName(name, Object.keys(ws.apps));
  if (existsSync(appDir(c, name))) throw new Error(`apps/${name} already exists. Pick another name, or move that folder.`);
  const mode = o.mode ?? "framework";
  ws.apps[name] = { kind: "app", port: nextPorts(ws).port };
  scaffold({ dir: appDir(c, name), mode, services: defaultServices(mode, o.services), shadcn: o.shadcn, version: c.version, name: `${c.name}-${name}` });
  patchJson(join(appDir(c, name), "package.json"), (pkg) => {
    pkg.name = packageOf(c.name, name);
    pkg.scripts.dev = `archlast-forge dev --no-docker --port ${ws.apps[name]!.port}`;
  });
  writeShared(c); // packages/api gains it
  ensureToken(c); // a backend of the monorepo can call its services
  return done(
    c,
    [
      `apps/${name}: a ${mode === "framework" ? "full-stack app" : "backend"}, dev on ${ws.apps[name]!.port}`,
      `packages/api/${name}.ts: its typed API, as ${camel(name)}Api from @${c.name}/api/${name}`,
    ],
    [name],
  );
}

/** apps/mobile, an Expo app that is a client of the main app, a backend. */
export function addMobileTo(dir: string): Change {
  const c = open(dir);
  if (c.ws.main !== "api") throw new Error("The Expo app is a client of a backend, and this monorepo's main app is a full-stack app (apps/web): Expo has no full-stack option.");
  if (existsSync(appDir(c, "mobile"))) throw new Error("apps/mobile already exists.");
  addMobile(c);
  return done(c, ["apps/mobile: an Expo app, a client of apps/api", "apps/api/forge/package.json: @better-auth/expo"], ["api"]);
}

/** apps/desktop, a Tauri app: the full-stack app with its engine on the user's machine, or a client of the main app. */
export function addDesktopTo(dir: string, mode: DesktopMode): Change {
  const c = open(dir);
  if (mode === "full" && c.ws.main !== "web")
    throw new Error("--desktop full runs the full-stack app on the user's machine, and this monorepo's main app is a backend: use `add desktop client`.");
  if (existsSync(appDir(c, "desktop"))) throw new Error("apps/desktop already exists.");
  addDesktopApp(c, mode);
  return done(c, [`apps/desktop: a Tauri app (${mode})`], []);
}

/**
 * Deletes an app, a service (and the main app's calls to it) or the mobile or desktop app. It deletes folders, with their data and .env:
 * the CLI asks first, and a repository gets them back with git.
 */
export function removeApp(dir: string, name: string): Change {
  const c = open(dir);
  const { ws } = c;
  const summary: string[] = [];
  if (name === ws.main) throw new Error(`apps/${name} is the main app of this monorepo: the others are added to it, so it can't be removed.`);
  if (name === "mobile" || name === "desktop") {
    if (!existsSync(appDir(c, name))) throw new Error(`There is no apps/${name}.`);
    rmSync(appDir(c, name), { recursive: true, force: true });
    if (name === "mobile") delete ws.mobile;
    else delete ws.desktop;
    summary.push(`apps/${name}: deleted`);
    if (name === "mobile") c.notes.push("apps/api/forge/auth.ts and @better-auth/expo were left as they are: they are harmless without the app, and yours to remove.");
    return done(c, summary, []);
  }
  const app = ws.apps[name];
  if (!app) throw new Error(`There is no app or service named "${name}" in this monorepo. It has: ${[ws.main, ...Object.keys(ws.apps)].join(", ")}.`);
  if (app.kind === "service") {
    for (const f of [`${name}.service.ts`, `${name}.controller.ts`, `${camel(name)}.ts`]) {
      const file = join(appDir(c, ws.main), "forge", f);
      if (existsSync(file)) (rmSync(file), summary.push(`apps/${ws.main}/forge/${f}: deleted`));
    }
  }
  rmSync(appDir(c, name), { recursive: true, force: true });
  delete ws.apps[name];
  summary.unshift(`apps/${name}: deleted`);
  if (app.kind === "service")
    finishServices(c, []); // the barrel, packages/api and packages/contracts without it
  else writeShared(c);
  return done(c, summary, app.kind === "service" ? [ws.main] : []);
}

/** Writes packages/api, packages/contracts and the main app's service list from the apps that are in apps/ now, and adds apps made by hand to the workspace. */
export function syncWorkspace(dir: string): Change {
  const c = open(dir);
  const { ws } = c;
  const summary: string[] = [];
  for (const [name, app] of Object.entries(ws.apps)) {
    if (existsSync(appDir(c, name))) continue;
    delete ws.apps[name];
    summary.push(`${name}: its folder is gone, so it is no longer in the workspace`);
    if (app.kind === "service") c.notes.push(`apps/${ws.main}/forge/${name}.service.ts, ${name}.controller.ts and ${camel(name)}.ts called ${name}: delete them.`);
  }
  const apps = join(c.root, "apps");
  for (const d of readdirSync(apps)) {
    if (d === ws.main || d in ws.apps || ["mobile", "desktop"].includes(d) || !existsSync(join(apps, d, "archlast-forge.json"))) continue;
    const dev: string = JSON.parse(readFileSync(join(apps, d, "package.json"), "utf8")).scripts?.dev ?? "";
    ws.apps[d] = { kind: "app", port: Number(/--port (\d+)/.exec(dev)?.[1]) || nextPorts(ws).port };
    summary.push(`${d}: found in apps/, added to the workspace as an app`);
  }
  const mainPkg = join(c.root, "apps", ws.main, "package.json");
  if (existsSync(mainPkg) && JSON.parse(readFileSync(mainPkg, "utf8")).name === `@${c.name}/api`) {
    patchJson(mainPkg, (pkg) => (pkg.name = packageOf(c.name, ws.main)));
    summary.push(`apps/${ws.main}/package.json: renamed to ${packageOf(c.name, ws.main)}, because @${c.name}/api is packages/api and bun install refuses two packages of one name`);
  }
  writeBarrel(c);
  writeShared(c);
  summary.push(
    "packages/api" + (ws.transport === "forge-rpc" && servicesOf(ws).length ? ", packages/contracts" : "") + " and the main app's list of services: written from the apps in apps/",
  );
  return done(c, summary, []);
}

export interface ConvertOptions {
  /** The project to turn into a monorepo: the folder that holds forge/. */
  dir: string;
  microservices?: string[];
  transport?: Transport;
  mobile?: boolean;
  desktop?: DesktopMode;
  /** Report what would move and be written, and change nothing. */
  dryRun?: boolean;
}

/** What stays where it is: the repository's own files and folders (CI, editors, the licence) belong to the repository, not to the app. */
const STAYS = /^(\.git|\.github|\.gitlab|\.vscode|\.idea|\.husky|\.claude|node_modules|LICEN[CS]E.*)$/;

/**
 * Turns a project (a full-stack app or a backend) into a monorepo, in place: its files move to apps/web or apps/api, and the monorepo's own
 * files (package.json with workspaces, turbo.json, packages/api, a README) are written around it. The project keeps everything it had:
 * .env, its data, compose.yaml (whose project name, and so its Docker volumes, doesn't change), its lockfile and its history.
 * Prettier runs only over the files this writes: the project's own code is not reformatted.
 */
export function convertToMonorepo(o: ConvertOptions): Change & { moves: string[] } {
  const root = resolve(o.dir);
  if (isMonorepo(root)) throw new Error(`${root} is a monorepo already. Add to it with \`archlast-forge add service <name>\` or \`add app <name>\`.`);
  if (!existsSync(join(root, "forge"))) throw new Error(`No forge/ in ${root}: run this in the folder of the project to convert.`);
  if (existsSync(join(root, "apps"))) throw new Error(`${join(root, "apps")} exists already, and a monorepo's apps go there. Move or rename it first.`);
  const configFile = join(root, "archlast-forge.json");
  const mode: Mode = existsSync(configFile) ? JSON.parse(readFileSync(configFile, "utf8")).mode : "backend";
  if (mode !== "framework" && mode !== "backend") throw new Error(`${configFile}: "mode" must be "framework" or "backend"`);
  const main = mode === "framework" ? "web" : "api";
  const services = o.microservices ?? [];
  for (const s of services) checkAppName(s);
  if (new Set(services).size !== services.length) throw new Error("A service is named twice");
  if (o.transport && !TRANSPORTS.includes(o.transport)) throw new Error(`Unknown transport "${o.transport}". Choose ${TRANSPORTS.join(", ")}.`);
  if (o.mobile && mode !== "backend") throw new Error("The Expo app is a client of a backend, and this project is a full-stack app: Expo has no full-stack option.");
  if (o.desktop === "full" && mode !== "framework") throw new Error("--desktop full runs the full-stack app on the user's machine, and this project is a backend: use --desktop client.");

  const moves = readdirSync(root)
    .filter((f) => !STAYS.test(f))
    .sort();
  const summary = [
    `${moves.length} files and folders move to apps/${main}: ${moves.join(", ")}`,
    "package.json, turbo.json, README.md, .gitignore and archlast-forge.workspace.json: the monorepo's, at the root",
    "packages/api: the main app's typed API",
    ...services.map((svc) => `apps/${svc}: the ${svc} service`),
    ...(o.mobile ? ["apps/mobile: an Expo app, a client of apps/api"] : []),
    ...(o.desktop ? [`apps/desktop: a Tauri app (${o.desktop})`] : []),
  ];
  if (o.dryRun) return { root, summary, notes: [], apps: [], moves };

  mkdirSync(join(root, "apps", main), { recursive: true });
  for (const f of moves) renameSync(join(root, f), join(root, "apps", main, f));

  const name = nameOf(root);
  const ws: Workspace = { main, transport: o.transport ?? "forge-rpc", apps: {} };
  services.forEach((svc, i) => (ws.apps[svc] = { kind: "service", port: 3001 + i, rpcPort: 4001 + i }));
  const c = newCtx(root, name, VERSION, ws);
  if (existsSync(join(root, "apps", main, "package.json"))) patchJson(join(root, "apps", main, "package.json"), (pkg) => (pkg.name = packageOf(name, main)));
  for (const svc of services) writeService(c, svc);
  finishServices(c, services);
  if (o.mobile) addMobile(c);
  if (o.desktop) addDesktopApp(c, o.desktop);
  writeRoot(c);

  c.notes.push(`The project's own bun.lock moved with it to apps/${main}. The monorepo's lockfile is the one \`bun install\` makes at the root, and the old one can go once that exists.`);
  if (existsSync(join(root, ".github"))) c.notes.push(`.github stays at the root. Steps in it that ran in the project's folder now run in apps/${main}.`);
  format(root, c.written);
  return { root, summary, notes: c.notes, apps: [main, ...services], moves };
}

/** Whether a folder is a project that `monorepo` can convert, for the CLI's message. */
export const isProject = (dir: string) => existsSync(join(dir, "forge")) && statSync(join(dir, "forge")).isDirectory();
