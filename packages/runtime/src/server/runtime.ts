import type { Subprocess } from "bun";
import type { FunctionKind, UserIdentity } from "../functions";
import { serializeError, type CallHeaders, type CallResult, type ErrorKind, type IdentityDetail, type LogEntry, type SerializedError } from "./executor";
import type { Manifest } from "./project";
import type { Batch, HostEvent, HostMessage, HttpRequestMessage, HttpResponseMessage, RuntimeMessage, SerializedRequest, SerializedResponse, SocketMessage } from "./protocol";
import { startCore, type RuntimeCore } from "./runtime-core";
import { fromWire } from "./wire";
import type { CallTelemetry, TraceParent } from "./telemetry/context";
import type { MetricPoint, RuntimeSample, TraceRecord } from "./telemetry/types";

// Next to this module: child.ts in the repo, child.js in the published build.
const CHILD = new URL(import.meta.url.endsWith(".ts") ? "./child.ts" : "./child.js", import.meta.url).pathname;
/** Past a call's own timeout, how long to wait before presuming the process is stuck (e.g. a synchronous loop). */
const HARD_TIMEOUT_GRACE_MS = 5000;

export class RuntimeCallError extends Error {
  /** The class of what was thrown in the function (TypeError, ForgeError). */
  type?: string;
  /** What the call recorded before it failed, when it was traced. */
  telemetry?: CallTelemetry;

  constructor(
    message: string,
    readonly kind: ErrorKind,
    readonly data?: unknown,
    readonly detail?: string,
  ) {
    super(message);
  }

  static from(e: SerializedError) {
    return Object.assign(new RuntimeCallError(e.message, e.kind, e.data, e.stack), { type: e.type, telemetry: e.telemetry });
  }
}

type Omit2<T, K extends keyof any> = T extends unknown ? Omit<T, K> : never;
type Pending = { resolve(v: unknown): void; reject(e: Error): void; timer?: Timer; /** A query: short, so it counts toward the backlog the process is expected to clear. */ short?: boolean };

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
  /** Calls waiting on this process or running in it. */
  readonly load: number;
  /** Queries waiting, and about how long they would take to clear (0 when there is no recent pace to go by). */
  readonly backlog: { waiting: number; waitMs: number };
  started?: Promise<Manifest>;
  start(): Promise<Manifest>;
  stop(): Promise<void>;
  kill(): void;
  request(msg: Omit2<HostMessage, "id">, hardTimeoutMs: number, onHang: () => void): Promise<unknown>;
  /** A socket event, which needs no answer. */
  event(msg: HostEvent): void;
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
  get load() {
    return this.inFlight;
  }
  get backlog() {
    return { waiting: this.inFlight, waitMs: 0 };
  }
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

  event(msg: HostEvent) {
    this.proc?.event(msg);
  }

  async request(msg: Omit2<HostMessage, "id">) {
    const core = this.proc;
    if (!core) throw new RuntimeCallError("Function runtime is not running", "internal");
    if (this.inFlight >= (this.opts.maxPending ?? 1000)) throw new RuntimeCallError("Server is busy, try again", "overloaded");
    this.inFlight++;
    try {
      return await core.handle({ ...msg, id: 0 } as HostMessage);
    } catch (e) {
      throw RuntimeCallError.from(serializeError(e));
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
  get load() {
    return this.pending.size;
  }
  get backlog() {
    return { waiting: this.shortPending, waitMs: this.gapMs && performance.now() - this.gapAt < 3000 ? this.shortPending * this.gapMs : 0 };
  }
  private seq = 0;
  /** Queries sent and not yet answered. */
  private shortPending = 0;
  /**
   * How long the process takes per queued call under sustained load: the average time between answers over a window (batched answers arrive
   * together, so single gaps mean nothing). Not trusted until a window has five answers, and not once it is stale, so a burst after quiet is let in.
   */
  private gapMs = 0;
  private gapAt = 0;
  private window = { start: 0, answers: 0 };
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
      if (p?.short) {
        const now = performance.now();
        const w = this.window;
        if (!w.start) (w.start = now, (w.answers = 0));
        else if (++w.answers >= 5) (this.gapMs = (now - w.start) / w.answers, (this.gapAt = now));
        if (now - w.start > 2000) this.window = { start: now, answers: 0 };
        if (--this.shortPending === 0) this.window = { start: 0, answers: 0 }; // quiet: the next burst starts a new window
      }
      if (!msg.ok) p?.reject(RuntimeCallError.from(msg.error));
      else if ((msg.value as HttpResponseMessage | undefined)?.stream) {
        // Its bytes follow as chunk messages with the same id.
        const body = new ReadableStream<Uint8Array>({
          start: (c) => void this.streams.set(msg.id, c),
          cancel: () => (this.streams.delete(msg.id), this.event({ t: "cancel", id: msg.id })), // the client left: the handler hears it in the child
        });
        p?.resolve({ ...(msg.value as HttpResponseMessage), body });
      } else p?.resolve(fromWire(msg.value));
      return;
    }
    if (msg.t === "chunk") {
      const stream = this.streams.get(msg.id);
      if (!stream) return; // the client went away
      if (msg.data) stream.enqueue(new Uint8Array(msg.data));
      if (msg.end || msg.error) this.streams.delete(msg.id);
      if (msg.end) stream.close();
      if (msg.error) stream.error(new Error(msg.error));
      return;
    }
    this.events.onMessage(msg);
  }

  /** Streamed response bodies whose bytes are still arriving, by call id. */
  private streams = new Map<number, ReadableStreamDefaultController<Uint8Array>>();

  /** One IPC write per turn of the event loop instead of one per call. */
  private outbox: (HostMessage | HostEvent)[] = [];
  private enqueue(proc: Subprocess, msg: HostMessage | HostEvent) {
    if (this.outbox.push(msg) === 1) setImmediate(() => this.flush(proc));
  }
  private flush(proc: Subprocess) {
    const messages = this.outbox.splice(0);
    if (!messages.length || this.proc !== proc) return; // restarted meanwhile: these calls were failed with it
    proc.send(messages.length === 1 ? messages[0]! : ({ t: "batch", messages } satisfies Batch<HostMessage | HostEvent>));
  }

  event(msg: HostEvent) {
    if (this.proc) this.enqueue(this.proc, msg);
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
    const short = (msg.t === "call" && msg.kind === "query") || msg.t === "identity";
    // A call that would wait longer than a function may run is going to time out; saying so now frees its caller, and the process, for calls that can still finish.
    if (short && this.gapMs && performance.now() - this.gapAt < 3000 && this.shortPending * this.gapMs > (this.opts.timeouts?.functionMs ?? 10_000)) return Promise.reject(new RuntimeCallError("Server is busy, try again", "overloaded"));
    const id = ++this.seq;
    const sentAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const p = this.pending.get(id);
        this.pending.delete(id);
        if (p?.short) this.shortPending--;
        reject(new RuntimeCallError(`Timed out after ${hardTimeoutMs} ms`, "timeout"));
        // Restart only a process that has answered nothing since this call went in (a synchronous loop). One that is merely behind keeps its other calls.
        if (this.lastResultAt < sentAt) onHang();
      }, hardTimeoutMs);
      this.pending.set(id, { resolve, reject, timer, short });
      if (short) this.shortPending++;
      // A queued query that hasn't started within a function's time limit would time out anyway: the process refuses it then, not the hard timeout later.
      this.enqueue(proc, { ...msg, id, ...(short && { deadline: sentAt + (this.opts.timeouts?.functionMs ?? 10_000) }) } as HostMessage);
    });
  }

  private failPending(message: string) {
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new RuntimeCallError(message, "internal"));
    }
    this.pending.clear();
    this.shortPending = 0;
    this.gapMs = 0;
    this.window = { start: 0, answers: 0 };
    for (const stream of this.streams.values()) stream.error(new Error(message));
    this.streams.clear();
  }
}

/** Server-side handle on the function runtime processes. */
export class FunctionRuntime {
  manifest?: Manifest;
  loadError?: string;
  onPublish: (topics: string[]) => void = () => {};
  onLog: (entry: LogEntry) => void = () => {};
  /** A gateway sends to, or closes, one of the server's sockets. */
  onWs: (msg: SocketMessage) => void = () => {};
  /** Traces the runtime started itself (scheduled jobs), custom metrics, and child processes' health samples. */
  onTrace: (trace: TraceRecord) => void = () => {};
  onMetrics: (points: Omit<MetricPoint, "service" | "instance">[], instance: string) => void = () => {};
  onSample: (sample: Omit<RuntimeSample, "service">) => void = () => {};

  private workers: Worker[] = [];
  /** Each gateway socket stays with the worker that took its open, because that is where its state is. */
  private sockets = new Map<string, Promise<Worker | undefined>>();
  private starting?: Promise<Manifest>;
  private next = 0;
  private stopping = false;

  constructor(private opts: Options) {}

  private spawn(index: number): Worker {
    const onMessage = (msg: RuntimeMessage) => {
      if (msg.t === "publish") this.onPublish(msg.topics);
      else if (msg.t === "log") this.onLog(msg.entry);
      else if (msg.t === "ws") this.onWs(msg);
      else if (msg.t === "trace") this.onTrace(msg.trace);
      else if (msg.t === "metrics") this.onMetrics(msg.points, msg.instance);
      else if (msg.t === "sample") this.onSample({ ...msg.sample, inflight: this.workers[index]?.load }); // calls waiting in that process, for the Runtime page
      else if (msg.t === "relay") for (const w of this.workers) if (w.ready) w.event(msg); // to every worker, the sender too: one path for all
    };
    if (this.opts.inline) return new InlineWorker(this.opts, { onMessage });
    return new RuntimeProcess(index, this.opts, {
      onMessage,
      // A crash outside a restart (e.g. out of memory) brings that process back, so one bad call doesn't take the server down.
      onCrash: (i, code) => {
        if (this.stopping || this.starting || !this.manifest) return;
        console.error(`function runtime ${i} exited (code ${code}); restarting it`);
        this.closeSockets(1011, "The server restarted");
        void this.respawn(i);
      },
    });
  }

  /** A gateway socket's event, for the worker that has it. */
  wsEvent(msg: Extract<HostEvent, { t: "ws" }>) {
    if (msg.op === "open") {
      const closed = () => (this.onWs({ t: "ws", op: "close", sid: msg.sid, code: 1011, reason: "The function runtime is not running" }), undefined);
      // Worker 0, while it is up: every socket in one process, so a gateway's clients are all of them and a broadcast reaches everyone.
      this.sockets.set(msg.sid, this.pick(0).then((w) => (w.event(msg), w), closed));
      return;
    }
    const worker = this.sockets.get(msg.sid);
    if (msg.op === "close") this.sockets.delete(msg.sid);
    void worker?.then((w) => w?.event(msg)); // after its open: callbacks on one promise run in order
  }

  /** Their state was in a worker that is gone, so the clients reconnect to a fresh one. shortcut: closes every socket, not only that worker's; fine while one worker is the default. */
  private closeSockets(code: number, reason: string) {
    for (const sid of this.sockets.keys()) this.onWs({ t: "ws", op: "close", sid, code, reason });
    this.sockets.clear();
  }

  private async respawn(index: number) {
    const w = this.spawn(index);
    this.workers[index] = w;
    await w.start().catch((e) => console.error(`function runtime ${index} failed to restart: ${e.message}`));
  }

  /** Each process's waiting queries, for /metrics and the busy warning. */
  backlog() {
    return this.workers.map((w) => w.backlog);
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
    this.closeSockets(1012, "The server is restarting");
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
    if (wanted?.ready) return wanted;
    // The process with the fewest calls waiting; ties go round in turn. A long call holds up only what is queued behind it, so a process that is
    // free should get the next call instead of the one whose turn it is.
    const turn = this.next++;
    let best = live[turn % live.length]!;
    for (let i = 1; i < live.length; i++) {
      const w = live[(turn + i) % live.length]!;
      if (w.load < best.load) best = w;
    }
    return best;
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

  call(name: string, kind: FunctionKind, args: unknown, headers: CallHeaders, opts: { allowInternal?: boolean; requestId?: string; identity?: UserIdentity | null; trace?: TraceParent; access?: "only" | "skip" } = {}) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    return this.send({ t: "call", name, kind, args, headers, ...opts }, (kind === "action" ? t.actionMs : t.functionMs) + HARD_TIMEOUT_GRACE_MS) as Promise<CallResult>;
  }

  /** Resolves the caller from request headers; null when anonymous. */
  identity(headers: CallHeaders) {
    return this.send({ t: "identity", headers }, 30_000) as Promise<UserIdentity | null>;
  }

  /** The same with what the answer rests on (see IdentityDetail). */
  identityDetail(headers: CallHeaders) {
    return this.send({ t: "identity", headers, detail: true }, 30_000) as Promise<IdentityDetail>;
  }

  auth(req: SerializedRequest, trace?: TraceParent) {
    return this.send({ t: "auth", req, trace }, 30_000) as Promise<SerializedResponse>;
  }

  /** `worker` pins the request to one process, where state it needs lives (Socket.IO's long-polling sessions are on worker 0). */
  http(req: HttpRequestMessage, headers: CallHeaders, requestId: string, worker?: number, trace?: TraceParent) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    return this.send({ t: "http", req, headers, requestId, trace }, t.actionMs + HARD_TIMEOUT_GRACE_MS, worker) as Promise<HttpResponseMessage>;
  }

  admin<T = unknown>(op: string, args: Record<string, unknown>, actor: string) {
    const t = this.opts.timeouts ?? { functionMs: 10_000, actionMs: 600_000 };
    const timeout = op === "run" || op === "cli" ? t.actionMs + HARD_TIMEOUT_GRACE_MS : 60_000;
    return this.send({ t: "admin", op, args, actor }, timeout) as Promise<T>;
  }
}
