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
  /** `web` (a full-stack app) or `api` (a backend): the app the others are added to. */
  main: "web" | "api";
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
  return { port: Math.max(3000, ...apps.map((a) => a.port)) + 1, rpcPort: Math.max(4000, ...apps.map((a) => a.rpcPort ?? 0)) + 1 };
}

export const servicesOf = (ws: Workspace) => Object.entries(ws.apps).filter(([, a]) => a.kind === "service");
/** Every app with a forge/ of its own: the main app first. */
export const backendsOf = (ws: Workspace) => [ws.main, ...Object.keys(ws.apps)];

const isDir = (p: string) => existsSync(p) && statSync(p).isDirectory();

/** A monorepo without the file: its services are the backends beside the main app that have a router or a controller of their own. */
function infer(root: string): Workspace {
  const apps = join(root, "apps");
  const dirs = isDir(apps)
    ? readdirSync(apps)
        .filter((d) => isDir(join(apps, d)))
        .sort()
    : [];
  const main = dirs.includes("web") ? "web" : "api";
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
  const name: string = (existsSync(pkg) ? JSON.parse(readFileSync(pkg, "utf8")).name : undefined) ?? nameOf(root);
  if (!existsSync(file)) return { name, ws: infer(root), inferred: true };
  let json: Partial<Workspace>;
  try {
    json = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new Error(`${file} isn't valid JSON: ${(e as Error).message}`);
  }
  const bad = (why: string): never => {
    throw new Error(`${file}: ${why}`);
  };
  if (json.main !== "web" && json.main !== "api") bad(`"main" must be "web" or "api" (got ${JSON.stringify(json.main)})`);
  if (!TRANSPORTS.includes(json.transport as Transport)) bad(`"transport" must be one of ${TRANSPORTS.join(", ")}`);
  for (const [n, a] of Object.entries(json.apps ?? {}))
    if ((a.kind !== "service" && a.kind !== "app") || typeof a.port !== "number") bad(`"apps.${n}" needs a "kind" ("service" or "app") and a "port"`);
  return {
    name,
    ws: { main: json.main!, transport: json.transport!, apps: json.apps ?? {}, ...(json.mobile && { mobile: true }), ...(json.desktop && { desktop: json.desktop }) },
    inferred: false,
  };
}

export function writeWorkspace(root: string, ws: Workspace) {
  writeFileSync(join(root, WORKSPACE_FILE), JSON.stringify(ws, null, 2) + "\n");
}
