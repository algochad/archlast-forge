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
  validateWorkspace,
  type Workspace,
} from "create-archlast-forge/workspace";

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

export function workspaceDev(root: string, app: string) {
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
  const port = portOf(ws, app);
  const envFile = profile(workspace, app);
  // Bun and Turbo can both inherit a stack's .env. Keep the host tools, then explicitly load this app's development configuration.
  for (const key of Object.keys(process.env))
    if (
      !/^(PATH|HOME|USER|LOGNAME|SHELL|TERM|COLORTERM|TMPDIR|TMP|TEMP|LANG|LC_\w+|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|VSCODE_PROXY_URI|FORCE_COLOR|NO_COLOR|CI)$/i.test(
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
          .map((name) => `${name}=${loopback(portOf(ws, name))}`)
          .join(","),
      }),
    ...(ownRpc && { DASHBOARD_URL: loopback(portOf(ws, ws.main)) }),
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

export async function workspaceReady(ws: Workspace, app: string) {
  const port = portOf(ws, app);
  const rpc = rpcPort(ws, app);
  const response = await fetch(`${loopback(port)}/ready`, {
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
) {
  const deadline = Date.now() + 45_000;
  do {
    if (await workspaceReady(ws, app)) return;
    await Bun.sleep(200);
  } while (Date.now() < deadline);
  throw new Error(
    `${using} is waiting for ${app} on ${loopback(portOf(ws, app))}. Check the app's logs or run bun run workspace status.`,
  );
}

export async function checkWorkspacePorts(port: number, rpc?: number) {
  for (const candidate of [port, rpc])
    if (candidate && (await available(candidate)))
      throw new Error(
        `Development port ${candidate} is occupied. Stop the process or change the workspace port.`,
      );
}

export async function workspaceStatus(root: string, ws: Workspace) {
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
        workspaceReady(ws, app),
        ...deps.map((dep) => workspaceReady(ws, dep)),
      ]);
      const waiting = deps.filter((_, i) => !states[i + 1]);
      console.log(
        `${app}  ${loopback(portOf(ws, app))}${rpc ? `  RPC ${loopback(rpc)}` : ""}  ${states[0] ? "ready" : "down"}  ${database} (${resolve(dir, file.DATA_DIR || "forge/data")})  codegen ${codegen}${waiting.length ? `  waiting on ${waiting.join(", ")}` : ""}`,
      );
    }),
  );
}
