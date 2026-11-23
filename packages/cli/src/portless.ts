import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  backendsOf,
  findWorkspaceRoot,
  loadWorkspace,
} from "create-archlast-forge/workspace";
import { runDevChild } from "./common";

const providers = {
  cloudflare: {
    flag: "--cloudflare",
    executable: "cloudflared",
    url: "PORTLESS_CLOUDFLARE_URL",
    install: "https://developers.cloudflare.com/tunnel/downloads/",
  },
  ngrok: {
    flag: "--ngrok",
    executable: "ngrok",
    url: "PORTLESS_NGROK_URL",
    install: "https://ngrok.com/download",
  },
  tailscale: {
    flag: "--funnel",
    executable: "tailscale",
    url: "PORTLESS_TAILSCALE_URL",
    install: "https://tailscale.com/download",
  },
} as const;

export type TunnelProvider = keyof typeof providers;

export function tunnelProvider(value: string): TunnelProvider {
  if (Object.hasOwn(providers, value)) return value as TunnelProvider;
  throw new Error(`Unknown tunnel provider "${value}". Use --tunnel cloudflare, --tunnel ngrok, or --tunnel tailscale.`);
}

/** An explicit Forge selection overrides any inherited Portless sharing settings. */
export function localPortlessEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PORTLESS_CLOUDFLARE: "0",
    PORTLESS_NGROK: "0",
    PORTLESS_TAILSCALE: "0",
    PORTLESS_FUNNEL: "0",
  };
  for (const { url } of Object.values(providers)) delete env[url];
  delete env.FORGE_TUNNEL_URL;
  return env;
}

export const RESERVED_PORT_EXIT = 75;

export function appWorkspace(root: string) {
  if (basename(dirname(root)) !== "apps") return;
  const workspace = findWorkspaceRoot(root);
  if (!workspace || dirname(dirname(root)) !== workspace) return;
  const { ws } = loadWorkspace(workspace);
  const app = basename(root);
  if (backendsOf(ws).includes(app)) return { root: workspace, ws, app };
}

function label(name: string) {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/** Different checkouts of the same project can use the same proxy concurrently. */
export function portlessName(root: string, app?: string) {
  const path = realpathSync(root);
  const project = basename(path);
  const readable =
    label(app ? `${project}-${app}` : project)
      .slice(0, 45)
      .replace(/-$/, "") || "forge";
  const id = createHash("sha256")
    .update(path)
    .update("\0")
    .update(app ?? "")
    .digest("hex")
    .slice(0, 12);
  return `${readable}-${id}`;
}

export function portlessAddress(tunnel?: TunnelProvider) {
  if (!process.env.PORTLESS_URL || process.env.PORTLESS === "0") return;
  const url = URL.parse(process.env.PORTLESS_URL);
  const port = Number(process.env.PORT);
  if (
    !url ||
    url.href !== `${url.origin}/` ||
    !["http:", "https:"].includes(url.protocol) ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65535
  )
    throw new Error(
      "Portless must supply an HTTP(S) origin in PORTLESS_URL and an upstream port in PORT.",
    );
  if (!tunnel) return { url, port };
  const publicUrl = URL.parse(process.env[providers[tunnel].url] ?? "");
  if (!publicUrl || publicUrl.protocol !== "https:" || publicUrl.href !== `${publicUrl.origin}/`)
    throw new Error(`Portless did not provide a public HTTPS URL for ${tunnel}. Start Forge directly with --tunnel ${tunnel} and check Portless's output.`);
  return { url, port, tunnelUrl: publicUrl.origin };
}

export function peerOrigin(url: URL, root: string, app: string, peer: string) {
  const prefix = `${portlessName(root, app)}.`;
  if (!url.hostname.startsWith(prefix))
    throw new Error(
      "Start workspace apps with Forge's dev script so Portless uses their workspace names.",
    );
  const target = new URL(url);
  target.hostname = `${portlessName(root, peer)}.${url.hostname.slice(prefix.length)}`;
  return target.origin;
}

function portlessCommand() {
  const node = Bun.which("node");
  if (!node) return;
  const bin = fileURLToPath(
    new URL("./cli.js", import.meta.resolve("portless")),
  );
  return [node, bin] as const;
}

export async function launchPortless(name: string, required: boolean, tunnel?: TunnelProvider) {
  const executable = portlessCommand();
  const version =
    executable && Bun.spawnSync([executable[0], "--version"]).stdout.toString();
  if (!executable || !version || Number(/^v(\d+)/.exec(version)?.[1] ?? 0) < 24) {
    if (tunnel)
      throw new Error("Public tunnels require Portless and Node.js 24 or later on PATH.");
    if (required)
      throw new Error("Portless development needs Node.js 24 or later on PATH. Set PORTLESS=0 for direct development.");
    console.warn("Using direct HTTP. Install Node.js 24 or later to use Portless.");
    return;
  }

  const provider = tunnel && providers[tunnel];
  if (provider && !Bun.which(provider.executable))
    throw new Error(`Install ${provider.executable} (${provider.install}) and put it on PATH to use --tunnel ${tunnel}.`);

  const env = { ...(provider ? localPortlessEnv() : process.env), PORTLESS_PREFIX: "" };
  const flags = provider ? [provider.flag] : [];
  const args = [process.execPath, Bun.argv[1]!, ...Bun.argv.slice(2)];
  // Portless runs wrapped commands through cmd.exe on Windows.
  const command =
    process.platform === "win32"
      ? args.map((arg) => `"${arg.replaceAll('"', '""')}"`)
      : args;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = await runDevChild([...executable, "run", "--name", name, ...flags, "--", ...command], process.cwd(), env);
    if (code !== RESERVED_PORT_EXIT) return code;
    if (process.env.PORTLESS_APP_PORT) break;
  }
  throw new Error(
    "Portless selected a reserved workspace transport port. Choose a different PORTLESS_APP_PORT or workspace RPC port.",
  );
}

export async function portlessRoutes() {
  const executable = portlessCommand();
  if (!executable || process.env.PORTLESS === "0") return [];
  const child = Bun.spawn([...executable, "list", "--json"], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const output = await new Response(child.stdout).text();
  if ((await child.exited) !== 0) return [];
  return JSON.parse(output).routes as {
    hostname: string;
    port: number;
    url: string;
  }[];
}

export async function appPortlessRoute(root: string) {
  const workspace = appWorkspace(root);
  if (workspace?.ws.portless === false) return;
  const name = workspace
    ? portlessName(workspace.root, workspace.app)
    : portlessName(root);
  return (await portlessRoutes()).find((route) =>
    route.hostname.startsWith(`${name}.`),
  );
}
