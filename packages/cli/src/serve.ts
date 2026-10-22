import { startServer, type RunningServer } from "@archlast-forge/runtime/server";
import { watch } from "node:fs";
import { basename } from "node:path";
import { fail, loadDashboard } from "./common";

export interface ServeOptions {
  convexDir: string;
  dev: boolean;
  env: Record<string, string | undefined>;
  /** Watch this directory and call `onChange` with changed files (dev). */
  watchDir?: string;
  /** Prepares for a reload (codegen, installs); return false to skip it. */
  onChange?: (files: string[]) => Promise<boolean>;
}

/** Runs the server in this process: SIGTERM/SIGINT stop gracefully, SIGHUP reloads the function runtime. */
export async function serve(opts: ServeOptions): Promise<RunningServer> {
  const server = await startServer({ convexDir: opts.convexDir, dev: opts.dev, env: opts.env, dashboard: await loadDashboard() }).catch((e) => fail(e.message));
  let stopping = false;
  const stop = async (signal: string) => {
    if (stopping) process.exit(1); // second signal: don't wait
    stopping = true;
    console.log(`\n${signal}: draining connections…`);
    await server.stop();
    process.exit(0);
  };
  process.on("SIGTERM", () => void stop("SIGTERM"));
  process.on("SIGINT", () => void stop("SIGINT"));
  process.on("SIGHUP", () => void server.reload().then(() => console.log("✓ function runtime reloaded (SIGHUP)"), (e) => console.error(`✗ ${e.message}`)));

  if (opts.watchDir && opts.onChange) {
    const changed = new Set<string>();
    let timer: Timer | undefined;
    let running = Promise.resolve();
    const apply = async () => {
      const files = [...changed];
      changed.clear();
      try {
        if (!(await opts.onChange!(files))) return;
        await server.reload();
        console.log(`✓ function runtime restarted (${files.map((f) => basename(f)).slice(0, 3).join(", ")}${files.length > 3 ? ", …" : ""})`);
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
