import type { Subprocess } from "bun";
import type { FunctionKind, UserIdentity } from "../functions";
import { serializeError, type CallHeaders, type CallResult, type ErrorKind, type LogEntry } from "./executor";
import type { Manifest } from "./project";
import type { Batch, HostMessage, RuntimeMessage, SerializedRequest, SerializedResponse } from "./protocol";
import { startCore, type RuntimeCore } from "./runtime-core";

// Next to this module: child.ts in the repo, child.js in the published build.
const CHILD = new URL(import.meta.url.endsWith(".ts") ? "./child.ts" : "./child.js", import.meta.url).pathname;
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
  forgeDir: string;
  env: Record<string, string | undefined>;
  dev: boolean;
  workers?: number;
  serverId?: string;
  timeouts?: { functionMs: number; actionMs: number };
  /** Calls one process may have waiting; more are refused (see ErrorKind "overloaded"). */
  maxPending?: number;
  /** Run the core in this process instead of a child (RUNTIME_MODE=inline). */
  inline?: boolean;
}

/** What FunctionRuntime needs from a function runtime, in a child process or in this one. */
interface Worker {
  proc?: unknown;
  ready: boolean;
  started?: Promise<Manifest>;
  start(): Promise<Manifest>;
  stop(): Promise<void>;
  kill(): void;
  request(msg: Omit2<HostMessage, "id">, hardTimeoutMs: number, onHang: () => void): Promise<unknown>;
}

/**
 * The core in this process: no IPC, no second process, no context switch per call, which on one core is most of what a write or a cache
 * miss costs besides its own work. The price: a function that never yields blocks the server too. A watchdog thread then kills the whole
 * process (after the call's timeout plus the grace), so a supervisor (Docker's restart policy, systemd) can start it again.
 */
class InlineWorker implements Worker {
  proc?: RuntimeCore;
  ready = false;
  started?: Promise<Manifest>;
  private inFlight = 0;
  private watchdog?: globalThis.Worker;
  private beat?: Timer;

  constructor(
    private opts: Options,
    private events: { onMessage(msg: RuntimeMessage): void },
  ) {}

  start(): Promise<Manifest> {
    this.started = startCore({ forgeDir: this.opts.forgeDir, env: this.opts.env, worker: 0, serverId: this.opts.serverId ?? "local", dev: this.opts.dev, send: (m) => this.events.onMessage(m) }).then((core) => {
      this.proc = core;
      this.ready = true;
      this.watch();
      return core.manifest;
    });
    return this.started;
  }

  private watch() {
    const limit = (this.opts.timeouts?.functionMs ?? 10_000) + HARD_TIMEOUT_GRACE_MS;
    const code = `let last = Date.now();
      self.onmessage = () => (last = Date.now());
      setInterval(() => {
        if (Date.now() - last < ${limit}) return;
        console.error("The server's event loop has been blocked for over ${limit} ms (a function that never yields?); exiting so it can be restarted");
        process.kill(process.pid, "SIGKILL");
      }, 1000);`;
    this.watchdog = new globalThis.Worker(URL.createObjectURL(new Blob([code], { type: "application/javascript" })));
    (this.watchdog as unknown as { unref(): void }).unref(); // never keeps the process alive by itself
    this.beat = setInterval(() => this.watchdog?.postMessage(0), 1000);
    this.beat.unref();
  }

  async stop() {
    const core = this.proc;
    this.proc = undefined;
    this.ready = false;
    clearInterval(this.beat);
    this.watchdog?.terminate();
    await core?.shutdown();
  }

  /** Nothing to kill: the work runs on this thread (the watchdog handles a blocked one). */
  kill() {}

  async request(msg: Omit2<HostMessage, "id">) {
    const core = this.proc;
    if (!core) throw new RuntimeCallError("Function runtime is not running", "internal");
    if (this.inFlight >= (this.opts.maxPending ?? 1000)) throw new RuntimeCallError("Server is busy, try again", "overloaded");
    this.inFlight++;
    try {
      return await core.handle({ ...msg, id: 0 } as HostMessage);
    } catch (e) {
      const err = serializeError(e);
      throw new RuntimeCallError(err.message, err.kind, err.data, err.stack);
    } finally {
      this.inFlight--;
    }
  }
}

/** One function runtime process. */
class RuntimeProcess implements Worker {
  proc?: Subprocess;
  /** Messages sent before the process reports ready would be lost, so it only gets work after that. */
  ready = false;
  started?: Promise<Manifest>;
  private pending = new Map<number, Pending>();
  private seq = 0;
  /** When the process last answered anything: a call that waits past its deadline in a process that is still answering is queued, not stuck. */
  private lastResultAt = Date.now();

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
        ARCHLAST_FORGE_DIR: this.opts.forgeDir,
        ARCHLAST_DEV: this.opts.dev ? "1" : "0",
        ARCHLAST_WORKER: String(this.index),
        ARCHLAST_SERVER_ID: this.opts.serverId ?? "local",
      },
      stdio: ["ignore", "inherit", "inherit"],
      serialization: "advanced",
      ipc: (envelope: RuntimeMessage | Batch<RuntimeMessage>) => {
        if (envelope.t === "batch") for (const msg of envelope.messages) this.onMessage(msg, ready, (e) => (fatal = e));
        else this.onMessage(envelope, ready, (e) => (fatal = e));
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
    this.ready = false;
    this.started = ready.promise;
    return ready.promise;
  }

  private onMessage(msg: RuntimeMessage, ready: PromiseWithResolvers<Manifest>, setFatal: (error: string) => void) {
    if (msg.t === "ready") {
      this.ready = true;
      return ready.resolve(msg.manifest);
    }
    if (msg.t === "fatal") {
      setFatal(msg.error);
      return ready.reject(new Error(msg.error));
    }
    if (msg.t === "result") {
      this.lastResultAt = Date.now();
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p?.timer);
      if (msg.ok) p?.resolve(msg.value);
      else p?.reject(new RuntimeCallError(msg.error.message, msg.error.kind, msg.error.data, msg.error.stack));
      return;
    }
    this.events.onMessage(msg);
  }

  /** One IPC write per turn of the event loop instead of one per call. */
  private outbox: HostMessage[] = [];
  private enqueue(proc: Subprocess, msg: HostMessage) {
    if (this.outbox.push(msg) === 1) setImmediate(() => this.flush(proc));
  }
  private flush(proc: Subprocess) {
    const messages = this.outbox.splice(0);
    if (!messages.length || this.proc !== proc) return; // restarted meanwhile: these calls were failed with it
    proc.send(messages.length === 1 ? messages[0]! : ({ t: "batch", messages } satisfies Batch<HostMessage>));
  }

  async stop() {
    const proc = this.proc;
    this.proc = undefined;
    this.ready = false;
    this.outbox = [];
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
    this.ready = false;
    this.outbox = [];
    proc?.kill(9);
    this.failPending("Function runtime was restarted because a call didn't finish in time");
  }

  request(msg: Omit2<HostMessage, "id">, hardTimeoutMs: number, onHang: () => void): Promise<unknown> {
    const proc = this.proc;
    if (!proc) return Promise.reject(new RuntimeCallError("Function runtime is not running", "internal"));
    if (this.pending.size >= (this.opts.maxPending ?? 1000)) return Promise.reject(new RuntimeCallError("Server is busy, try again", "overloaded"));
    const id = ++this.seq;
    const sentAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new RuntimeCallError(`Timed out after ${hardTimeoutMs} ms`, "timeout"));
        // Restart only a process that has answered nothing since this call went in (a synchronous loop). One that is merely behind keeps its other calls.
        if (this.lastResultAt < sentAt) onHang();
      }, hardTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.enqueue(proc, { ...msg, id } as HostMessage);
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

  private workers: Worker[] = [];
  private starting?: Promise<Manifest>;
  private next = 0;
  private stopping = false;

  constructor(private opts: Options) {}

  private spawn(index: number): Worker {
    if (this.opts.inline) return new InlineWorker(this.opts, { onMessage: (msg) => (msg.t === "publish" ? this.onPublish(msg.topics) : msg.t === "log" ? this.onLog(msg.entry) : undefined) });
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
    const count = this.opts.inline ? 1 : (this.opts.workers ?? 1);
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
    let live = this.workers.filter((w) => w.proc && w.ready);
    if (!live.length) {
      // Every process is restarting (e.g. after a hung call was killed): wait for the first to come back.
      await Promise.race([Promise.any(this.workers.map((w) => w.started ?? Promise.reject())).catch(() => {}), Bun.sleep(30_000)]);
      live = this.workers.filter((w) => w.proc && w.ready);
      if (!live.length) throw new RuntimeCallError("Function runtime is restarting", "internal");
    }
    const wanted = index === undefined ? undefined : this.workers[index];
    return wanted?.ready ? wanted : live[this.next++ % live.length]!;
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

  call(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders, opts: { allowInternal?: boolean; requestId?: string; identity?: UserIdentity | null } = {}) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    return this.send({ t: "call", name, kind, args, headers, ...opts }, (kind === "action" ? t.actionMs : t.functionMs) + HARD_TIMEOUT_GRACE_MS) as Promise<CallResult>;
  }

  /** Resolves the caller from request headers; null when anonymous. */
  identity(headers: CallHeaders) {
    return this.send({ t: "identity", headers }, 30_000) as Promise<UserIdentity | null>;
  }

  auth(req: SerializedRequest) {
    return this.send({ t: "auth", req }, 30_000) as Promise<SerializedResponse>;
  }

  admin<T = unknown>(op: string, args: Record<string, unknown>, actor: string) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    const timeout = op === "run" || op === "cli" ? t.actionMs + HARD_TIMEOUT_GRACE_MS : 60_000;
    return this.send({ t: "admin", op, args, actor }, timeout) as Promise<T>;
  }
}
