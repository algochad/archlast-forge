import type { RedisClient } from "bun";
import { connectRedis } from "./bus";

export interface Cache {
  get<T = unknown>(key: string): Promise<T | undefined>;
  /** `topics` tag the entry so `invalidate` can evict it when a mutation writes them. */
  set(key: string, value: unknown, opts: { ttlMs: number; topics?: string[] }): Promise<void>;
  del(key: string): Promise<void>;
  invalidate(topics: string[]): Promise<void>;
  close(): Promise<void>;
}

type Entry = { value: unknown; expires: number; topics: string[] };

export class MemoryCache implements Cache {
  private entries = new Map<string, Entry>();
  private byTopic = new Map<string, Set<string>>();

  constructor(private max = 1000) {}

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
    this.entries.set(key, { value, expires: Date.now() + ttlMs, topics });
    for (const t of topics) {
      let keys = this.byTopic.get(t);
      if (!keys) this.byTopic.set(t, (keys = new Set()));
      keys.add(key);
    }
    while (this.entries.size > this.max) this.remove(this.entries.keys().next().value!);
  }

  async del(key: string) {
    this.remove(key);
  }

  async invalidate(topics: string[]) {
    for (const t of topics) for (const key of this.byTopic.get(t) ?? []) this.remove(key);
  }

  private remove(key: string) {
    const e = this.entries.get(key);
    if (!e) return;
    this.entries.delete(key);
    for (const t of e.topics) {
      const keys = this.byTopic.get(t);
      keys?.delete(key);
      if (keys && !keys.size) this.byTopic.delete(t);
    }
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
  }

  async del(key: string) {
    await this.redis.del(P + key);
  }

  async invalidate(topics: string[]) {
    for (const t of topics) {
      const keys = (await this.redis.send("SMEMBERS", [`${P}tag:${t}`])) as string[];
      if (keys.length) await this.redis.send("DEL", keys.map((k) => P + k));
      await this.redis.del(`${P}tag:${t}`);
    }
  }

  async close() {
    this.redis.close();
  }
}
