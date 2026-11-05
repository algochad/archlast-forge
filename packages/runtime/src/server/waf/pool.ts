// The server's handle on its WAF threads: a request goes to the thread with the least waiting, and comes back as a verdict.
//
// A thread can stop answering (a request that makes the rules run for ever, or a trap in the WASM). Each request has a deadline: past it the
// thread is ended and a new one started, so one bad request can't take the WAF down, and what was waiting on that thread fails (the server
// then refuses those requests rather than letting them through unchecked). A thread whose start fails (a rule that doesn't parse, the module
// missing) is tried again after a while.
import { log } from "../logger";
import type { Explained, Verdict, WafMode } from "./engine";
import type { WireRequest, WorkerReply, WorkerRequest } from "./worker";

/** How long a thread may take over a request, queue included, unless the pool is told otherwise. A normal one takes a millisecond or a few. */
const DEADLINE_MS = 3000;
/** Requests waiting on one thread before new ones are refused at once: it keeps the queue short enough that a deadline means a stuck thread, not a busy one. */
const MAX_WAITING = 256;
const RETRY_START_MS = 5000;

export interface PoolOptions {
  rules: string;
  mode: WafMode;
  size: number;
  deadlineMs?: number;
}

type Answer = { verdict: Verdict; explained?: Explained };
type Pending = { resolve(a: Answer): void; reject(e: Error): void; timer: ReturnType<typeof setTimeout> };

/** One thread as the dashboard shows it. */
export interface ThreadInfo {
  state: "up" | "starting" | "restarting";
  /** Requests it has been given and not answered. */
  waiting: number;
  /** Answered since it started (all its lives). */
  served: number;
  /** Times it was replaced after a stuck request or a crash. */
  restarts: number;
  /** Why the last restart or failed start happened. */
  lastError?: string;
}

class Thread {
  private worker!: Worker;
  private pending = new Map<number, Pending>();
  private seq = 0;
  /** Settled when this thread can inspect; rejected when it failed to start. */
  ready!: Promise<void>;
  closed = false;
  private deadlineMs: number;
  private state: ThreadInfo["state"] = "starting";
  private served = 0;
  private restarts = 0;
  private lastError?: string;

  constructor(
    private script: URL,
    private opts: PoolOptions,
  ) {
    this.deadlineMs = opts.deadlineMs ?? DEADLINE_MS;
    this.spawn();
  }

  get waiting() {
    return this.pending.size;
  }

  info(): ThreadInfo {
    return { state: this.state, waiting: this.pending.size, served: this.served, restarts: this.restarts, ...(this.lastError && { lastError: this.lastError }) };
  }

  private spawn() {
    const worker = (this.worker = new Worker(this.script));
    const ready = Promise.withResolvers<void>();
    ready.promise.catch(() => {});
    this.ready = ready.promise;
    this.state = "starting";
    let up = false;
    worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      if (worker !== this.worker) return;
      const msg = e.data;
      if (msg.t === "ready") {
        up = true;
        this.state = "up";
        return ready.resolve();
      }
      if (msg.t === "fatal") {
        ready.reject(new Error(msg.error));
        log("error", "the WAF thread failed to start", { error: msg.error });
        return this.restart(RETRY_START_MS, msg.error);
      }
      const p = this.pending.get(msg.id);
      if (!p) return; // it already timed out
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      this.served++;
      if (msg.t === "verdict") p.resolve({ verdict: msg.verdict, explained: msg.explained });
      else p.reject(new Error(msg.error));
    };
    worker.onerror = (e) => {
      if (worker !== this.worker) return;
      // A thread that dies before it is up (its code can't load) would die again at once: that is a start failure, tried again later, not a crash to answer with a new thread.
      if (up) return this.restart(0, e.message);
      ready.reject(new Error(e.message));
      log("error", "the WAF thread failed to start", { error: e.message });
      this.restart(RETRY_START_MS, e.message);
    };
    worker.postMessage({ t: "init", rules: this.opts.rules, mode: this.opts.mode } satisfies WorkerRequest);
  }

  /** Ends the thread and starts another, after `delayMs`; everything waiting on the old one fails. */
  private restart(delayMs: number, reason: string) {
    const old = this.worker;
    this.worker = undefined as never; // ignores whatever the old one still says
    this.state = "restarting";
    this.lastError = reason;
    this.restarts++;
    old.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error(`WAF thread restarted: ${reason}`));
    }
    this.pending.clear();
    if (this.closed) return;
    if (delayMs === 0) return this.spawn();
    const failed = Promise.reject(new Error(`WAF thread unavailable: ${reason}`));
    failed.catch(() => {});
    this.ready = failed;
    setTimeout(() => !this.closed && this.spawn(), delayMs).unref?.();
  }

  async inspect(req: WireRequest, body?: Uint8Array, explain?: boolean): Promise<Answer> {
    if (this.pending.size >= MAX_WAITING) throw new Error("WAF overloaded");
    await this.ready;
    const worker = this.worker;
    const id = ++this.seq;
    return new Promise<Answer>((resolve, reject) => {
      const timer = setTimeout(() => {
        // Only a thread that has been given the request is to blame for it.
        if (worker === this.worker) {
          log("error", "a WAF thread didn't answer in time and was restarted", { deadlineMs: this.deadlineMs });
          this.restart(0, `no answer in ${this.deadlineMs} ms`);
        } else reject(new Error("WAF thread restarted"));
      }, this.deadlineMs);
      this.pending.set(id, { resolve, reject, timer });
      worker.postMessage({ t: "inspect", id, req, body, ...(explain && { explain }) } satisfies WorkerRequest);
    });
  }

  close() {
    this.closed = true;
    this.worker?.terminate();
    for (const p of this.pending.values()) {
      clearTimeout(p.timer);
      p.reject(new Error("The WAF is stopped"));
    }
    this.pending.clear();
  }
}

export class WafPool {
  private threads: Thread[];

  private constructor(script: URL, opts: PoolOptions) {
    this.threads = Array.from({ length: opts.size }, () => new Thread(script, opts));
  }

  /** Starts the threads and waits for every one to have its rules loaded, so a configuration that can't work stops the engine at start. */
  static async start(script: URL, opts: PoolOptions): Promise<WafPool> {
    const pool = new WafPool(script, opts);
    try {
      await Promise.all(pool.threads.map((t) => t.ready));
    } catch (e) {
      pool.close();
      throw e;
    }
    return pool;
  }

  private leastBusy() {
    let best = this.threads[0]!;
    for (const t of this.threads) if (t.waiting < best.waiting) best = t;
    return best;
  }

  async inspect(req: WireRequest, body?: Uint8Array): Promise<Verdict> {
    return (await this.leastBusy().inspect(req, body)).verdict;
  }

  /** Inspects with every matching rule reported, whatever the verdict (the dashboard's "try a request"). */
  async explain(req: WireRequest, body?: Uint8Array): Promise<Explained> {
    const { explained } = await this.leastBusy().inspect(req, body, true);
    return explained!;
  }

  get size() {
    return this.threads.length;
  }

  threadInfo(): ThreadInfo[] {
    return this.threads.map((t) => t.info());
  }

  /**
   * Ends the threads once nothing is waiting on them (or after `graceMs`): for a pool that has been replaced, which a request that was
   * already on its way to it may still use for a moment.
   */
  retire(graceMs = 10_000) {
    const until = Date.now() + graceMs;
    const check = () => {
      if (this.threads.every((t) => t.waiting === 0) || Date.now() > until) return this.close();
      setTimeout(check, 100).unref?.();
    };
    setTimeout(check, 250).unref?.();
  }

  close() {
    for (const t of this.threads) t.close();
  }
}
