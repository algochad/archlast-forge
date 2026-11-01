import { startServer, type AppHost, type RunningServer } from "@archlast/forge-runtime/server";
import { watch } from "node:fs";
import { basename } from "node:path";
import { fail, loadDashboard } from "./common";

export interface ServeOptions {
  forgeDir: string;
  dev: boolean;
  env: Record<string, string | undefined>;
  /** Watch this directory and call `onChange` with changed files (dev). */
  watchDir?: string;
  /** Prepares for a reload (codegen, installs); return false to skip it. */
  onChange?: (files: string[]) => Promise<boolean>;
  /** A frontend served next to the API (framework mode). */
  app?: AppHost;
}

/**
 * Runs the server in this process: SIGTERM/SIGINT stop gracefully, SIGHUP reloads the function runtime. The dashboard's Restart (to apply
 * saved settings) stops it and starts it again here; the object returned follows whichever server is current.
 */
export async function serve(opts: ServeOptions): Promise<RunningServer> {
  const dashboard = await loadDashboard();
  let current: RunningServer;
  let restarting: Promise<void> | undefined;
  const start = () => startServer({ forgeDir: opts.forgeDir, dev: opts.dev, env: opts.env, dashboard, app: opts.app, restart });
  async function restart() {
    if (restarting) return restarting;
    restarting = (async () => {
      console.log("↻ restarting to apply the saved settings…");
      await current.stop({ keepApp: true });
      try {
        current = await start();
        console.log(`✓ restarted on ${current.url}`);
      } catch (e) {
        // The settings it was asked to apply don't work: say so and exit, as a failed start would.
        fail(`restart failed: ${(e as Error).message}`);
      }
    })().finally(() => (restarting = undefined));
    return restarting;
  }
  current = await start().catch((e) => fail(e.message));
  const server: RunningServer = {
    get url() {
      return current.url;
    },
    get config() {
      return current.config;
    },
    get runtime() {
      return current.runtime;
    },
    reload: () => current.reload(),
    stop: (o) => current.stop(o),
  };
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) process.exit(1); // second signal: don't wait
    stopping = true;
    console.log(`\n${signal}: draining connections…`);
    await restarting?.catch(() => {});
    await current.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on(
    "SIGHUP",
    () =>
      void current.reload().then(
        () => console.log("✓ function runtime reloaded (SIGHUP)"),
        (e) => console.error(`✗ ${e.message}`),
      ),
  );

  if (opts.watchDir && opts.onChange) {
    const changed = new Set<string>();
    let timer: Timer | undefined;
    let running = Promise.resolve();
    const apply = async () => {
      const files = [...changed];
      changed.clear();
      try {
        if (!(await opts.onChange!(files))) return;
        await current.reload();
        console.log(
          `✓ function runtime restarted (${files
            .map((f) => basename(f))
            .slice(0, 3)
            .join(", ")}${files.length > 3 ? ", …" : ""})`,
        );
      } catch (e) {
        console.error(`✗ ${(e as Error).message}`);
      }
    };
    watch(opts.watchDir, { recursive: true }, (_event, file) => {
      if (!file || /(^|\/)(node_modules|\.|data\/)/.test(file)) return;
      if (!/\.(ts|js)$/.test(file) && !["package.json", "bun.lock"].includes(basename(file))) return;
      changed.add(file);
      clearTimeout(timer);
      timer = setTimeout(() => (running = running.then(apply)), 150);
    });
  }
  return server;
}
