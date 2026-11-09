// A cluster: several servers of one app on one machine, sharing the port (each with its own Rust I/O thread and its own JavaScript event loop), the way Tuyere
// adds JavaScript loops as it adds I/O threads. The first process (index 0) is the one the CLI started: it keeps what must happen once (the scheduler, crons, backups,
// the telemetry store, the dashboard and the admin API); the others answer requests, and send what they record to it. `docs/decisions.md#a-cluster-of-servers` says why.
//
// What they share, over unix sockets in a folder of the data directory (nothing leaves the machine):
//   - topics, so a mutation in one process wakes the live queries, the query cache and the page cache of every other (ClusterBus);
//   - rate-limit counts, in a file all of them map into memory, so a client's budget is the app's and not each process's (SharedRateLimiter);
//   - the control plane: requests for /_admin, the dashboard, /metrics and the like are passed to the first process (`proxy`), which has the state they show.
// With Redis (REDIS_URL) topics, the cache and the limits are Redis's, as for servers on several machines, and only the control plane and the telemetry are passed on.
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MemoryBus } from "./bus";
import { ConfigError, type Config } from "./config";
import { serverCores } from "./cores";
import { nativeDb } from "./db/native";
import { serverMemory } from "./db/sqlite";
import { chooseEngine } from "./engine";
import { MemoryRateLimiter, type RateLimiter, type RateLimitResult } from "./ratelimit";
import { log } from "./logger";

/** What a loaded server takes of the machine's memory (the benchmark's peak was 180 to 280 MiB), with room to spare: no more servers than fit. */
export const SERVER_BYTES = 384 * 1024 * 1024;

/**
 * Servers per machine for `cores` cores and `memory` bytes: two from 4 cores, one below, and fewer when they would not fit. SQLite has one writer, so a third
 * server made lists a little faster (+8%) and updates slower (71k to 67k a second, then 62k with a fourth) with reads level; two is where it pays.
 */
export function clusterSizeFor(cores: number, memory = Infinity): number {
  return Math.max(1, Math.min(cores >= 4 ? 2 : 1, Math.floor(memory / SERVER_BYTES)));
}

/**
 * The function runtime's processes of each server, for a start whose `RUNTIME_WORKERS` is `auto`: the cores the ratio gives (half, by default) shared among the servers,
 * as many as fit in memory next to them, and one (the runtime inline in the server) when that is all there is. A number is the app's own choice, for each server.
 */
export function runtimeWorkersPerServer(want: { workers: number; auto: boolean }, servers: number, memory = Infinity): number {
  if (!want.auto) return want.workers;
  const fits = Math.floor(memory / SERVER_BYTES / servers) - 1; // (each server is a process of its own beside its runtime processes)
  return Math.max(1, Math.min(Math.floor(want.workers / servers), fits));
}

/**
 * How many servers this one is among, for a start that has not been told: `SERVER_PROCESSES` (a number, or `auto` from the cores) when everything a cluster needs is there, else 1.
 * A number above 1 that cannot be had is an error that says what is missing; `auto` quietly means 1.
 */
export async function resolveClusterSize(config: Config, env: Record<string, string | undefined>, o: { dev: boolean; command?: string[] }): Promise<{ size: number; why: string }> {
  if (config.clusterIndex > 0 || config.clusterSize > 1) return { size: config.clusterSize, why: "started by the first server" };
  const want = config.serverProcesses;
  if (want === 1) return { size: 1, why: "SERVER_PROCESSES=1" };
  const refuse = (needs: string) => {
    if (want !== "auto") throw new ConfigError(`SERVER_PROCESSES=${want} needs ${needs}`);
    return { size: 1, why: `no cluster: it needs ${needs}` };
  };
  if (o.dev) return refuse("a production start (development runs one server)");
  if (config.databaseKind !== "sqlite") return refuse("SQLite (Postgres and MongoDB are not supported yet)");
  if (env.DB_ENGINE === "bun") return refuse("the native database layer, not DB_ENGINE=bun");
  if (!o.command) return refuse("a start with the archlast-forge CLI (`archlast-forge start`), which can start the other servers");
  const engine = await chooseEngine(config.httpEngine, o.dev);
  if (engine.engine !== "archlast") return refuse(`the native HTTP engine (${engine.why})`);
  if (!nativeDb()) return refuse("the native database layer, which is not available here (Linux, built with `bun run build` in packages/db, or the engine image)");
  const cores = serverCores();
  const size = want === "auto" ? clusterSizeFor(cores, serverMemory()) : want;
  return { size, why: want === "auto" ? `${size} servers for ${cores} cores` : `SERVER_PROCESSES=${size}` };
}

/** What a process sends another. */
export type ClusterMessage =
  | { t: "hello"; index: number }
  | { t: "topics"; topics: string[] }
  /** A server let go of the database's write lock: one that waits for it may try now. */
  | { t: "unlock" }
  /** A server reloaded its function runtime (`env set`, the dashboard, SIGHUP) and it worked: the others do the same, so they all run what the first one does. */
  | { t: "reload" }
  /** An event a runtime relayed to its peers (`createPubSub`). */
  | { t: "relay"; topic: string; payload: unknown }
  /** A server's function counts since its last message (for /metrics, which the first server answers for the cluster), and what it holds open now. */
  | { t: "metrics"; from: number; fns: Record<string, { calls: number; errors: number; sum: number; buckets: number[] }>; connections: number; subscriptions: number };

// ---- the sockets: newline-delimited JSON over a unix socket ----

/** Writes to a socket without losing what it would not take at once. */
class Out {
  private pending?: Uint8Array;
  constructor(private socket: { write(data: Uint8Array): number }) {}
  send(message: ClusterMessage) {
    const bytes = new TextEncoder().encode(JSON.stringify(message) + "\n");
    this.pending = this.pending ? concat(this.pending, bytes) : bytes;
    this.drain();
  }
  drain() {
    if (!this.pending) return;
    const n = this.socket.write(this.pending);
    this.pending = n >= this.pending.length ? undefined : this.pending.subarray(n);
  }
}

const concat = (a: Uint8Array, b: Uint8Array) => {
  const out = new Uint8Array(a.length + b.length);
  out.set(a);
  out.set(b, a.length);
  return out;
};

/** Splits what a socket delivers into the lines it was sent, keeping a partial one for the next chunk. */
class Lines {
  private decoder = new TextDecoder();
  private rest = "";
  push(chunk: Uint8Array): ClusterMessage[] {
    this.rest += this.decoder.decode(chunk, { stream: true });
    const out: ClusterMessage[] = [];
    let at: number;
    while ((at = this.rest.indexOf("\n")) >= 0) {
      const line = this.rest.slice(0, at);
      this.rest = this.rest.slice(at + 1);
      if (!line) continue;
      try {
        out.push(JSON.parse(line) as ClusterMessage);
      } catch {} // a line that is not JSON is not ours
    }
    return out;
  }
}

/** The folder the sockets are in: below the data directory, private to the user running the server. */
export const clusterDir = (dataDir: string) => join(dataDir, ".cluster");

// ---- the first process: the hub ----

export class ClusterHub {
  private peers = new Map<number, { out: Out }>();
  private listener?: ReturnType<typeof Bun.listen>;
  /** What the first process does with a message from another. */
  onMessage: (m: ClusterMessage, from: number) => void = () => {};
  /** Processes connected, by index. */
  get connected() {
    return [...this.peers.keys()];
  }

  constructor(readonly dir: string) {}

  start() {
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    SharedRateLimiter.create(this.dir);
    writeFileSync(join(this.dir, "epochs.shm"), new Uint8Array(16_384)); // the commit counters of the read caches (packages/db/crates/napi/src/epochs.rs)
    const hub = this;
    this.listener = Bun.listen<{ lines: Lines; out: Out; index?: number }>({
      unix: join(this.dir, "hub.sock"),
      socket: {
        open(socket) {
          socket.data = { lines: new Lines(), out: new Out(socket) };
        },
        data(socket, chunk) {
          for (const m of socket.data.lines.push(chunk)) {
            if (m.t === "hello") {
              socket.data.index = m.index;
              hub.peers.set(m.index, { out: socket.data.out });
            } else if (socket.data.index !== undefined) hub.onMessage(m, socket.data.index);
          }
        },
        drain(socket) {
          socket.data.out.drain();
        },
        close(socket) {
          if (socket.data.index !== undefined && hub.peers.get(socket.data.index)?.out === socket.data.out) hub.peers.delete(socket.data.index);
        },
        error() {},
      },
    });
  }

  /** To every process, but `except` (the one the message came from). */
  send(message: ClusterMessage, except?: number) {
    for (const [index, p] of this.peers) if (index !== except) p.out.send(message);
  }

  stop() {
    this.listener?.stop(true);
    this.peers.clear();
    rmSync(this.dir, { recursive: true, force: true });
  }
}

// ---- the other processes: the link to the hub ----

export class ClusterLink {
  onMessage: (m: ClusterMessage) => void = () => {};
  /** The hub went away (the first process stopped or died): this process stops too. */
  onClose: () => void = () => {};
  private constructor(private out: Out) {}

  static async connect(dir: string, index: number, wait = 30_000): Promise<ClusterLink> {
    const until = Date.now() + wait;
    for (;;) {
      try {
        let link: ClusterLink | undefined;
        const lines = new Lines();
        const socket = await Bun.connect<{ out?: Out }>({
          unix: join(dir, "hub.sock"),
          socket: {
            data(_s, chunk) {
              for (const m of lines.push(chunk)) link?.onMessage(m);
            },
            drain() {
              link?.out.drain();
            },
            close() {
              link?.onClose();
            },
            error() {},
          },
        });
        link = new ClusterLink(new Out(socket));
        link.out.send({ t: "hello", index });
        return link;
      } catch (e) {
        if (Date.now() > until) throw new Error(`couldn't reach the first server of the cluster at ${dir}: ${(e as Error).message}`);
        await Bun.sleep(100);
      }
    }
  }

  send(message: ClusterMessage) {
    this.out.send(message);
  }
}

/** What both ends of a connection give the bus and the limiter. */
export interface ClusterWire {
  send(message: ClusterMessage): void;
}

// ---- topics ----

/** The bus of a cluster: a topic published here reaches this process's listeners at once and every other process's through the hub. */
export class ClusterBus extends MemoryBus {
  constructor(private wire: ClusterWire) {
    super();
  }
  override async publish(topics: string[]) {
    this.dispatch(topics);
    if (topics.length) this.wire.send({ t: "topics", topics });
  }
  /** Topics another process published. */
  receive(topics: string[]) {
    this.dispatch(topics);
  }
}

// ---- rate limits ----

const SLOTS = 16_384;
const FILE = "rate.shm";

/**
 * Rate-limit counts in a file the servers map into memory and update with atomic operations: exact, and with no message between the servers. A slot is four 32-bit words:
 * the key's hash (two words), the window it counts and the count. Windows are aligned to the clock, so every server has the same one. When the table is crowded (all of a
 * key's probes taken by others in the window) the server counts that key alone for the moment, as a server without a cluster would.
 */
export class SharedRateLimiter implements RateLimiter {
  private words: Int32Array;
  private alone = new MemoryRateLimiter();

  constructor(dir: string) {
    const map = Bun.mmap(join(dir, FILE), { shared: true });
    this.words = new Int32Array(map.buffer, map.byteOffset, SLOTS * 4);
  }

  /** Makes the file (zeros: no counts), once, by the first server. */
  static create(dir: string) {
    writeFileSync(join(dir, FILE), new Uint8Array(SLOTS * 16));
  }

  async consume(key: string, rule: { window: number; max: number }): Promise<RateLimitResult> {
    const length = rule.window * 1000;
    const now = Date.now();
    const win = Math.floor(now / length);
    const n = this.count(key, rule.window, win);
    if (n === undefined) return this.alone.consume(key, rule);
    return n <= rule.max ? { allowed: true, retryAfter: null } : { allowed: false, retryAfter: Math.max(1, Math.ceil(((win + 1) * length - now) / 1000)) };
  }

  /** This request's number in the window, or undefined when the key has no slot to be counted in. */
  private count(key: string, window: number, win: number): number | undefined {
    const a = this.words;
    const hash = Bun.hash.wyhash(`${window}:${key}`) as bigint;
    const h1 = Number(BigInt.asIntN(32, hash)) || 1;
    const h2 = Number(BigInt.asIntN(32, hash >> 32n)) || 1;
    const first = (h1 >>> 0) % SLOTS;
    for (let probe = 0; probe < 8; probe++) {
      const b = ((first + probe) % SLOTS) * 4;
      let k1 = Atomics.load(a, b);
      if (k1 === 0 && Atomics.compareExchange(a, b, 0, h1) === 0) {
        // had it empty: it is ours
        Atomics.store(a, b + 1, h2);
        Atomics.store(a, b + 2, win);
        Atomics.store(a, b + 3, 1);
        return 1;
      }
      k1 = Atomics.load(a, b);
      if (k1 === h1) {
        let k2 = Atomics.load(a, b + 1);
        for (let spin = 0; k2 === 0 && spin < 1000; spin++) k2 = Atomics.load(a, b + 1); // the server that took it is writing the rest
        if (k2 === h2) return this.bump(b, win);
      }
      // another key's, over: a slot of a window that has passed is taken over (held at -1 while it is set up, so that nobody counts in it half way)
      const w = Atomics.load(a, b + 2);
      if (k1 !== 0 && k1 !== -1 && w < win && Atomics.compareExchange(a, b, k1, -1) === k1) {
        Atomics.store(a, b + 1, h2);
        Atomics.store(a, b + 2, win);
        Atomics.store(a, b + 3, 1);
        Atomics.store(a, b, h1);
        return 1;
      }
    }
    return undefined;
  }

  private bump(b: number, win: number): number {
    const a = this.words;
    for (;;) {
      const w = Atomics.load(a, b + 2);
      if (w === win) return Atomics.add(a, b + 3, 1) + 1;
      if (w > win) return 1; // a clock that went back: not this request's window
      if (Atomics.compareExchange(a, b + 2, w, win) === w) {
        Atomics.store(a, b + 3, 1); // the window began: this request is its first
        return 1;
      }
    }
  }
}

// ---- the control plane ----

/** The paths the first process answers for the whole cluster: it has the telemetry store, the logs, the metrics, the sessions of the dashboard and the settings. */
export function isControlPlane(path: string, method: string): boolean {
  return path.startsWith("/_admin/") || path === "/_dashboard" || path.startsWith("/_dashboard/") || path === "/_cli" || path === "/metrics" || path.startsWith("/otlp/v1/") || (path === "/_telemetry" && method === "POST") || path === "/_csp";
}

const SOCKETS = { control: "control.sock" } as const;

/** The first process listens here for the requests the others pass on; `handle` answers one as if it had come in at the port, with the address the client had. */
export function serveControl(dir: string, handle: (req: Request, clientIp: string | undefined) => Response | Promise<Response>) {
  return Bun.serve({
    unix: join(dir, SOCKETS.control),
    maxRequestBodySize: 4 * 2 ** 30,
    fetch: (req) => handle(req, req.headers.get("x-archlast-cluster-ip") ?? undefined),
  });
}

/** Passes a request to the first process and answers with what it answered. */
export async function proxy(dir: string, req: Request, clientIp: string | undefined): Promise<Response> {
  const url = new URL(req.url);
  const headers = new Headers(req.headers);
  if (clientIp) headers.set("x-archlast-cluster-ip", clientIp);
  else headers.delete("x-archlast-cluster-ip");
  const hasBody = req.method !== "GET" && req.method !== "HEAD" && req.body !== null;
  try {
    const res = await fetch(`http://localhost${url.pathname}${url.search}`, {
      method: req.method,
      headers,
      body: hasBody ? req.body : undefined,
      // @ts-expect-error Bun: a request body that is a stream, and a unix socket
      duplex: "half",
      unix: join(dir, SOCKETS.control),
      redirect: "manual",
      decompress: false,
    });
    return new Response(res.body, { status: res.status, headers: res.headers });
  } catch (e) {
    log("warn", `the first server of the cluster didn't answer ${req.method} ${url.pathname}: ${(e as Error).message}`);
    return Response.json({ message: "The server is starting or restarting; try again" }, { status: 503, headers: { "retry-after": "1" } });
  }
}

// ---- the supervisor ----

/** Starts the other processes of a cluster, keeps them running, and stops them with the first. */
export class ClusterSupervisor {
  private procs = new Map<number, ReturnType<typeof Bun.spawn>>();
  private stopping = false;
  private failures = new Map<number, number>();

  constructor(
    private o: { size: number; command: string[]; env: Record<string, string | undefined>; dir: string },
  ) {}

  start() {
    for (let i = 1; i < this.o.size; i++) this.spawn(i);
  }

  private spawn(index: number) {
    if (this.stopping) return;
    const started = Date.now();
    const proc = Bun.spawn(this.o.command, {
      env: { ...this.o.env, ARCHLAST_CLUSTER_SIZE: String(this.o.size), ARCHLAST_CLUSTER_INDEX: String(index), ARCHLAST_WORKER: String(index) } as Record<string, string>,
      stdin: "ignore",
      stdout: "inherit",
      stderr: "inherit",
      onExit: (_p, code, signal) => {
        if (this.procs.get(index) !== proc) return;
        this.procs.delete(index);
        if (this.stopping) return;
        // one that ran for a while is a crash, not a start that fails: it comes back at once; a start that keeps failing backs off
        const fast = Date.now() - started < 10_000;
        const failures = fast ? (this.failures.get(index) ?? 0) + 1 : 0;
        this.failures.set(index, failures);
        const wait = Math.min(30_000, 500 * 2 ** Math.min(failures, 6));
        log("error", `Bellows: server ${index} exited (${signal ?? `code ${code}`}); starting it again in ${(wait / 1000).toFixed(1)} s`);
        setTimeout(() => this.spawn(index), wait).unref?.();
      },
    });
    this.procs.set(index, proc);
  }

  /** The processes asked to stop (SIGTERM: each finishes its requests, as the first does) and, past `graceMs`, killed. */
  async stop(graceMs = 15_000) {
    this.stopping = true;
    const running = [...this.procs.values()];
    for (const p of running) p.kill("SIGTERM");
    const exited = Promise.all(running.map((p) => p.exited));
    const timer = setTimeout(() => running.forEach((p) => p.kill("SIGKILL")), graceMs);
    await exited;
    clearTimeout(timer);
    this.procs.clear();
  }

  get running() {
    return this.procs.size;
  }
}
