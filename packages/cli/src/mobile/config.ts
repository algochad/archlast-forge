import {
  appPackage,
  findWorkspaceRoot,
  loadWorkspace,
  portOf,
  servicesOf,
  validateWorkspace,
} from "create-archlast-forge/workspace";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

const targets = [
  "auto",
  "device",
  "waydroid",
  "emulator",
  "ios-simulator",
] as const;
export type Target = (typeof targets)[number];
export type Client = "go" | "dev-client";

export interface MobileFlags {
  target?: string;
  device?: string;
  "android-api"?: string;
  "android-abi"?: string;
  "avd-profile"?: string;
  client?: string;
  "metro-port"?: string;
  "backend-port"?: string;
  apk?: string;
  "accept-licenses"?: boolean;
  yes?: boolean;
}

export function androidHome() {
  if (process.env.FORGE_HOME)
    return join(resolve(process.env.FORGE_HOME), "android");
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA || join(homedir(), "AppData", "Local")
      : process.platform === "darwin"
        ? join(homedir(), "Library", "Application Support")
        : process.env.XDG_DATA_HOME || join(homedir(), ".local", "share");
  return join(base, "archlast-forge", "android");
}

function positiveInteger(
  value: unknown,
  min: number,
  max: number,
  name: string,
) {
  const number =
    typeof value === "number" ||
    (typeof value === "string" && /^\d+$/.test(value))
      ? Number(value)
      : NaN;
  if (!Number.isInteger(number) || number < min || number > max)
    throw new Error(`${name} must be an integer from ${min} to ${max}.`);
  return number;
}

export function mobileProject(dir: string, flags: MobileFlags) {
  const root = findWorkspaceRoot(dir);
  if (!root)
    throw new Error(
      "Run from a Forge workspace with apps/mobile. Use archlast-forge add mobile to create it.",
    );
  const { name, ws } = loadWorkspace(root);
  const mobile = join(root, "apps", "mobile");
  if (!ws.mobile || !existsSync(join(mobile, "package.json")))
    throw new Error(
      "This workspace has no Expo client. Run archlast-forge add mobile.",
    );
  if (
    ws.mobileDev !== undefined &&
    (!ws.mobileDev ||
      typeof ws.mobileDev !== "object" ||
      Array.isArray(ws.mobileDev))
  )
    throw new Error("Workspace mobileDev must be an object.");
  const config = ws.mobileDev ?? {};
  const target = flags.device
    ? "device"
    : (flags.target ?? config.target ?? "auto");
  if (!(targets as readonly string[]).includes(target))
    throw new Error(
      `Unknown mobile target ${target}. Choose ${targets.join(", ")}.`,
    );
  if (
    flags.device &&
    flags.target &&
    !["auto", "device"].includes(flags.target)
  )
    throw new Error(
      "--device selects a connected Android target. Omit --target or use --target device.",
    );
  const client =
    flags.client ?? config.client ?? (flags.apk ? "dev-client" : "go");
  if (client !== "go" && client !== "dev-client")
    throw new Error("Mobile client must be go or dev-client.");
  if (flags.apk && client !== "dev-client")
    throw new Error("--apk requires --client dev-client.");
  const api = positiveInteger(
    flags["android-api"] ?? config.api ?? 36,
    24,
    99,
    "Android API",
  );
  const abi =
    flags["android-abi"] ??
    config.abi ??
    (process.arch === "arm64" ? "arm64-v8a" : "x86_64");
  if (abi !== "x86_64" && abi !== "arm64-v8a")
    throw new Error("Android ABI must be x86_64 or arm64-v8a.");
  const profile = flags["avd-profile"] ?? config.profile ?? "pixel_7";
  if (typeof profile !== "string" || !/^[a-zA-Z0-9_-]+$/.test(profile))
    throw new Error("Invalid AVD profile.");
  const backendPort = positiveInteger(
    flags["backend-port"] ?? config.backendPort ?? portOf(ws, ws.main),
    1,
    65535,
    "Forge port",
  );
  const metro = flags["metro-port"] ?? config.metroPort;
  const metroPort =
    metro === undefined
      ? undefined
      : positiveInteger(metro, 1, 65535, "Metro port");
  validateWorkspace({ ...ws, mainPort: backendPort });
  const workspacePorts = new Set([
    backendPort,
    ...Object.values(ws.apps).flatMap((app) => [app.port, app.rpcPort]),
  ]);
  if (metroPort && workspacePorts.has(metroPort))
    throw new Error(
      "Metro's port must differ from the configured Forge HTTP and RPC ports.",
    );

  const manifest = JSON.parse(
    readFileSync(join(mobile, "package.json"), "utf8"),
  );
  const app = existsSync(join(mobile, "app.json"))
    ? JSON.parse(readFileSync(join(mobile, "app.json"), "utf8")).expo
    : undefined;
  const sdk = Number(/\d+/.exec(manifest.dependencies?.expo ?? "")?.[0]);
  const filters = [
    ws.main,
    ...(ws.transport === "forge-rpc"
      ? []
      : servicesOf(ws).map(([service]) => service)),
  ].map((app) => `--filter=${appPackage(root, name, app)}`);
  return {
    root,
    mobile,
    target: target as Target,
    device: flags.device,
    client: client as Client,
    api,
    abi,
    profile,
    backendPort,
    metroPort,
    sdk,
    app,
    filters,
    workspacePorts,
    apk: flags.apk ? resolve(dir, flags.apk) : undefined,
    image: `system-images;android-${api};google_apis;${abi}`,
    home: androidHome(),
  };
}

export type MobileProject = ReturnType<typeof mobileProject>;
