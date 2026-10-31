import { expect, test } from "bun:test";
import type { RedisClient } from "bun";
import { RedisCache } from "../src/server/cache";
import { RedisRateLimiter } from "../src/server/ratelimit";

/** A Redis client stuck reconnecting: Bun's client queues commands, so they never answer. */
const stuck = { send: () => new Promise(() => {}), get: () => new Promise(() => {}) } as unknown as RedisClient;

test("while Redis doesn't answer, the rate limit is counted in this server instead of failing or lifting", async () => {
  const limiter = new RedisRateLimiter(stuck, "rl:", 50);
  const rule = { window: 60, max: 2 };
  const began = performance.now();
  const results = [await limiter.consume("ip", rule), await limiter.consume("ip", rule), await limiter.consume("ip", rule)];
  expect(results.map((r) => r.allowed)).toEqual([true, true, false]);
  expect(results[2]!.retryAfter).toBeGreaterThan(0);
  expect(performance.now() - began).toBeLessThan(1000);
});

test("a shared cache that doesn't answer is a miss, and a result not kept", async () => {
  const cache = new (RedisCache as unknown as new (r: RedisClient) => RedisCache)(stuck);
  const began = performance.now();
  expect(await cache.get("k")).toBeUndefined();
  expect(await cache.set("k", { value: 1 }, { ttlMs: 1000, topics: ["t"] })).toBe(false);
  expect(performance.now() - began).toBeLessThan(3000);
});
