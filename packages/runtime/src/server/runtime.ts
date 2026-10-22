import type { Subprocess } from "bun";
import type { FunctionKind } from "../functions";
import type { CallHeaders, CallResult, ErrorKind, LogEntry } from "./executor";
import type { Manifest } from "./project";
import type { HostMessage, RuntimeMessage, SerializedRequest, SerializedResponse } from "./protocol";

const CHILD = new URL("./child.ts", import.meta.url).pathname;
/** Past a call's own timeout, how long to wait before presuming the process is stuck (e.g. a synchronous loop). */
const HARD_TIMEOUT_GRACE_MS = 5000;

export class RuntimeCallError extends Error {
  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly data?: unknown,
    readonly detail?: string,
  ) {
    super(message);
  }
}

type Omit2<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer?: Timer };

interface Options {
  convexDir: string;
  env: Record<string, string | undefined>;
  dev: boolean;
  workers?: number;
  serverId?: string;
  timeouts?: { functionMs: number; actionMs: number };
}

/** One function runtime process. */
class RuntimeProcess {
  proc?: Subprocess;
  private pending = new Map<number, Pending>();
  private seq = 0;

  constructor(
    private index: number,
    private opts: Options,
    private events: { onMessage(msg: RuntimeMessage): void; onCrash(index: number, code: number | null): void },
  ) {}

  start(): Promise<Manifest> {
    const ready = Promise.withResolvers<Manifest>();
    let fatal: string | undefined;
    const proc = Bun.spawn([process.execPath, CHILD], {
      cwd: process.cwd(),
      env: {
        ...this.opts.env,
        ARCHLAST_CONVEX_DIR: this.opts.convexDir,
        ARCHLAST_DEV: this.opts.dev ? "1" : "0",
        ARCHLAST_WORKER: String(this.index),
        ARCHLAST_SERVER_ID: this.opts.serverId ?? "local",
      },
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "advanced",
      ipc: (msg: RuntimeMessage) => {
        if (msg.t === "ready") return ready.resolve(msg.manifest);
        if (msg.t === "fatal") return ready.reject(new Error((fatal = msg.error)));
        if (msg.t === "result") {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          clearTimeout(p?.timer);
          if (msg.ok) p?.resolve(msg.value);
          else p?.reject(new RuntimeCallError(msg.error.message, msg.error.kind, msg.error.data, msg.error.stack));
          return;
        }
        this.events.onMessage(msg);
      },
      onExit: (_p, code) => {
        if (this.proc !== proc) return;
        this.proc = undefined;
        this.failPending(`Function runtime exited (code ${code})`);
        ready.reject(new Error(fatal ?? `Function runtime exited (code ${code})`));
        this.events.onCrash(this.index, code);
      },
    });
    this.proc = proc;
    return ready.promise;
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

  /** Kills the process outright; used when a call blows past its hard deadline. */
  kill() {
    const proc = this.proc;
    this.proc = undefined;
    proc?.kill(9);
    this.failPending("Function runtime was restarted because a call didn't finish in time");
  }

  request(msg: Omit2<HostMessage, "id">, hardTimeoutMs: number, onHang: () => void): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new RuntimeCallError("Function runtime is not running", "internal"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeCallError(`Timed out after ${hardTimeoutMs} ms`, "timeout"));
        onHang();
      }, hardTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      proc.send({ ...msg, id });
    });
  }

  private failPending(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RuntimeCallError(message, "internal"));
    }
    this.pending.clear();
  }
}

/** Server-side handle on the function runtime processes. */
export class FunctionRuntime {
  manifest?: Manifest;
  loadError?: string;
  onPublish: (topics: string[]) => void = () => {};
  onLog: (entry: LogEntry) => void = () => {};

  private workers: RuntimeProcess[] = [];
  private starting?: Promise<Manifest>;
  private next = 0;
  private stopping = false;

  constructor(private opts: Options) {}

  private spawn(index: number) {
    return new RuntimeProcess(index, this.opts, {
      onMessage: (msg) => {
        if (msg.t === "publish") this.onPublish(msg.topics);
        else if (msg.t === "log") this.onLog(msg.entry);
      },
      // A crash outside a restart (e.g. out of memory) brings that process back, so one bad call doesn't take the server down.
      onCrash: (i, code) => {
        if (this.stopping || this.starting || !this.manifest) return;
        console.error(`function runtime ${i} exited (code ${code}); restarting it`);
        void this.respawn(i);
      },
    });
  }

  private async respawn(index: number) {
    const w = this.spawn(index);
    this.workers[index] = w;
    await w.start().catch((e) => console.error(`function runtime ${index} failed to restart: ${e.message}`));
  }

  start(): Promise<Manifest> {
    this.stopping = false;
    const count = this.opts.workers ?? 1;
    this.workers = Array.from({ length: count }, (_, i) => this.spawn(i));
    // The first process migrates and checks the schema; the rest start once it's ready.
    this.starting = this.workers[0]!.start().then(
      async (m) => {
        await Promise.all(this.workers.slice(1).map((w) => w.start()));
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
    this.stopping = true;
    await Promise.all(this.workers.map((w) => w.stop()));
  }

  async restart() {
    await this.stop();
    return this.start();
  }

  private async pick(index?: number) {
    if (this.starting) await this.starting.catch(() => {});
    if (!this.manifest || this.loadError) throw new RuntimeCallError(this.loadError ?? "Function runtime is not running", "internal");
    const live = this.workers.filter((w) => w.proc);
    if (!live.length) throw new RuntimeCallError("Function runtime is restarting", "internal");
    return index === undefined ? live[this.next++ % live.length]! : (this.workers[index] ?? live[0]!);
  }

  private async send(msg: Omit2<HostMessage, "id">, hardTimeoutMs: number, index?: number) {
    const w = await this.pick(index);
    return w.request(msg, hardTimeoutMs, () => {
      const i = this.workers.indexOf(w);
      console.error(`function runtime ${i} didn't answer within ${hardTimeoutMs} ms; killing and restarting it`);
      w.kill();
      void this.respawn(i);
    });
  }

  call(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders, opts: { allowInternal?: boolean; requestId?: string } = {}) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    return this.send({ t: "call", name, kind, args, headers, ...opts }, (kind === "action" ? t.actionMs : t.functionMs) + HARD_TIMEOUT_GRACE_MS) as Promise<CallResult>;
  }

  auth(req: SerializedRequest) {
    return this.send({ t: "auth", req }, 30_000) as Promise<SerializedResponse>;
  }

  admin<T = unknown>(op: string, args: Record<string, unknown>, actor: string) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    const timeout = op === "run" ? t.actionMs + HARD_TIMEOUT_GRACE_MS : 60_000;
    return this.send({ t: "admin", op, args, actor }, timeout) as Promise<T>;
  }
}
