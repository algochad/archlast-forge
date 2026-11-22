// What a monorepo is made of, kept in archlast-forge.workspace.json at its root: the main app, how services talk, and each service's and app's
// ports. `init --monorepo` writes it and the commands that change a monorepo (`add`, `remove`, `workspace sync`) read it. A monorepo made
// before the file existed has it worked out from the folders instead.
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DesktopMode } from "./desktop";
import { nameOf } from "./options";

/** Forge RPC first: typed calls between forge apps, which is what the services here are. */
export const TRANSPORTS = ["forge-rpc", "tcp", "redis", "nats"] as const;
export type Transport = (typeof TRANSPORTS)[number];
export const TRANSPORT_LABEL: Record<Transport, string> = { "forge-rpc": "Forge RPC", tcp: "TCP", redis: "Redis", nats: "NATS" };

export const camel = (s: string) => s.replace(/-([a-z0-9])/g, (_, c: string) => c.toUpperCase());
export const pascal = (s: string) => camel(s)[0]!.toUpperCase() + camel(s).slice(1);
export const env = (s: string) => s.toUpperCase().replace(/-/g, "_");

/**
 * The name of the package of apps/<app>. A backend main app lives in apps/api, and packages/api (the typed APIs) is `@<name>/api`: two workspace
 * packages can't share a name, so the app's is `@<name>/backend`.
 */
export const packageOf = (name: string, app: string) => (app === "api" ? `@${name}/backend` : `@${name}/${app}`);

export const WORKSPACE_FILE = "archlast-forge.workspace.json";

/** An app in apps/ other than the main app, the mobile app and the desktop app. */
export interface WorkspaceApp {
  /** A service is called by the main app (over `transport`); an app is a project of its own. */
  kind: "service" | "app";
  /** Where `dev` serves it on this machine. */
  port: number;
  /** A service's port for the transport: Forge RPC's or TCP's. */
  rpcPort?: number;
}

/** archlast-forge.workspace.json */
export interface Workspace {
  /** The folder in apps/ of the main app, the one the others are added to: `web` (a full-stack app) or `api` (a backend) in a monorepo `init` made, whatever it is called in one made by hand. */
  main: string;
  /** What the monorepo's packages are scoped with (`@<scope>/api`), when that isn't the name in the root package.json. */
  scope?: string;
  /** Development HTTP port for the main app. */
  mainPort?: number;
  /** Route Forge HTTP development through Portless. The configured ports are direct-mode fallbacks. */
  portless?: boolean;
  /** Forge RPC services called by each app. The main app defaults to every service. */
  dependsOn?: Record<string, string[]>;
  transport: Transport;
  apps: Record<string, WorkspaceApp>;
  mobile?: boolean;
  desktop?: DesktopMode;
}

const NAME = /^[a-z][a-z0-9-]{0,30}$/;
const RESERVED = ["web", "api", "mobile", "desktop"];

/** Checks the name of a service or an app. `existing` are the names already taken in apps/. */
export function checkAppName(name: string, existing: string[] = []): string {
  if (!NAME.test(name)) throw new Error(`"${name}" isn't a name for a service or an app: lowercase letters, digits and "-", starting with a letter`);
  if (RESERVED.includes(name)) throw new Error(`"${name}" is taken by the monorepo's own apps; pick another name`);
  if (existing.includes(name)) throw new Error(`"${name}" is already an app of this monorepo`);
  return name;
}

/** Whether `dir` is the root of a monorepo (made with `init --monorepo`, or by hand the same way). */
export const isMonorepo = (dir: string) => existsSync(join(dir, WORKSPACE_FILE)) || (existsSync(join(dir, "turbo.json")) && existsSync(join(dir, "packages", "api")));

/** The monorepo `from` is in (or is the root of), or undefined. */
export function findWorkspaceRoot(from: string): string | undefined {
  for (let d = resolve(from); ; d = dirname(d)) {
    if (isMonorepo(d)) return d;
    if (dirname(d) === d) return undefined;
  }
}

/** The ports above these are taken by the main app (3000, and 4000 is nobody's), so a new service or app gets the next one. */
export function nextPorts(ws: Workspace): { port: number; rpcPort: number } {
  const apps = Object.values(ws.apps);
  const main = ws.mainPort ?? 3000;
  const used = new Set([main, ...apps.flatMap((a) => [a.port, a.rpcPort])]);
  let port = Math.max(3000, main, ...apps.map((a) => a.port)) + 1;
  while (used.has(port)) port++;
  let rpcPort = Math.max(4000, ...apps.map((a) => a.rpcPort ?? 0)) + 1;
  while (used.has(rpcPort) || rpcPort === port) rpcPort++;
  return { port, rpcPort };
}

export const servicesOf = (ws: Workspace) => Object.entries(ws.apps).filter(([, a]) => a.kind === "service");
/** Every app with a forge/ of its own: the main app first. */
export const backendsOf = (ws: Workspace) => [ws.main, ...Object.keys(ws.apps)];

export const portOf = (ws: Workspace, app: string) =>
  app === ws.main ? (ws.mainPort ?? 3000) : ws.apps[app]!.port;
export const dependenciesOf = (ws: Workspace, app: string) =>
  ws.dependsOn?.[app] ??
  (app === ws.main ? servicesOf(ws).map(([name]) => name) : []);

export function validateWorkspace(ws: Workspace) {
  const apps = backendsOf(ws);
  const ports = new Map<number, string>();
  const take = (port: number, label: string) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new Error(`${label} needs a port from 1 to 65535`);
    const previous = ports.get(port);
    if (previous)
      throw new Error(
        `Development port ${port} is used by both ${previous} and ${label}`,
      );
    ports.set(port, label);
  };
  for (const app of apps) {
    take(portOf(ws, app), `${app} HTTP`);
    const service = ws.apps[app];
    if (
      service?.kind === "service" &&
      (ws.transport === "forge-rpc" || ws.transport === "tcp")
    )
      take(service.rpcPort ?? 4001, `${app} ${ws.transport}`);
  }
  if (ws.dependsOn === undefined) return;
  if (
    !ws.dependsOn ||
    typeof ws.dependsOn !== "object" ||
    Array.isArray(ws.dependsOn) ||
    ws.transport !== "forge-rpc"
  )
    throw new Error("`dependsOn` must map app names to Forge RPC services");
  for (const [app, deps] of Object.entries(ws.dependsOn)) {
    if (
      !apps.includes(app) ||
      !Array.isArray(deps) ||
      deps.some(
        (dep) =>
          typeof dep !== "string" ||
          !Object.hasOwn(ws.apps, dep) ||
          ws.apps[dep]?.kind !== "service",
      )
    )
      throw new Error(`${app}: dependsOn must list services in this workspace`);
  }
  const checked = new Set<string>();
  const visit = (app: string, path: string[]) => {
    if (path.includes(app))
      throw new Error(
        `Forge RPC dependency cycle: ${[...path, app].join(" → ")}`,
      );
    if (checked.has(app)) return;
    for (const dep of dependenciesOf(ws, app)) visit(dep, [...path, app]);
    checked.add(app);
  };
  for (const app of apps) visit(app, []);
}

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** Whether apps/<app> is a full-stack app or a backend, from its archlast-forge.json (no file: a backend, as for any project from before it existed). */
export function modeOf(root: string, app: string): "framework" | "backend" {
  const file = join(root, "apps", app, "archlast-forge.json");
  return existsSync(file) && JSON.parse(readFileSync(file, "utf8")).mode === "framework" ? "framework" : "backend";
}

/** The package name of apps/<app>: what its package.json says (a monorepo made by hand names its apps its own way), else what `init` would call it. */
export function appPackage(root: string, scope: string, app: string): string {
  const file = join(root, "apps", app, "package.json");
  return (existsSync(file) ? (JSON.parse(readFileSync(file, "utf8")).name as string | undefined) : undefined) ?? packageOf(scope, app);
}

/**
 * A monorepo without the file: the main app is `web`, else `api`, else the only app with an archlast-forge.json, and its services are the
 * backends beside it that have a router or a controller of their own.
 */
function infer(root: string): Workspace {
  const apps = join(root, "apps");
  const dirs = isDir(apps)
    ? readdirSync(apps)
        .filter((d) => isDir(join(apps, d)))
        .sort()
    : [];
  const projects = dirs.filter((d) => !["mobile", "desktop"].includes(d) && existsSync(join(apps, d, "archlast-forge.json")));
  const main = projects.includes("web") ? "web" : projects.includes("api") ? "api" : projects.length === 1 ? projects[0]! : undefined;
  if (!main)
    throw new Error(
      projects.length
        ? `Can't tell which of ${projects.join(", ")} is the main app: say so with "main" in ${join(root, WORKSPACE_FILE)}, as in { "main": "${projects[0]}", "transport": "forge-rpc", "apps": {} }.`
        : `${root} has no app in apps/ (a folder with an archlast-forge.json).`,
    );
  const ws: Workspace = { main, transport: "forge-rpc", apps: {} };
  let n = 0;
  for (const d of dirs) {
    if (d === main || RESERVED.includes(d) || !existsSync(join(apps, d, "archlast-forge.json"))) continue;
    const forge = join(apps, d, "forge");
    const dev: string = JSON.parse(readFileSync(join(apps, d, "package.json"), "utf8")).scripts?.dev ?? "";
    const port = Number(/--port (\d+)/.exec(dev)?.[1] ?? 3001 + n);
    const http = existsSync(join(forge, "http.ts")) ? readFileSync(join(forge, "http.ts"), "utf8") : "";
    const router = existsSync(join(forge, `${d}.router.ts`));
    const controller = existsSync(join(forge, `${d}.controller.ts`));
    if (router) ws.transport = "forge-rpc";
    else if (controller) ws.transport = /Transport\.REDIS/.test(http) ? "redis" : /Transport\.NATS/.test(http) ? "nats" : "tcp";
    const rpcPort = Number(/_(?:RPC_)?PORT \?\? (\d+)/.exec(http)?.[1]) || 4001 + n;
    ws.apps[d] = router || controller ? { kind: "service", port, rpcPort } : { kind: "app", port };
    n++;
  }
  if (existsSync(join(apps, "mobile"))) ws.mobile = true;
  if (isDir(join(apps, "desktop"))) ws.desktop = isDir(join(apps, "desktop", "engine")) ? "full" : "client";
  return ws;
}

/** The monorepo at `root`: its name (its root package.json's), and what it is made of. `inferred` means there was no manifest. */
export function loadWorkspace(root: string): { name: string; ws: Workspace; inferred: boolean } {
  const file = join(root, WORKSPACE_FILE);
  const pkg = join(root, "package.json");
  const rootName: string = (existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).name : undefined) ?? nameOf(root);
  if (!existsSync(file)) return { name: rootName, ws: infer(root), inferred: true };
  let json: Partial<Workspace>;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  const bad = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  if (!json || typeof json !== "object" || Array.isArray(json)) bad("expected a workspace object");
  if (typeof json.main !== "string" || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(json.main)) bad(`"main" must be the folder of the main app in apps/ (got ${JSON.stringify(json.main)})`);
  if (!isDir(join(root, "apps", json.main!))) bad(`"main" is "${json.main}", and there is no apps/${json.main}`);
  if (json.scope !== undefined && !/^[a-z0-9][a-z0-9._-]*$/.test(String(json.scope))) bad(`"scope" must be a package scope without the @ (got ${JSON.stringify(json.scope)})`);
  if (!TRANSPORTS.includes(json.transport as Transport)) bad(`"transport" must be one of ${TRANSPORTS.join(", ")}`);
  if (json.apps !== undefined && (!json.apps || typeof json.apps !== "object" || Array.isArray(json.apps))) bad(`"apps" must be an object`);
  for (const [n, a] of Object.entries(json.apps ?? {}))
    if (n === json.main || !/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(n) || !a || (a.kind !== "service" && a.kind !== "app") || typeof a.port !== "number") bad(`"apps.${n}" needs a "kind" ("service" or "app") and a "port"`);
  if (json.portless !== undefined && typeof json.portless !== "boolean") bad('"portless" must be a boolean');
  const ws: Workspace = {
    main: json.main!,
    ...(json.portless !== undefined && { portless: json.portless }),
    ...(json.scope && { scope: json.scope }),
    transport: json.transport!,
    apps: json.apps ?? {},
    ...(json.mainPort !== undefined && { mainPort: json.mainPort }),
    ...(json.dependsOn !== undefined && { dependsOn: json.dependsOn }),
    ...(json.mobile && { mobile: true }),
    ...(json.desktop && { desktop: json.desktop }),
  };
  validateWorkspace(ws);
  return { name: json.scope ?? rootName, ws, inferred: false };
}

export function writeWorkspace(root: string, ws: Workspace) {
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify(ws, null, 2) + "\n");
}
