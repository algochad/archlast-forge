import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { delimiter } from "node:path";

type RunOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  input?: string;
  timeout?: number;
  signal?: AbortSignal;
  inherit?: boolean;
};

export function hostEnvironment(): NodeJS.ProcessEnv {
  const allowed =
    /^(PATH|HOME|USER|LOGNAME|USERPROFILE|SHELL|TERM|TMPDIR|TMP|TEMP|LANG|LC_\w+|SYSTEMROOT|WINDIR|COMSPEC|PATHEXT|APPDATA|LOCALAPPDATA|DISPLAY|WAYLAND_DISPLAY|XDG_RUNTIME_DIR|DBUS_SESSION_BUS_ADDRESS|CI|NODE_EXTRA_CA_CERTS|HTTPS?_PROXY|NO_PROXY|ADB_SERVER_SOCKET|ANDROID_ADB_SERVER_PORT)$/i;
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => allowed.test(key)),
  );
}

export function withPath(env: NodeJS.ProcessEnv, ...paths: string[]) {
  // Use one PATH key on Windows, where environment names are case insensitive.
  const key =
    Object.keys(env).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
  return {
    ...env,
    [key]: [...paths, env[key]].filter(Boolean).join(delimiter),
  };
}

export function executable(name: string, env = process.env) {
  return Bun.which(name, {
    PATH: Object.entries(env).find(
      ([key]) => key.toUpperCase() === "PATH",
    )?.[1],
  });
}

export async function run(
  file: string,
  args: string[],
  options: RunOptions = {},
) {
  const signal = AbortSignal.any([
    AbortSignal.timeout(options.timeout ?? 15_000),
    ...(options.signal ? [options.signal] : []),
  ]);
  const proc = Bun.spawn([file, ...args], {
    cwd: options.cwd,
    env: options.env,
    signal,
    stdin:
      options.input !== undefined
        ? new TextEncoder().encode(options.input)
        : options.inherit
          ? "inherit"
          : "ignore",
    stdout: options.inherit ? "inherit" : "pipe",
    stderr: options.inherit ? "inherit" : "pipe",
    windowsHide: true,
  });
  const out =
    proc.stdout instanceof ReadableStream
      ? new Response(proc.stdout).text()
      : "";
  const err =
    proc.stderr instanceof ReadableStream
      ? new Response(proc.stderr).text()
      : "";
  const [stdout, stderr, code] = await Promise.all([out, err, proc.exited]);
  if (signal.aborted) throw new Error(`${file} was interrupted or timed out.`);
  return { code, out: stdout.trim(), err: stderr.trim() };
}

export async function requireCommand(
  file: string,
  args: string[],
  options?: RunOptions,
) {
  const result = await run(file, args, options);
  if (result.code !== 0)
    throw new Error(
      `${file} ${args[0] ?? ""} failed (exit ${result.code}). ${result.err || result.out || "See output above."}`,
    );
  return result.out;
}

export async function freePort(port = 0) {
  return new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once("error", () =>
      reject(
        new Error(
          `Cannot use local port ${port}. Stop the process using it or select another port.`,
        ),
      ),
    );
    server.listen(port, "127.0.0.1", () => {
      const selected = (server.address() as { port: number }).port;
      server.close((error) => (error ? reject(error) : resolve(selected)));
    });
  });
}

export function supervise() {
  const controller = new AbortController();
  const children = new Set<{
    pid: number;
    done: Promise<void>;
    exited: () => boolean;
  }>();
  let interrupted = false;
  function interrupt() {
    interrupted = true;
    controller.abort(new Error("Mobile development stopped."));
  }
  process.once("SIGINT", interrupt);
  process.once("SIGTERM", interrupt);
  const signal = controller.signal;
  function start(
    label: string,
    file: string,
    args: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ) {
    signal.throwIfAborted();
    const child = spawn(file, args, {
      cwd,
      env,
      stdio: ["ignore", "inherit", "inherit"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    const done = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        controller.abort(new Error(`${label}: ${error.message}`));
        resolve();
      });
      child.once("exit", (code, exitSignal) => {
        controller.abort(
          new Error(
            `${label} stopped (${exitSignal ?? `exit ${code}`}). See its output above.`,
          ),
        );
        resolve();
      });
    });
    if (child.pid)
      children.add({
        pid: child.pid,
        done,
        exited: () => child.exitCode !== null || child.signalCode !== null,
      });
  }
  async function stop() {
    try {
      await Promise.all(
        [...children].map(async (child) => {
          if (process.platform === "win32") {
            if (!child.exited())
              await run("taskkill", [
                "/PID",
                String(child.pid),
                "/T",
                "/F",
              ]).catch(() => {});
            return;
          }
          const send = (sig: NodeJS.Signals) => {
            try {
              process.kill(-child.pid, sig);
            } catch {
              /* the process group already stopped */
            }
          };
          send("SIGINT");
          await Promise.race([Bun.sleep(8000), child.done]);
          send("SIGKILL");
        }),
      );
    } finally {
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);
    }
  }
  return { signal, start, stop, interrupted: () => interrupted };
}

export type Supervisor = ReturnType<typeof supervise>;

export async function waitFor(
  label: string,
  timeout: number,
  signal: AbortSignal,
  check: () => Promise<boolean>,
) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    signal.throwIfAborted();
    if (await check()) return;
    await Bun.sleep(250);
  }
  signal.throwIfAborted();
  throw new Error(
    `Timed out waiting for ${label}. Check the output above or run archlast-forge mobile doctor.`,
  );
}
