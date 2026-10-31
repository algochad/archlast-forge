import type { UserIdentity } from "../functions";
import type { Bus } from "./bus";
import type { Cache } from "./cache";
import type { CallHeaders } from "./executor";
import { log } from "./logger";
import type { FunctionRuntime } from "./runtime";
import type { CallTelemetry, TraceParent } from "./telemetry/context";
import { failureOf } from "./telemetry/outcome";
import type { Telemetry } from "./telemetry/recorder";

/** Filled in by a query run for whoever records it: how the cache answered, and what the run recorded when it executed. */
export interface QueryObserver {
  trace?: TraceParent;
  cache?: "hit" | "miss" | "shared";
  telemetry?: CallTelemetry;
  user?: { id: string; name?: string };
}

export type QueryUpdate = { value: unknown } | { error: string; data?: unknown; requestId?: string };

/** `clean`: no write to anything the query read landed while it ran, so the result includes every write seen so far. Absent means a cache hit, which was clean when stored. */
type Result = {
  value: unknown;
  topics: string[];
  clean?: boolean;
  /** `JSON.stringify(value)`, built once and kept with a cached entry, so a hit doesn't serialize again. */
  json?: string;
  /** The HTTP response body for this result, encoded once: a hit sends these bytes as they are. */
  body?: Uint8Array<ArrayBuffer>;
};

/** Arguments, or how to get them: an HTTP call passes its raw JSON, parsed only when the cache can't answer. */
export type Args = unknown | (() => unknown);
const argsOf = (args: Args) => (typeof args === "function" ? (args as () => unknown)() : args);

interface FunctionStats {
  /** Served from the cache. */
  hits: number;
  /** Executed because nothing usable was cached. */
  misses: number;
  /** Shared the result of an identical call already running. */
  coalesced: number;
  /** Executions whose result couldn't be kept: a write overlapped, it was too big, or it is per-caller and wasn't keyed yet. */
  skipped: number;
  hitMs: number;
  missMs: number;
  /** Cached separately for each signed-in user, because the query reads `ctx.auth`. */
  perUser: boolean;
}

export interface CacheSnapshot {
  enabled: boolean;
  ttlMs: number;
  entries: number | null;
  bytes: number | null;
  evictions: number;
  /** Entries removed because a mutation wrote something they read. */
  invalidatedEntries: number;
  hits: number;
  misses: number;
  coalesced: number;
  skipped: number;
  functions: (FunctionStats & { name: string; savedMs: number })[];
}

/** Runs queries through the shared result cache: identical calls are answered from it, or share one execution. */
export class QueryRunner {
  /** Sequence number of the latest invalidation, and of the latest per topic. */
  private seq = 0;
  private invalidatedAt = new Map<string, number>();
  private history: [number, string][] = [];
  /** Invalidations at or before this were forgotten; a run older than it can't be proven clean. */
  private horizon = 0;
  private invalidating: Promise<unknown> = Promise.resolve();
  /** Evictions from a remote cache still in flight; an in-process cache evicts synchronously, so a read never waits. */
  private evicting = 0;
  private invalidatedEntries = 0;
  private stats = new Map<string, FunctionStats>();
  /** Functions seen reading `ctx.auth`: their cache keys include the caller. */
  private perUser = new Set<string>();
  private inflight = new Map<string, Promise<Result & { clean: boolean }>>();

  constructor(
    private runtime: FunctionRuntime,
    private cache: Cache | undefined,
    private ttlMs: number,
  ) {}

  invalidated(topic: string) {
    const seq = ++this.seq;
    this.invalidatedAt.set(topic, seq);
    this.history.push([seq, topic]);
    if (this.history.length > 50_000) {
      for (const [s, t] of this.history.splice(0, 10_000)) if (this.invalidatedAt.get(t) === s) this.invalidatedAt.delete(t);
      this.horizon = this.history[0]![0] - 1;
    }
    if (this.cache?.invalidateNow) this.invalidatedEntries += this.cache.invalidateNow([topic]);
    else if (this.cache) {
      this.evicting++;
      const evicting = this.cache
        .invalidate([topic])
        .then((n) => void (this.invalidatedEntries += n))
        .catch((e) => log("error", "cache invalidation failed", { error: String(e) })) // one failure must not poison every later read
        .finally(() => this.evicting--);
      this.invalidating = Promise.all([this.invalidating, evicting]);
    }
  }

  /**
   * Runs a query through the cache. `raw`, when given, is the call's arguments exactly as they arrived (the JSON text of an HTTP call):
   * the cache is keyed by it, so a hit needs no parsing at all; the same text always means the same arguments.
   */
  async run(name: string, args: Args, headers: CallHeaders, requestId?: string, raw?: string, obs?: QueryObserver): Promise<Result> {
    const cache = this.cache;
    if (!cache) {
      const start = this.seq;
      const r = await this.runtime.call(name, "query", argsOf(args), headers, { requestId, trace: obs?.trace });
      if (obs) obs.telemetry = r.telemetry;
      const topics = r.topics ?? [];
      return { value: r.value, topics, clean: this.untouched(topics, start) };
    }
    const began = performance.now();
    const stats = this.statsOf(name);
    // Queries that read ctx.auth are cached per caller. Who the caller is gets resolved fresh each time, so a revoked session stops matching.
    const identity = this.perUser.has(name) ? await this.runtime.identity(headers) : undefined;
    if (obs && identity) obs.user = { id: identity.userId, ...((identity.email ?? identity.name) && { name: String(identity.email ?? identity.name) }) };
    // Per user, not per session: someone signed in on two devices has two sessions and the same results. (The session id stays out of the key.)
    const who = identity === undefined ? name : JSON.stringify([name, identity && { userId: identity.userId, email: identity.email, name: identity.name }]);
    const key = raw !== undefined ? `${who}\u0000${raw}` : `${who}\u0001${JSON.stringify(argsOf(args) ?? {})}`;
    if (this.evicting) await this.invalidating; // a pending eviction must land before we read the cache
    const hit = await cache.get<Result>(key);
    if (hit) {
      stats.hits++;
      stats.hitMs += performance.now() - began;
      if (obs) obs.cache = "hit";
      return hit;
    }
    const running = this.inflight.get(key);
    if (running) {
      // Only a run that no write overlapped is sure to include the write that woke this caller; otherwise run again.
      const shared = await running.catch(() => undefined);
      if (shared?.clean) {
        stats.coalesced++;
        if (obs) obs.cache = "shared";
        return shared;
      }
    }
    if (obs) obs.cache = "miss";
    const mine = this.execute(name, args, headers, requestId, identity, key, cache, obs);
    this.inflight.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.inflight.get(key) === mine) this.inflight.delete(key);
      stats.misses++;
      stats.missMs += performance.now() - began;
    }
  }

  private async execute(name: string, args: Args, headers: CallHeaders, requestId: string | undefined, identity: UserIdentity | null | undefined, key: string, cache: Cache, obs?: QueryObserver) {
    const start = this.seq;
    const r = await this.runtime.call(name, "query", argsOf(args), headers, { requestId, trace: obs?.trace, ...(identity !== undefined && { identity }) });
    if (obs) obs.telemetry = r.telemetry;
    const topics = r.topics ?? [];
    // First sighting of a per-caller query: its result belongs to this caller, and the next call will be keyed by caller.
    const unkeyed = Boolean(r.usedAuth) && identity === undefined;
    if (unkeyed) this.perUser.add(name);
    const stats = this.statsOf(name);
    stats.perUser = this.perUser.has(name);
    // Cache only if none of the topics this result read was written while it ran.
    const clean = this.untouched(topics, start);
    // The entry is the object the caller gets, so the JSON a response builds from it (`json`) stays with the entry.
    const json = r.json ?? JSON.stringify(r.value) ?? "null";
    const result: Result & { clean: boolean } = { value: r.value, topics, clean: clean && !unkeyed, json };
    const kept = clean && !unkeyed && (await cache.set(key, result, { ttlMs: this.ttlMs, topics, size: json.length * 3 }));
    if (!kept) stats.skipped++;
    return result;
  }

  private untouched(topics: string[], start: number) {
    return start >= this.horizon && !topics.some((t) => (this.invalidatedAt.get(t) ?? 0) > start);
  }

  /** Counters for a function; calls to names that don't exist are counted nowhere, so they can't grow the table. */
  private statsOf(name: string) {
    let s = this.stats.get(name);
    if (!s && this.runtime.manifest?.functions.some((f) => f.name === name))
      this.stats.set(name, (s = { hits: 0, misses: 0, coalesced: 0, skipped: 0, hitMs: 0, missMs: 0, perUser: false }));
    return s ?? { hits: 0, misses: 0, coalesced: 0, skipped: 0, hitMs: 0, missMs: 0, perUser: false };
  }

  /** Drops everything cached, e.g. from the dashboard. Resolves with the number of entries removed. */
  clear() {
    return this.cache?.clear() ?? Promise.resolve(0);
  }

  /** After the function code changes, what the old code computed is wrong. */
  async reset() {
    this.perUser.clear();
    this.inflight.clear();
    await this.clear();
  }

  snapshot(): CacheSnapshot {
    const functions = [...this.stats].map(([name, s]) => ({
      name,
      ...s,
      // What the avoided executions would have cost, at this function's average miss time.
      savedMs: s.misses ? Math.max(0, (s.hits + s.coalesced) * (s.missMs / s.misses) - s.hitMs) : 0,
    }));
    const total = (k: "hits" | "misses" | "coalesced" | "skipped") => functions.reduce((n, f) => n + f[k], 0);
    return {
      enabled: Boolean(this.cache),
      ttlMs: this.ttlMs,
      ...(this.cache?.stats() ?? { entries: 0, bytes: 0, evictions: 0 }),
      invalidatedEntries: this.invalidatedEntries,
      hits: total("hits"),
      misses: total("misses"),
      coalesced: total("coalesced"),
      skipped: total("skipped"),
      functions,
    };
  }
}

interface Subscription {
  name: string;
  args: unknown;
  topics: string[];
  since: number;
  rerun(): void;
}

const DEBOUNCE_MS = 50;

export class SubscriptionManager {
  private subs = new Set<Subscription>();

  constructor(
    private bus: Bus,
    private queries: QueryRunner,
    private describeError: (e: unknown, requestId?: string) => QueryUpdate = (e) => ({ error: (e as Error).message }),
    /** Records each run: the first as the subscription's request, the rest as live re-runs after writes. */
    private telemetry?: Telemetry,
  ) {}

  /** Yields the result, then a new result after each relevant write. Unchanged results aren't re-sent. */
  async *subscribe(name: string, args: unknown, headers: CallHeaders, signal?: AbortSignal, requestId?: string): AsyncGenerator<QueryUpdate> {
    let dirty = true;
    let wake: (() => void) | undefined;
    let timer: Timer | undefined;
    const unsubs = new Map<string, () => void>();
    const sub: Subscription = {
      name,
      args,
      topics: [],
      since: Date.now(),
      rerun: () => {
        dirty = true;
        wake?.();
      },
    };
    const onEvent = () => {
      timer ??= setTimeout(() => {
        timer = undefined;
        sub.rerun();
      }, DEBOUNCE_MS);
    };
    this.subs.add(sub);
    signal?.addEventListener("abort", () => wake?.());
    let last: string | undefined;
    let first = true;
    try {
      while (!signal?.aborted) {
        if (!dirty) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          continue;
        }
        dirty = false;
        let update: QueryUpdate;
        const tel = this.telemetry;
        const root = tel?.begin(first ? "query" : "live", name, first ? "WS" : "LIVE", undefined, requestId);
        const obs: QueryObserver | undefined = root && { get trace() { return tel!.parent(root); } };
        let recorded = !root;
        first = false;
        try {
          const r = await this.queries.run(name, args, headers, requestId, undefined, obs);
          if (root) this.telemetry!.end(root, { status: 200, telemetry: obs!.telemetry, cache: obs!.cache, user: obs!.user });
          recorded = true;
          // The read set can change with the data, so re-record topics on every run.
          for (const [t, off] of unsubs) if (!r.topics.includes(t)) (off(), unsubs.delete(t));
          const added = r.topics.filter((t) => !unsubs.has(t));
          for (const t of added) unsubs.set(t, this.bus.subscribe(t, onEvent));
          // A write between the read and a remote subscription going live would be missed: read again once it's live.
          if (added.length && this.bus.ready) {
            await this.bus.ready();
            dirty = true;
          }
          sub.topics = r.topics;
          // A write that landed while the query ran may have been published before this subscription listened for it.
          if (r.clean === false) dirty = true;
          update = { value: r.value };
        } catch (e) {
          if (!recorded) this.telemetry!.end(root!, failureOf(e));
          update = this.describeError(e, requestId);
        }
        const hash = String(Bun.hash(JSON.stringify(update)));
        if (hash !== last && !signal?.aborted) {
          last = hash;
          yield update;
        }
      }
    } finally {
      clearTimeout(timer);
      for (const off of unsubs.values()) off();
      this.subs.delete(sub);
    }
  }

  /** After the function runtime restarts, code may have changed: re-run everything. */
  rerunAll() {
    for (const s of this.subs) s.rerun();
  }

  list() {
    return [...this.subs].map(({ name, args, topics, since }) => ({ name, args, topics, since }));
  }

  get size() {
    return this.subs.size;
  }
}
