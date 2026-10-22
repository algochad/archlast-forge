import type { Bus } from "./bus";
import type { Cache } from "./cache";
import type { CallHeaders } from "./executor";
import type { FunctionRuntime } from "./runtime";

export type QueryUpdate = { value: unknown } | { error: string };

/** Runs queries through the shared result cache. */
export class QueryRunner {
  /** Bumped on every invalidation, so a result computed across one isn't cached. */
  private generation = 0;
  private invalidating: Promise<unknown> = Promise.resolve();

  constructor(
    private runtime: FunctionRuntime,
    private cache: Cache | undefined,
    private ttlMs: number,
  ) {}

  invalidated(topic: string) {
    this.generation++;
    if (this.cache) this.invalidating = Promise.all([this.invalidating, this.cache.invalidate([topic])]).then(() => {});
  }

  async run(name: string, args: unknown, headers: CallHeaders) {
    const key = `${name}:${JSON.stringify(args ?? {})}`;
    await this.invalidating; // a pending eviction must land before we read the cache
    const hit = await this.cache?.get<{ value: unknown; topics: string[] }>(key);
    if (hit) return hit;
    const gen = this.generation;
    const r = await this.runtime.call(name, "query", args, headers);
    // shortcut: any invalidation during the run skips caching, not only overlapping topics; track per topic if write-heavy apps need more hits.
    if (this.cache && !r.usedAuth && gen === this.generation)
      await this.cache.set(key, { value: r.value, topics: r.topics }, { ttlMs: this.ttlMs, topics: r.topics });
    return { value: r.value, topics: r.topics ?? [] };
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
  ) {}

  /** Yields the result, then a new result after each relevant write. Unchanged results aren't re-sent. */
  async *subscribe(name: string, args: unknown, headers: CallHeaders, signal?: AbortSignal): AsyncGenerator<QueryUpdate> {
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
          const r = await this.queries.run(name, args, headers);
          // The read set can change with the data, so re-record topics on every run.
          for (const [t, off] of unsubs) if (!r.topics.includes(t)) (off(), unsubs.delete(t));
          for (const t of r.topics) if (!unsubs.has(t)) unsubs.set(t, this.bus.subscribe(t, onEvent));
          sub.topics = r.topics;
          update = { value: r.value };
        } catch (e) {
          update = { error: (e as Error).message };
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
}
