import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { freePort } from "../src/mobile/process";

const cli = join(import.meta.dir, "../src/index.ts");
const runtime = JSON.stringify(join(import.meta.dir, "../../runtime/src/index.ts"));
const packages = join(import.meta.dir, "../..");
const turbo = join(packages, "../node_modules/.bin/turbo");
const node = Bun.which("node");
const nodeVersion = node && Bun.spawnSync([node, "--version"]).stdout.toString();
const canRunPortless = process.platform !== "win32" && Number(/^v(\d+)/.exec(nodeVersion ?? "")?.[1] ?? 0) >= 24;
const cloudflareUrl = "https://forge-test.trycloudflare.com";
const ngrokUrl = "https://forge-test.ngrok-free.app";
const tailscaleUrl = "https://forge-test.example.ts.net:8443";

function put(root: string, file: string, text: string, mode?: number) {
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, { mode });
}

function app(root: string, name: string, inWorkspace = false) {
  put(
    root,
    "package.json",
    JSON.stringify({
      name,
      scripts: { dev: `${process.execPath} "${cli}" dev${inWorkspace ? " --workspace" : ""}`, "forge:seed": "bun probe.ts" },
    }),
  );
  put(root, "forge/schema.ts", `import { defineSchema } from ${runtime}; export default defineSchema({});`);
  put(
    root,
    "forge/http.ts",
    `
    import { httpRouter, httpAction } from ${runtime};
    const http = httpRouter();
    http.route({ path: "/address", method: "GET", handler: httpAction(() => Response.json({
      local: process.env.FORGE_DEV_URL, tunnel: process.env.FORGE_TUNNEL_URL, auth: process.env.BETTER_AUTH_URL,
    })) });
    export default http;
  `,
  );
  put(
    root,
    "probe.ts",
    `await Bun.write("probe.json", JSON.stringify({ local: process.env.FORGE_DEV_URL, tunnel: process.env.FORGE_TUNNEL_URL }));`,
  );
}

function fullStack(root: string) {
  put(root, "archlast-forge.json", JSON.stringify({ mode: "framework", services: [] }));
  put(root, "app/root.tsx", 'import { Outlet } from "@archlast/forge-framework"; export default function Root() { return <Outlet />; }');
  put(root, "app/routes/index.tsx", "export default function Index() { return <main>Workspace tunnel fixture</main>; }");
  const modules = join(root, "node_modules");
  mkdirSync(join(modules, "@archlast"), { recursive: true });
  for (const pkg of ["framework", "runtime", "client", "react"])
    symlinkSync(join(packages, pkg), join(modules, "@archlast", `forge-${pkg}`), "dir");
  for (const dep of ["react", "react-dom"])
    symlinkSync(realpathSync(join(packages, "framework/node_modules", dep)), join(modules, dep), "dir");
}

function run(command: string[], cwd: string, env: NodeJS.ProcessEnv) {
  const proc = Bun.spawn(command, { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let output = "";
  const read = async (stream: ReadableStream<Uint8Array>) => {
    const decoder = new TextDecoder();
    for await (const bytes of stream) output += decoder.decode(bytes, { stream: true });
    output += decoder.decode();
  };
  const done = Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]).then(([, , exit]) => exit);
  return {
    proc,
    done,
    output: () => output,
    async stop() {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGTERM");
      const exit = await Promise.race([done, Bun.sleep(5_000).then(() => null)]);
      if (exit === null) {
        proc.kill("SIGKILL");
        await done;
      }
      return exit;
    },
  };
}

async function until(check: () => boolean | Promise<boolean>, timeout = 12_000) {
  const deadline = Date.now() + timeout;
  do {
    if (await check()) return;
    await Bun.sleep(50);
  } while (Date.now() < deadline);
  throw new Error("Development fixture did not reach the expected state.");
}

test("dev validates provider names and rejects incompatible flags", async () => {
  const root = mkdtempSync(join(tmpdir(), "afx-tunnel-options-"));
  try {
    app(root, "single");
    const invoke = async (...args: string[]) => {
      const dev = run([process.execPath, cli, "dev", ...args], root, { ...process.env, PORTLESS: "0" });
      expect(await dev.done).toBe(1);
      return dev.output();
    };
    expect(await invoke("--tunnel", "other")).toContain("Use --tunnel cloudflare, --tunnel ngrok, or --tunnel tailscale");
    expect(await invoke("--tunnel", "ngrok", "--port", "3000")).toContain("--tunnel requires an app running through Portless");
    expect(await invoke("--tunnel", "tailscale", "--mobile")).toContain("--mobile cannot be combined");
    expect(await invoke("--app", "web")).toContain("--app selects an app in a Forge workspace");
    if (canRunPortless) {
      const bin = join(root, "bin");
      mkdirSync(bin);
      symlinkSync(node!, join(bin, "node"), "file");
      const missing = run([process.execPath, cli, "dev", "--tunnel", "tailscale"], root, { PATH: bin });
      expect(await missing.done).toBe(1);
      expect(missing.output()).toContain("Install tailscale");
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const [provider, publicUrl, inWorkspace] of [
  ["cloudflare", cloudflareUrl, true],
  ["ngrok", ngrokUrl, false],
  ["tailscale", tailscaleUrl, false],
] as const) {
  test.skipIf(!canRunPortless)(
    `dev publishes one ${provider} URL and cleans it up (${inWorkspace ? "Turbo workspace" : "standalone"})`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "afx-tunnel-dev-"));
      const web = inWorkspace ? join(root, "apps/web") : root;
      const peer = join(root, "apps/peer");
      const state = join(root, "portless");
      const log = join(root, "tunnel.log");
      const port = await freePort();
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: [join(root, "bin"), process.env.PATH].join(delimiter),
        PORTLESS: "1",
        PORTLESS_HTTPS: "0",
        PORTLESS_PORT: String(port),
        PORTLESS_STATE_DIR: state,
        PORTLESS_SYNC_HOSTS: "0",
        PORTLESS_TLD: "localhost",
        // A Forge selection overrides any other inherited sharing flags.
        PORTLESS_NGROK: provider === "ngrok" ? "0" : "1",
        PORTLESS_CLOUDFLARE: provider === "cloudflare" ? "0" : "1",
        PORTLESS_NGROK_URL: "https://stale.example",
        NO_COLOR: "1",
      };
      delete env.PORTLESS_URL;
      delete env.PORTLESS_APP_PORT;
      delete env.FORGE_MOBILE_MAIN_PORT;
      delete env.ARCHLAST_ENGINE;
      const portless = [node!, fileURLToPath(new URL("./cli.js", import.meta.resolve("portless")))];
      const processes: ReturnType<typeof run>[] = [];
      try {
        app(web, "web", inWorkspace);
        if (inWorkspace) {
          app(peer, "peer", true);
          put(
            root,
            "package.json",
            JSON.stringify({ name: "workspace", private: true, packageManager: "bun@1.4.4", workspaces: ["apps/*"] }),
          );
          put(
            root,
            "archlast-forge.workspace.json",
            JSON.stringify({ main: "web", transport: "forge-rpc", apps: { peer: { kind: "app", port: 3001 } } }),
          );
          put(
            root,
            "turbo.json",
            JSON.stringify({
              tasks: {
                dev: { cache: false, persistent: true },
                "web#dev": { with: ["peer#dev"], cache: false, persistent: true },
              },
            }),
          );
          expect(Bun.spawnSync([process.execPath, "install", "--lockfile-only", "--ignore-scripts"], { cwd: root }).exitCode).toBe(0);
          mkdirSync(join(root, "node_modules/.bin"), { recursive: true });
          symlinkSync(join(packages, "../node_modules/turbo"), join(root, "node_modules/turbo"), "dir");
          symlinkSync(turbo, join(root, "node_modules/.bin/turbo"), "file");
          fullStack(web);
          const turboConfig = JSON.parse(readFileSync(join(root, "turbo.json"), "utf8"));
          const portlessEnv = Object.keys(env).filter((name) => name === "PORTLESS" || name.startsWith("PORTLESS_"));
          for (const task of Object.values<Record<string, unknown>>(turboConfig.tasks)) task.passThroughEnv = portlessEnv;
          put(root, "turbo.json", JSON.stringify(turboConfig));
        }
        // Exercise Portless's provider lifecycle with local CLI stand-ins.
        const unauthenticated = join(root, "ngrok-needs-token");
        for (const [binary, ready, target] of [
          ["cloudflared", cloudflareUrl + "\nRegistered tunnel connection", 'Bun.argv[Bun.argv.indexOf("--url") + 1]'],
          ["ngrok", "started tunnel url=" + ngrokUrl, "Bun.argv.at(-1)"],
        ] as const) {
          put(
            root,
            `bin/${binary}`,
            `#!${process.execPath}
import { appendFileSync, existsSync } from "node:fs";
if (Bun.argv.includes("--version") || Bun.argv.includes("version")) { console.log("version 1"); process.exit(0); }
if (${binary === "ngrok"} && existsSync(${JSON.stringify(unauthenticated)})) { console.error("ERR_NGROK_4018"); process.exit(1); }
appendFileSync(${JSON.stringify(log)}, "start " + ${target} + "\\n");
const stop = () => { appendFileSync(${JSON.stringify(log)}, "stop\\n"); process.exit(0); };
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
console.log(${JSON.stringify(ready)});
setInterval(() => {}, 1000);
`,
            0o755,
          );
        }
        put(
          root,
          "bin/tailscale",
          `#!${process.execPath}
import { appendFileSync } from "node:fs";
switch (Bun.argv[2]) {
  case "version": console.log("1.80"); break;
  case "status": console.log(JSON.stringify({ Self: { DNSName: "forge-test.example.ts.net.", Capabilities: ["https", "funnel"] } })); break;
  case "serve": console.log(JSON.stringify({ Web: { "forge-test.example.ts.net:443": {} } })); break;
  case "funnel": {
    if (!Bun.argv.includes("--https=8443")) process.exit(1);
    const target = Bun.argv.at(-1);
    appendFileSync(${JSON.stringify(log)}, target === "off" ? "stop\\n" : "start " + target + "\\n");
    break;
  }
  default: process.exit(1);
}
`,
          0o755,
        );
        const proxy = run([...portless, "proxy", "start", "--foreground", "--no-tls", "--unprivileged"], root, env);
        processes.push(proxy);
        await until(() => existsSync(join(state, "proxy.port")));
        if (provider === "ngrok") {
          writeFileSync(unauthenticated, "");
          const ngrok = run([process.execPath, cli, "dev", "--no-docker", "--tunnel", "ngrok"], root, env);
          processes.push(ngrok);
          expect(await ngrok.done).toBe(1);
          expect(ngrok.output()).toContain("ngrok config add-authtoken");
          rmSync(unauthenticated);
        }

        const args = inWorkspace ? ["--app", "web"] : ["--no-docker", "--run", `"${process.execPath}" probe.ts`];
        const dev = run([process.execPath, cli, "dev", ...args, "--tunnel", provider], root, env);
        processes.push(dev);
        await until(() => existsSync(join(web, "probe.json")) && (!inWorkspace || existsSync(join(peer, "probe.json"))), 30_000);
        const boot = JSON.parse(readFileSync(join(web, "probe.json"), "utf8")) as { local: string; tunnel: string };
        expect(boot.local).toMatch(/\.localhost:\d+$/);
        expect(boot.tunnel).toBe(publicUrl);

        const logText = readFileSync(log, "utf8");
        const upstream = logText.match(/^start (http:\/\/127\.0\.0\.1:\d+)$/m)?.[1];
        expect(upstream).toBeTruthy();
        await until(
          async () => (await fetch(`${upstream}/ready`, { signal: AbortSignal.timeout(300) }).catch(() => undefined))?.ok === true,
        );
        expect(await (await fetch(`${upstream}/http/address`)).json()).toEqual({ local: boot.local, auth: boot.local, tunnel: publicUrl });
        if (!inWorkspace) {
          await until(() => dev.output().includes("Public tunnel"));
          expect(dev.output()).toContain("Public tunnel");
          expect(dev.output()).toContain(boot.local);
        }
        expect(logText.match(/^start /gm)).toHaveLength(1);

        if (inWorkspace) {
          expect(await (await fetch(`${upstream}/`)).text()).toContain("Workspace tunnel fixture");
          const sibling = JSON.parse(readFileSync(join(peer, "probe.json"), "utf8"));
          expect(sibling.local).toMatch(/\.localhost:\d+$/);
          expect(sibling.local).not.toBe(boot.local);
          expect(sibling.tunnel).toBeUndefined();
        }
        expect(await dev.stop()).not.toBeNull();
        await until(() => readFileSync(log, "utf8").includes("\nstop\n"));
        const routes = Bun.spawnSync([...portless, "list", "--json"], { cwd: root, env });
        expect(routes.exitCode).toBe(0);
        expect(JSON.parse(routes.stdout.toString()).routes).toEqual([]);
      } catch (error) {
        throw new Error(`${(error as Error).message}\n${processes.map((p) => p.output()).join("\n")}`, { cause: error });
      } finally {
        for (const child of processes.reverse()) await child.stop();
        rmSync(root, { recursive: true, force: true });
      }
    },
    55_000,
  );
}
