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
      await c.invalidate([topic]);
      expect(await c.get(a)).toBeUndefined();
      expect(await c.get<number>(b)).toBe(2);
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
