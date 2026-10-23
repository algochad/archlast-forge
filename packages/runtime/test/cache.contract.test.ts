import { describe, expect, test } from "bun:test";
import { MemoryCache, RedisCache, type Cache } from "../src/server/cache";

const adapters: [string, () => Promise<Cache>][] = [
  ["memory", async () => new MemoryCache(3)],
  ...(process.env.TEST_REDIS_URL ? ([["redis", () => RedisCache.connect(process.env.TEST_REDIS_URL!)]] as [string, () => Promise<Cache>][]) : []),
];

for (const [label, make] of adapters) {
  describe(`Cache contract: ${label}`, () => {
    const k = (s: string) => `${crypto.randomUUID()}:${s}`;

    test("get/set/del", async () => {
      const c = await make();
      const key = k("a");
      expect(await c.get(key)).toBeUndefined();
      await c.set(key, { n: 1 }, { ttlMs: 10_000 });
      expect(await c.get<{ n: number }>(key)).toEqual({ n: 1 });
      await c.del(key);
      expect(await c.get(key)).toBeUndefined();
      await c.close();
    });

    test("expires after the TTL", async () => {
      const c = await make();
      const key = k("ttl");
      await c.set(key, 1, { ttlMs: 30 });
      await Bun.sleep(60);
      expect(await c.get(key)).toBeUndefined();
      await c.close();
    });

    test("invalidate evicts entries tagged with a topic", async () => {
      const c = await make();
      const [a, b] = [k("a"), k("b")];
      const topic = `todos:${crypto.randomUUID()}`;
      await c.set(a, 1, { ttlMs: 10_000, topics: [topic] });
      await c.set(b, 2, { ttlMs: 10_000, topics: ["other"] });
      expect(await c.invalidate([topic])).toBe(1);
      expect(await c.get(a)).toBeUndefined();
      expect(await c.get<number>(b)).toBe(2);
      await c.close();
    });

    test("clear evicts everything and says how many entries it removed", async () => {
      const c = await make();
      const topic = `todos:${crypto.randomUUID()}`;
      const before = await c.clear(); // other tests share a Redis
      await c.set(k("a"), 1, { ttlMs: 10_000, topics: [topic] });
      await c.set(k("b"), 2, { ttlMs: 10_000 });
      expect(await c.clear()).toBe(2);
      expect(before).toBeGreaterThanOrEqual(0);
      await c.close();
    });
  });
}

test("MemoryCache evicts least recently used", async () => {
  const c = new MemoryCache(2);
  await c.set("a", 1, { ttlMs: 1000 });
  await c.set("b", 2, { ttlMs: 1000 });
  await c.get("a");
  await c.set("c", 3, { ttlMs: 1000 });
  expect(await c.get("b")).toBeUndefined();
  expect(await c.get<number>("a")).toBe(1);
});

test("MemoryCache reports entries and bytes, and counts what it evicts to stay in budget", async () => {
  const c = new MemoryCache(100, 4000);
  const big = "x".repeat(600);
  for (let i = 0; i < 10; i++) await c.set(`k${i}`, big, { ttlMs: 1000 });
  const { entries, bytes, evictions } = c.stats();
  expect(bytes).toBeLessThanOrEqual(4000);
  expect(entries).toBeLessThan(10);
  expect(evictions).toBe(10 - entries!);
  expect(await c.get("k0")).toBeUndefined(); // oldest went first
  expect(await c.get(`k9`)).toBe(big);
  await c.clear();
  expect(c.stats()).toEqual({ entries: 0, bytes: 0, evictions });
});

test("MemoryCache won't keep a result bigger than a quarter of its budget", async () => {
  const c = new MemoryCache(100, 4000);
  expect(await c.set("small", "x", { ttlMs: 1000 })).toBe(true);
  expect(await c.set("huge", "x".repeat(2000), { ttlMs: 1000 })).toBe(false);
  expect(await c.get("small")).toBe("x"); // and the big one didn't push it out
  expect(await c.get("huge")).toBeUndefined();
});
