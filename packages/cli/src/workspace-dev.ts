import { createHmac, randomBytes } from "node:crypto";
import {
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import {
  backendsOf,
  dependenciesOf,
  env,
  findWorkspaceRoot,
  loadWorkspace,
  portOf,
  servicesOf,
  validateWorkspace,
  type Workspace,
} from "create-archlast-forge/workspace";
import { runDevChild } from "./common";
import { localPortlessEnv, portlessName, portlessRoutes, tunnelProvider, type TunnelProvider } from "./portless";

// Generated Turbo tasks already pass through PORTLESS*. Use a checkout-specific name
// so a co-scheduled dependency can keep its usual local URL without opening a tunnel.
const TUNNEL_SELECTION = "PORTLESS_FORGE_TUNNEL";

export function workspaceTunnel(root: string, app: string): TunnelProvider | undefined {
  const [name, provider] = process.env[TUNNEL_SELECTION]?.split(":") ?? [];
  if (provider && name === portlessName(root, app)) return tunnelProvider(provider);
}

export async function startWorkspaceApp(app: string, tunnel?: TunnelProvider) {
  const root = findWorkspaceRoot(process.cwd());
  if (!root) throw new Error("--app selects an app in a Forge workspace.");
  const { ws } = loadWorkspace(root);
  if (!/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/.test(app) || !backendsOf(ws).includes(app))
    throw new Error(`Unknown Forge workspace app "${app}". Choose from ${backendsOf(ws).join(", ")}.`);
  if (tunnel && ws.portless === false)
    throw new Error("Enable Portless in the Forge workspace configuration to use --tunnel.");
  const directory = `apps/${app}`;
  const command = [process.execPath, "--no-env-file", "run", "turbo", "run", "dev", `--filter=./${directory}`];
  const env = tunnel ? localPortlessEnv() : { ...process.env };
  if (tunnel) {
    env[TUNNEL_SELECTION] = `${portlessName(root, app)}:${tunnel}`;
    // A custom strict-mode task can drop the selection. Diagnose it before starting
    // a workspace that would otherwise come up with only its local routes.
    const preview = Bun.spawnSync([...command, "--dry=json"], { cwd: root, env, stderr: "inherit" });
    if (preview.exitCode !== 0) return preview.exitCode;
    type EnvReport = { configured?: string[]; passthrough?: string[] | null };
    const plan = JSON.parse(preview.stdout.toString()) as {
      envMode: string;
      globalCacheInputs?: { environmentVariables?: EnvReport };
      tasks: { task: string; directory: string; command: string; environmentVariables?: EnvReport }[];
    };
    const task = plan.tasks.find((entry) => entry.task === "dev" && entry.directory.replaceAll("\\", "/") === directory);
    if (!task?.command) throw new Error(`No Turbo dev task found for ${directory}. Check that the app has a dev script.`);
    const reports = [plan.globalCacheInputs?.environmentVariables, task.environmentVariables];
    const passesSelection = reports.some((report) =>
      [...(report?.configured ?? []), ...(report?.passthrough ?? [])].some((entry) =>
        entry.startsWith(`${TUNNEL_SELECTION}=`),
      ),
    );
    if (plan.envMode !== "loose" && !passesSelection)
      throw new Error(`Turbo filters out Forge's tunnel selection for ${directory}. Add PORTLESS* to the dev task's passThroughEnv in turbo.json.`);
  }
  return runDevChild(command, root, env);
}

const PROFILE = ".env.development.local";
const loopback = (port: number) => `http://127.0.0.1:${port}`;
const appDir = (root: string, app: string) => join(root, "apps", app);
const rpcPort = (ws: Workspace, app: string) =>
  ws.apps[app]?.kind === "service" && ws.transport === "forge-rpc"
    ? (ws.apps[app]!.rpcPort ?? 4001)
    : undefined;
const profile = (root: string, app: string) => {
  const file = join(appDir(root, app), PROFILE);
  return existsSync(file) ? parseEnv(readFileSync(file, "utf8")) : {};
};

// Each service receives its own local secret. Atomically publish the seed since Turbo starts apps concurrently.
function workspaceSeed(root: string) {
  const dir = join(root, ".forge");
  const file = join(dir, "workspace-dev-key");
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const temp = join(dir, `workspace-dev-${randomBytes(12).toString("hex")}`);
    writeFileSync(temp, randomBytes(32), { mode: 0o600, flag: "wx" });
    try {
      linkSync(temp, file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    } finally {
      rmSync(temp, { force: true });
    }
  }
  return readFileSync(file);
}

export function transportPorts(ws: Workspace) {
  return ws.transport === "forge-rpc" || ws.transport === "tcp"
    ? servicesOf(ws).map(([, service]) => service.rpcPort ?? 4001)
    : [];
}

/** Update generated development addresses for legacy Nest transports, keeping custom targets. */
export function useNamedDashboard(
  ws: Workspace,
  origin: (app: string) => string,
) {
  const local = (app: string) => `http://localhost:${portOf(ws, app)}`;
  if (process.env.DASHBOARD_URL === local(ws.main))
    process.env.DASHBOARD_URL = origin(ws.main);
  if (process.env.MICROSERVICES) {
    const services = new Map(servicesOf(ws).map(([app]) => [local(app), app]));
    process.env.MICROSERVICES = process.env.MICROSERVICES.split(",")
      .map((entry) => {
        const [name, url] = entry.split("=", 2);
        const app = url && services.get(url);
        return app ? `${name}=${origin(app)}` : entry;
      })
      .join(",");
  }
}

export function workspaceDev(
  root: string,
  app: string,
  address?: { port: number; url: URL; tunnelUrl?: string },
  origin?: (app: string) => string,
) {
  const workspace = findWorkspaceRoot(root);
  if (!workspace || root !== appDir(workspace, app))
    throw new Error(
      "Run workspace development from an app in a Forge monorepo.",
    );
  const { ws } = loadWorkspace(workspace);
  if (process.env.FORGE_MOBILE_MAIN_PORT) {
    ws.mainPort = Number(process.env.FORGE_MOBILE_MAIN_PORT);
    validateWorkspace(ws);
  }
  if (ws.transport !== "forge-rpc" || !backendsOf(ws).includes(app))
    throw new Error(`${app} is not a Forge RPC workspace app.`);
  const deps = dependenciesOf(ws, app);
  const ownRpc = rpcPort(ws, app);
  const port = address?.port ?? portOf(ws, app);
  const http = origin ?? ((name: string) => loopback(portOf(ws, name)));
  const envFile = profile(workspace, app);
  // Bun and Turbo can both inherit a stack's .env. Keep the host tools, then explicitly load this app's development configuration.
  for (const key of Object.keys(process.env))
    if (
      !/^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|TMPDIR|TMP|TEMP|LANG|LC_\w+|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|VSCODE_PROXY_URI|NODE_EXTRA_CA_CERTS|FORCE_COLOR|NO_COLOR|CI)$/i.test(
        key,
      )
    )
      delete process.env[key];
  const dataDir = resolve(root, envFile.DATA_DIR || "forge/data");
  const dashboard = [
    ws.main,
    ...Object.keys(ws.apps).filter((name) => rpcPort(ws, name)),
  ];
  const seed =
    ownRpc || deps.length || dashboard.length > 1
      ? workspaceSeed(workspace)
      : undefined;
  // Keep the development network separate from any deployed credentials.
  const token = (scope: string) =>
    createHmac("sha256", seed!).update(scope).digest("hex");
  Object.assign(process.env, envFile, {
    NODE_ENV: "development",
    BUN_OPTIONS: "--no-env-file",
    ARCHLAST_WORKSPACE_DEV: "1",
    PORT: String(port),
    HOST: "127.0.0.1",
    ...(address && {
      PORTLESS_URL: address.url.origin,
      FORGE_DEV_URL: address.url.origin,
      ...(address.tunnelUrl && { FORGE_TUNNEL_URL: address.tunnelUrl }),
    }),
    DATA_DIR: dataDir,
    OTEL_SERVICE_NAME: app,
    ...(ownRpc && {
      [`${env(app)}_RPC_PORT`]: String(ownRpc),
      FORGE_RPC_TOKEN: token(`rpc:${app}`),
    }),
    ...(seed &&
      dashboard.includes(app) &&
      dashboard.length > 1 && { DASHBOARD_TOKEN: token("dashboard") }),
    ...(app === ws.main &&
      dashboard.length > 1 && {
        MICROSERVICES: dashboard
          .slice(1)
          .map((name) => `${name}=${http(name)}`)
          .join(","),
      }),
    ...(ownRpc && { DASHBOARD_URL: http(ws.main) }),
  });
  for (const dep of deps) {
    process.env[`${env(dep)}_RPC_URL`] = loopback(rpcPort(ws, dep)!);
    process.env[`${env(dep)}_RPC_TOKEN`] = token(`rpc:${dep}`);
  }
  return { ws, app, port, deps, ownRpc, dataDir };
}

async function available(port: number) {
  const connection = await Bun.connect({
    hostname: "127.0.0.1",
    port,
    socket: {
      data() {},
      open(socket) {
        socket.end();
      },
      error() {},
    },
  }).catch(() => undefined);
  return connection !== undefined;
}

export async function workspaceReady(
  ws: Workspace,
  app: string,
  origin = loopback(portOf(ws, app)),
) {
  const rpc = rpcPort(ws, app);
  const response = await fetch(`${origin}/ready`, {
    signal: AbortSignal.timeout(700),
  }).catch(() => undefined);
  const ready = (await response?.json().catch(() => undefined)) as
    { ready?: boolean } | undefined;
  return Boolean(
    response?.ok && ready?.ready === true && (!rpc || (await available(rpc))),
  );
}

export async function waitForWorkspaceApp(
  ws: Workspace,
  app: string,
  using: string,
  origin = loopback(portOf(ws, app)),
) {
  const deadline = Date.now() + 45_000;
  do {
    if (await workspaceReady(ws, app, origin)) return;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error(
    `${using} is waiting for ${app} on ${origin}. Check the app's logs or run bun run workspace status.`,
  );
}

export async function checkWorkspacePorts(port: number, rpc?: number) {
  for (const candidate of [port, rpc])
    if (candidate && (await available(candidate)))
      throw new Error(
        `Development port ${candidate} is occupied. Stop the process or change the workspace port.`,
      );
}

export async function workspaceAddresses(root: string, ws: Workspace) {
  const routes = ws.portless === false ? [] : await portlessRoutes();
  return new Map(
    backendsOf(ws).map((app) => {
      const name = portlessName(root, app);
      const route = routes.find((route) =>
        route.hostname.startsWith(`${name}.`),
      );
      const port = route?.port ?? portOf(ws, app);
      return [
        app,
        { url: route?.url ?? loopback(port), upstream: loopback(port) },
      ];
    }),
  );
}

export async function workspaceStatus(root: string, ws: Workspace) {
  const addresses = await workspaceAddresses(root, ws);
  await Promise.all(
    backendsOf(ws).map(async (app) => {
      const dir = appDir(root, app);
      const forge = join(dir, "forge");
      const rpc = rpcPort(ws, app);
      const file = profile(root, app);
      const database =
        file.FORGE_DEV_SERVICES?.split(",")
          .map((s) => s.trim())
          .includes("postgres") ||
        /^postgres(?:ql)?:/.test(file.DATABASE_URL ?? "")
          ? "Postgres"
          : /^mongodb(?:\+srv)?:/.test(file.DATABASE_URL ?? "")
            ? "MongoDB"
            : "SQLite";
      const generated = [
        join(forge, "_generated", "api.ts"),
        ...(rpc ? [join(forge, "_generated", "rpc.ts")] : []),
      ];
      const codegen = generated.every(existsSync)
        ? Array.from(
            new Bun.Glob("**/*.{ts,js}").scanSync({
              cwd: forge,
              onlyFiles: true,
            }),
          ).every(
            (path) =>
              /(^|\/)(?:_generated|node_modules|data)\//.test(path) ||
              statSync(join(forge, path)).mtimeMs <=
                Math.min(...generated.map((f) => statSync(f).mtimeMs)),
          )
          ? "present"
          : "possibly stale"
        : "missing";
      const deps = dependenciesOf(ws, app);
      const states = await Promise.all([
        workspaceReady(ws, app, addresses.get(app)!.upstream),
        ...deps.map((dep) =>
          workspaceReady(ws, dep, addresses.get(dep)!.upstream),
        ),
      ]);
      const waiting = deps.filter((_, i) => !states[i + 1]);
      console.log(
        `${app}  ${addresses.get(app)!.url}${rpc ? `  RPC ${loopback(rpc)}` : ""}  ${states[0] ? "ready" : "down"}  ${database} (${resolve(dir, file.DATA_DIR || "forge/data")})  codegen ${codegen}${waiting.length ? `  waiting on ${waiting.join(", ")}` : ""}`,
      );
    }),
  );
}
