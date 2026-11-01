import type { UserIdentity } from "../functions";
import type { Bus } from "./bus";
import { MemoryCache, type Cache } from "./cache";
import type { CallHeaders } from "./executor";
import { log } from "./logger";
import type { FunctionRuntime } from "./runtime";
import type { CallTelemetry, TraceParent } from "./telemetry/context";
import { failureOf } from "./telemetry/outcome";
import type { Telemetry } from "./telemetry/recorder";

/** Filled in by a query run for whoever records it: how the cache answered, and what the run recorded when it executed. */
export interface QueryObserver {
  trace?: TraceParent;
  /** Set by a run of a query that declares `access`: what the caller's check read. A subscription watches it too, so a ban or a role change wakes it. */
  access?: string[];
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

/** Who a request is from, as the server keeps it. `until`: when the answer stops holding by itself (the session's end). */
interface Caller {
  identity: UserIdentity | null;
  until?: number;
  /** What the answer rests on: a write to one of these (the session, the user) changes it. Absent when it can't be pinned to topics. */
  topics?: string[];
}
const ANONYMOUS: Caller = Object.freeze({ identity: null });

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
  /**
   * Who each signed-in credential belongs to, and what each caller's `access` check read, kept while the rows they rest on are unchanged: a write to
   * a session or user ends the first, a write to anything the check read ends the second, as for a cached result. So an authenticated call that
   * hits the cache needs no round trip to the function runtime, and a ban or a revoked session still takes effect on the next call.
   */
  private callers?: MemoryCache;
  private checks?: MemoryCache;
  /** Queries that declare `access`, from the manifest. */
  private sharedNames?: { manifest: unknown; names: Set<string> };

  constructor(
    private runtime: FunctionRuntime,
    private cache: Cache | undefined,
    private ttlMs: number,
    /**
     * Identical calls share one execution even without a cache. That is safe only when every write's topics reach `invalidated()`, so
     * that a run a write overlapped is never shared: true unless several servers share a Redis bus with the cache off.
     */
    private coalesce = Boolean(cache),
  ) {
    if (cache) {
      this.callers = new MemoryCache(20_000, 8 * 2 ** 20);
      this.checks = new MemoryCache(50_000, 16 * 2 ** 20);
    }
  }

  private isShared(name: string) {
    const manifest = this.runtime.manifest;
    let known = this.sharedNames;
    if (!known || known.manifest !== manifest) this.sharedNames = known = { manifest, names: new Set(manifest?.functions.filter((f) => f.access).map((f) => f.name)) };
    return known.names.has(name);
  }

  /** The caller of a request. Anonymous requests cost nothing; a signed-in one asks the function runtime only when the server doesn't know it. */
  async who(headers: CallHeaders): Promise<Caller> {
    if (!headers.cookie && !headers.authorization) return ANONYMOUS;
    const key = `${headers.cookie ?? ""}\u0000${headers.authorization ?? ""}`;
    const known = this.callers?.getNow<Caller>(key);
    if (known) return known;
    if (!this.callers) return { identity: await this.runtime.identity(headers) };
    const start = this.seq;
    const { identity, topics, until } = await this.runtime.identityDetail(headers);
    if (!identity) return ANONYMOUS;
    // Frozen: an inline runtime hands this object to every function that asks who is calling.
    const caller: Caller = Object.freeze({ identity: Object.freeze(identity), until, topics });
    if (topics && this.untouched(topics, start)) await this.callers.set(key, caller, { ttlMs: Math.max(1, Math.min(this.ttlMs, (until ?? Infinity) - Date.now())), topics, size: 400 });
    return caller;
  }

  /** The caller, if the server already knows them; never a round trip. For calls that carry it to the function runtime. */
  known(headers: CallHeaders): UserIdentity | null | undefined {
    if (!headers.cookie && !headers.authorization) return null;
    return this.callers?.getNow<Caller>(`${headers.cookie ?? ""}\u0000${headers.authorization ?? ""}`)?.identity;
  }

  /**
   * Runs the `access` check of a query for this caller; it throws when the caller is refused. Answers with the topics the check read.
   * Kept per caller and arguments while those reads are unchanged, and never kept when it refuses.
   */
  private async checkAccess(name: string, args: Args, headers: CallHeaders, requestId: string | undefined, raw: string | undefined, obs: QueryObserver): Promise<string[]> {
    const key = `${name}\u0000${headers.cookie ?? ""}\u0000${headers.authorization ?? ""}\u0000${raw ?? JSON.stringify(argsOf(args) ?? {})}`;
    const kept = this.checks?.getNow<string[]>(key);
    if (kept) return kept;
    const start = this.seq;
    const caller = await this.who(headers);
    const r = await this.runtime.call(name, "query", argsOf(args), headers, { requestId, trace: obs.trace, access: "only", identity: caller.identity });
    obs.telemetry = r.telemetry;
    // The answer rests on the caller as well as on what the check read: a session that ends must end it, and wake a subscription.
    const topics = caller.topics ? [...caller.topics, ...(r.topics ?? [])] : (r.topics ?? []);
    const stable = caller.topics !== undefined || (!headers.cookie && !headers.authorization); // a credential that couldn't be pinned to topics is asked again
    if (this.checks && stable && this.untouched(topics, start)) await this.checks.set(key, topics, { ttlMs: Math.max(1, Math.min(this.ttlMs, (caller.until ?? Infinity) - Date.now())), topics, size: key.length * 2 + topics.length * 60 });
    return topics;
  }

  invalidated(topic: string) {
    const seq = ++this.seq;
    this.invalidatedAt.set(topic, seq);
    this.history.push([seq, topic]);
    if (this.history.length > 50_000) {
      for (const [s, t] of this.history.splice(0, 10_000)) if (this.invalidatedAt.get(t) === s) this.invalidatedAt.delete(t);
      this.horizon = this.history[0]![0] - 1;
    }
    this.callers?.invalidateNow([topic]);
    this.checks?.invalidateNow([topic]);
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
  async run(name: string, args: Args, headers: CallHeaders, requestId?: string, raw?: string, obs: QueryObserver = {}): Promise<Result> {
    const cache = this.cache;
    // A query with `access`: the check is this caller's, every time; what it returns is the same for everyone who passes, so it is cached and shared without the caller in its key.
    const shared = this.isShared(name);
    if (shared) obs.access = await this.checkAccess(name, args, headers, requestId, raw, obs);
    // Without a cache, a query that reads ctx.auth runs on its own: sharing it would mean resolving the caller first, for little gain.
    if (!cache && (!this.coalesce || (!shared && this.perUser.has(name)))) {
      const start = this.seq;
      const r = await this.runtime.call(name, "query", argsOf(args), headers, { requestId, trace: obs.trace, ...(shared && { access: "skip" as const }) });
      obs.telemetry = r.telemetry;
      if (r.usedAuth) this.perUser.add(name);
      const topics = r.topics ?? [];
      return { value: r.value, topics, clean: this.untouched(topics, start), json: r.json ?? JSON.stringify(r.value) ?? "null" };
    }
    const began = performance.now();
    const stats = this.statsOf(name);
    // Queries that read ctx.auth are cached per caller. Who the caller is gets resolved fresh each time, so a revoked session stops matching.
    const identity = cache && !shared && this.perUser.has(name) ? (await this.who(headers)).identity : undefined;
    if (identity) obs.user = { id: identity.userId, ...((identity.email ?? identity.name) && { name: String(identity.email ?? identity.name) }) };
    // Per user, not per session: someone signed in on two devices has two sessions and the same results. (The session id stays out of the key.)
    const who = identity === undefined ? name : JSON.stringify([name, identity && { userId: identity.userId, email: identity.email, name: identity.name }]);
    const key = raw !== undefined ? `${who}\u0000${raw}` : `${who}\u0001${JSON.stringify(argsOf(args) ?? {})}`;
    if (cache) {
      if (this.evicting) await this.invalidating; // a pending eviction must land before we read the cache
      const hit = await cache.get<Result>(key);
      if (hit) {
        stats.hits++;
        stats.hitMs += performance.now() - began;
        obs.cache = "hit";
        return hit;
      }
    }
    // Only a run that no write overlapped is sure to include the write that woke this caller; otherwise a run is needed. When it is, one waiter starts it
    // and the others, looking again, join that one: all of them starting their own would multiply the work exactly while writes are landing and runs are slow.
    for (let round = 0, running = this.inflight.get(key); running && round < 3; round++, running = this.inflight.get(key)) {
      const coalesced = await running.catch(() => undefined);
      if (coalesced?.clean) {
        stats.coalesced++;
        obs.cache = "shared";
        return coalesced;
      }
    }
    if (cache) obs.cache = "miss";
    const mine = this.execute(name, args, headers, requestId, identity, key, cache, obs, shared);
    this.inflight.set(key, mine);
    try {
      return await mine;
    } finally {
      if (this.inflight.get(key) === mine) this.inflight.delete(key);
      stats.misses++;
      stats.missMs += performance.now() - began;
    }
  }

  private async execute(name: string, args: Args, headers: CallHeaders, requestId: string | undefined, identity: UserIdentity | null | undefined, key: string, cache: Cache | undefined, obs: QueryObserver, shared = false) {
    const start = this.seq;
    const r = await this.runtime.call(name, "query", argsOf(args), headers, { requestId, trace: obs.trace, ...(identity !== undefined && { identity }), ...(shared && { access: "skip" as const }) });
    obs.telemetry = r.telemetry;
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
    const kept = cache && clean && !unkeyed && (await cache.set(key, result, { ttlMs: this.ttlMs, topics, size: json.length * 3 }));
    if (cache && !kept) stats.skipped++;
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
    this.callers?.clear();
    this.checks?.clear();
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
  /**
   * Subscriptions a write woke, re-run together when the debounce ends: all at once, their identical queries are running at the same time
   * and share one execution (QueryRunner), instead of each finishing before the next one's own timer fires.
   */
  private due = new Set<Subscription>();
  private dueTimer?: Timer;

  constructor(
    private bus: Bus,
    private queries: QueryRunner,
    private describeError: (e: unknown, requestId?: string) => QueryUpdate = (e) => ({ error: (e as Error).message }),
    /** Records each run: the first as the subscription's request, the rest as live re-runs after writes. */
    private telemetry?: Telemetry,
  ) {}

  /** Yields the result, then a new result after each relevant write. Unchanged results aren't re-sent. */
  async *subscribe(name: string, args: unknown, headers: CallHeaders, signal?: AbortSignal, requestId?: string): AsyncGenerator<QueryUpdate & { json?: string }> {
    let dirty = true;
    let wake: (() => void) | undefined;
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
      this.due.add(sub);
      this.dueTimer ??= setTimeout(() => {
        this.dueTimer = undefined;
        const woken = [...this.due];
        this.due.clear();
        for (const s of woken) s.rerun();
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
        let update: QueryUpdate & { json?: string };
        let hash: string;
        const tel = this.telemetry;
        const root = tel?.begin(first ? "query" : "live", name, first ? "WS" : "LIVE", undefined, requestId);
        const obs: QueryObserver = root ? { get trace() { return tel!.parent(root); } } : {};
        let recorded = !root;
        first = false;
        try {
          const r = await this.queries.run(name, args, headers, requestId, undefined, obs);
          if (root) this.telemetry!.end(root, { status: 200, telemetry: obs.telemetry, cache: obs.cache, user: obs.user });
          recorded = true;
          // The read set can change with the data, so re-record topics on every run. A query with `access` also watches what its check read for this caller.
          const topics = obs.access?.length ? [...new Set([...r.topics, ...obs.access])] : r.topics;
          for (const [t, off] of unsubs) if (!topics.includes(t)) (off(), unsubs.delete(t));
          const added = topics.filter((t) => !unsubs.has(t));
          for (const t of added) unsubs.set(t, this.bus.subscribe(t, onEvent));
          // A write between the read and a remote subscription going live would be missed: read again once it's live.
          if (added.length && this.bus.ready) {
            await this.bus.ready();
            dirty = true;
          }
          sub.topics = topics;
          // A write that landed while the query ran may have been published before this subscription listened for it.
          if (r.clean === false) dirty = true;
          // Subscribers of one query share its result object, so its JSON is built, and hashed, once for all of them.
          const json = (r.json ??= JSON.stringify(r.value) ?? "null");
          update = { value: r.value, json };
          hash = ((r as { hash?: string }).hash ??= String(Bun.hash(json)));
        } catch (e) {
          if (!recorded) this.telemetry!.end(root!, failureOf(e));
          update = this.describeError(e, requestId);
          hash = String(Bun.hash(JSON.stringify(update)));
        }
        if (hash !== last && !signal?.aborted) {
          last = hash;
          yield update;
        }
      }
    } finally {
      this.due.delete(sub);
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
