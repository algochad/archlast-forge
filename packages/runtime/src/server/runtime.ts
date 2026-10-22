import type { Subprocess } from "bun";
import type { FunctionKind } from "../functions";
import type { CallHeaders, CallResult, LogEntry } from "./executor";
import type { Manifest } from "./project";
import type { HostMessage, RuntimeError, RuntimeMessage, SerializedRequest, SerializedResponse } from "./protocol";

const CHILD = new URL("./child.ts", import.meta.url).pathname;

export class RuntimeCallError extends Error {
  constructor(
    message: string,
    readonly code: RuntimeError["code"],
  ) {
    super(message);
  }
}

type Omit2<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;

/** Server-side handle on the function runtime process. */
export class FunctionRuntime {
  manifest?: Manifest;
  loadError?: string;
  onPublish: (topics: string[]) => void = () => {};
  onLog: (entry: LogEntry) => void = () => {};

  private proc?: Subprocess;
  private starting?: Promise<Manifest>;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private seq = 0;

  constructor(private opts: { convexDir: string; env: Record<string, string | undefined>; dev: boolean }) {}

  start(): Promise<Manifest> {
    const ready = Promise.withResolvers<Manifest>();
    const proc = Bun.spawn([process.execPath, CHILD], {
      cwd: process.cwd(),
      env: { ...this.opts.env, ARCHLAST_CONVEX_DIR: this.opts.convexDir, ARCHLAST_DEV: this.opts.dev ? "1" : "0" },
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "advanced",
      ipc: (msg: RuntimeMessage) => this.onMessage(msg, ready),
      onExit: (_p, code) => {
        if (this.proc !== proc) return;
        this.proc = undefined;
        this.failPending(`Function runtime exited (code ${code})`);
        ready.reject(new Error(this.loadError ?? `Function runtime exited (code ${code})`));
      },
    });
    this.proc = proc;
    this.starting = ready.promise.then(
      (m) => {
        this.loadError = undefined;
        return (this.manifest = m);
      },
      (e) => {
        this.loadError = e.message;
        throw e;
      },
    );
    this.starting.catch(() => {}).finally(() => (this.starting = undefined));
    return this.starting;
  }

  async stop() {
    const proc = this.proc;
    this.proc = undefined;
    this.failPending("Function runtime restarted");
    if (!proc) return;
    proc.send({ t: "shutdown" });
    await Promise.race([proc.exited, Bun.sleep(3000)]);
    proc.kill();
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  call(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders) {
    return this.request({ t: "call", name, kind, args, headers }) as Promise<CallResult>;
  }

  auth(req: SerializedRequest) {
    return this.request({ t: "auth", req }) as Promise<SerializedResponse>;
  }

  async request(msg: Omit2<HostMessage, "id">): Promise<unknown> {
    if (this.starting) await this.starting.catch(() => {});
    const proc = this.proc;
    if (!proc || !this.manifest) throw new RuntimeCallError(this.loadError ?? "Function runtime is not running", "INTERNAL_SERVER_ERROR");
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      proc.send({ ...msg, id });
    });
  }

  private onMessage(msg: RuntimeMessage, ready: PromiseWithResolvers<Manifest>) {
    switch (msg.t) {
      case "ready":
        return ready.resolve(msg.manifest);
      case "fatal":
        this.loadError = msg.error;
        return ready.reject(new Error(msg.error));
      case "publish":
        return this.onPublish(msg.topics);
      case "log":
        return this.onLog(msg.entry);
      case "result": {
        const p = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.ok) p?.resolve(msg.value);
        else p?.reject(new RuntimeCallError(msg.error.message, msg.error.code));
      }
    }
  }

  private failPending(message: string) {
    for (const p of this.pending.values()) p.reject(new RuntimeCallError(message, "INTERNAL_SERVER_ERROR"));
    this.pending.clear();
  }
}
