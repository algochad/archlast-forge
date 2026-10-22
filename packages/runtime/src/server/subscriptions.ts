import type { Bus } from "./bus";
import type { Cache } from "./cache";
import type { CallHeaders } from "./executor";
import type { FunctionRuntime } from "./runtime";

export type QueryUpdate = { value: unknown } | { error: string; data?: unknown; requestId?: string };

/** Runs queries through the shared result cache. */
export class QueryRunner {
  /** Sequence number of the latest invalidation, and of the latest per topic. */
  private seq = 0;
  private invalidatedAt = new Map<string, number>();
  private history: [number, string][] = [];
  /** Invalidations at or before this were forgotten; a run older than it can't be proven clean. */
  private horizon = 0;
  private invalidating: Promise<unknown> = Promise.resolve();

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
    if (this.cache) this.invalidating = Promise.all([this.invalidating, this.cache.invalidate([topic])]).then(() => {});
  }

  async run(name: string, args: unknown, headers: CallHeaders, requestId?: string) {
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    await this.invalidating; // a pending eviction must land before we read the cache
    const hit = await this.cache?.get<{ value: unknown; topics: string[] }>(key);
    if (hit) return hit;
    const start = this.seq;
    const r = await this.runtime.call(name, "query", args, headers, { requestId });
    const topics = r.topics ?? [];
    // Cache only if none of the topics this result read was written while it ran.
    const clean = start >= this.horizon && !topics.some((t) => (this.invalidatedAt.get(t) ?? 0) > start);
    if (this.cache && !r.usedAuth && clean) await this.cache.set(key, { value: r.value, topics }, { ttlMs: this.ttlMs, topics });
    return { value: r.value, topics };
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
    try {
      while (!signal?.aborted) {
        if (!dirty) {
          await new Promise<void>((resolve) => (wake = resolve));
          wake = undefined;
          continue;
        }
        dirty = false;
        let update: QueryUpdate;
        try {
          const r = await this.queries.run(name, args, headers, requestId);
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
          update = { value: r.value };
        } catch (e) {
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
