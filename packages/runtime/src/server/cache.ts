import type { RedisClient } from "bun";
import { connectRedis } from "./bus";

/** What the cache holds right now. `null` where the backend can't say cheaply (Redis manages its own memory). */
export interface CacheStats {
  entries: number | null;
  bytes: number | null;
  /** Entries pushed out to stay within the size limits, since this process started. */
  evictions: number;
}

export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** `topics` tag the entry so `invalidate` can evict it when a mutation writes them. Resolves false when the entry was too big to keep. */
  set(key: string, value: unknown, opts: { ttlMs: number; topics?: string[] }): Promise<boolean>;
  del(key: string): Promise<void>;
  /** Evicts every entry tagged with one of `topics`; resolves with how many were removed. */
  invalidate(topics: string[]): Promise<number>;
  /** Evicts everything; resolves with how many entries were removed. */
  clear(): Promise<number>;
  stats(): CacheStats;
  close(): Promise<void>;
}

type Entry = { value: unknown; expires: number; topics: string[]; size: number };

/** Approximate memory an entry takes: its JSON length plus bookkeeping. */
const ENTRY_OVERHEAD = 200;

export class MemoryCache implements Cache {
  private entries = new Map<string, Entry>();
  private byTopic = new Map<string, Set<string>>();
  private bytes = 0;
  private evictions = 0;

  constructor(
    private maxEntries = 10_000,
    private maxBytes = 64 * 2 ** 20,
  ) {}

  async get<T>(key: string) {
    const e = this.entries.get(key);
    if (!e) return undefined;
    if (e.expires <= Date.now()) {
      this.remove(key);
      return undefined;
    }
    this.entries.delete(key); // LRU bump
    this.entries.set(key, e);
    return e.value as T;
  }

  async set(key: string, value: unknown, { ttlMs, topics = [] }: { ttlMs: number; topics?: string[] }) {
    this.remove(key);
    const size = JSON.stringify(value).length + key.length + ENTRY_OVERHEAD;
    // One huge result would flush everything else out; it's cheaper to just not keep it.
    if (size > this.maxBytes / 4) return false;
    this.entries.set(key, { value, expires: Date.now() + ttlMs, topics, size });
    this.bytes += size;
    for (const t of topics) {
      let keys = this.byTopic.get(t);
      if (!keys) this.byTopic.set(t, (keys = new Set()));
      keys.add(key);
    }
    while (this.entries.size > this.maxEntries || this.bytes > this.maxBytes) {
      this.remove(this.entries.keys().next().value!);
      this.evictions++;
    }
    return true;
  }

  async del(key: string) {
    this.remove(key);
  }

  async invalidate(topics: string[]) {
    let removed = 0;
    for (const t of topics) for (const key of [...(this.byTopic.get(t) ?? [])]) if (this.remove(key)) removed++;
    return removed;
  }

  async clear() {
    const n = this.entries.size;
    this.entries.clear();
    this.byTopic.clear();
    this.bytes = 0;
    return n;
  }

  stats() {
    return { entries: this.entries.size, bytes: this.bytes, evictions: this.evictions };
  }

  private remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return false;
    this.entries.delete(key);
    this.bytes -= e.size;
    for (const t of e.topics) {
      const keys = this.byTopic.get(t);
      keys?.delete(key);
      if (keys && !keys.size) this.byTopic.delete(t);
    }
    return true;
  }

  async close() {}
}

const P = "archlast-forge:cache:";

export class RedisCache implements Cache {
  private constructor(private redis: RedisClient) {}

  static async connect(url: string) {
    return new RedisCache(await connectRedis(url));
  }

  async get<T>(key: string) {
    const raw = await this.redis.get(P + key);
    return raw === null ? undefined : (JSON.parse(raw) as T);
  }

  async set(key: string, value: unknown, { ttlMs, topics = [] }: { ttlMs: number; topics?: string[] }) {
    await this.redis.send("SET", [P + key, JSON.stringify(value), "PX", String(ttlMs)]);
    for (const t of topics) {
      await this.redis.send("SADD", [`${P}tag:${t}`, key]);
      await this.redis.send("PEXPIRE", [`${P}tag:${t}`, String(ttlMs)]);
    }
    return true;
  }

  async del(key: string) {
    await this.redis.del(P + key);
  }

  async invalidate(topics: string[]) {
    let removed = 0;
    for (const t of topics) {
      const keys = (await this.redis.send("SMEMBERS", [`${P}tag:${t}`])) as string[];
      if (keys.length) removed += Number(await this.redis.send("DEL", keys.map((k) => P + k)));
      await this.redis.del(`${P}tag:${t}`);
    }
    return removed;
  }

  async clear() {
    let removed = 0;
    let cursor = "0";
    do {
      const [next, keys] = (await this.redis.send("SCAN", [cursor, "MATCH", `${P}*`, "COUNT", "500"])) as [string, string[]];
      cursor = next;
      if (keys.length) {
        await this.redis.send("DEL", keys);
        removed += keys.filter((k) => !k.startsWith(`${P}tag:`)).length; // tag sets aren't entries
      }
    } while (cursor !== "0");
    return removed;
  }

  // Redis keeps its own accounting; counting our keys would mean scanning the whole keyspace.
  stats() {
    return { entries: null, bytes: null, evictions: 0 };
  }

  async close() {
    this.redis.close();
  }
}
