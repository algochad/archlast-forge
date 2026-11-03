import { describe, expect, test } from "bun:test";
import { claimPrefix, connectRedis, RedisBus } from "../src/server/bus";
import { RedisCache } from "../src/server/cache";
import { loadConfig, redisOwnerOf, redisPrefixOf } from "../src/server/config";

/** Apps that share one Redis, as the services of a monorepo can: each needs keys, channels and rate limits of its own. */

describe("the Redis prefix of a service", () => {
  test("is the same for every instance of a service, whatever its secret, data folder or number of servers", () => {
    const orders = { OTEL_SERVICE_NAME: "orders" };
    expect(redisPrefixOf({ ...orders, BETTER_AUTH_SECRET: "one-secret-0123456789", DATA_DIR: "/a" })).toBe(redisPrefixOf({ ...orders, BETTER_AUTH_SECRET: "rotated-secret-9876543210", DATA_DIR: "/b", REPLICAS: "3" }));
  });

  test("differs between services, and has the service's name in it", () => {
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "orders" })).toBe("archlast-forge:orders:");
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "billing" })).toBe("archlast-forge:billing:");
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "orders" })).not.toBe(redisPrefixOf({ OTEL_SERVICE_NAME: "billing" }));
  });

  test("is what the engine always used for an app that names nothing, so upgrading it moves no keys", () => {
    expect(redisPrefixOf({})).toBe("archlast-forge:");
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "" })).toBe("archlast-forge:");
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "archlast-forge" })).toBe("archlast-forge:"); // the default name is no name
  });

  test("makes a name that has other characters safe, and short", () => {
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "Orders API / EU" })).toBe("archlast-forge:orders-api-eu:");
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "x".repeat(200) }).length).toBeLessThanOrEqual("archlast-forge:".length + 49);
  });

  test("is REDIS_PREFIX when it is set, which wins over the name, and ends with a colon", () => {
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "orders", REDIS_PREFIX: "shop:" })).toBe("shop:");
    expect(redisPrefixOf({ REDIS_PREFIX: "shop" })).toBe("shop:");
    expect(redisPrefixOf({ OTEL_SERVICE_NAME: "orders", REDIS_PREFIX: "archlast-forge:" })).toBe("archlast-forge:"); // the old keys, kept on purpose
  });

  test("refuses a prefix that is a pattern or too long: the cache is cleared with a SCAN MATCH on it", () => {
    for (const bad of ["a*", "a?b", "a[b]", "a b", "x".repeat(65)]) expect(() => redisPrefixOf({ REDIS_PREFIX: bad })).toThrow("REDIS_PREFIX");
  });

  test("is in the config", () => {
    const env = { OTEL_SERVICE_NAME: "orders", BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "http://localhost:3000", ALLOW_INSECURE_HTTP: "1" };
    expect(loadConfig(env).redisPrefix).toBe("archlast-forge:orders:");
  });

  test("the owner mark is the same for the servers of an app, and differs between apps (and a rotated secret)", () => {
    const owner = (authSecret?: string, dataDir = "./data") => redisOwnerOf({ authSecret, dataDir });
    expect(owner("secret-a-0123456789")).toBe(owner("secret-a-0123456789", "/elsewhere"));
    expect(owner("secret-a-0123456789")).not.toBe(owner("secret-b-0123456789"));
    expect(owner(undefined, "/work/a")).not.toBe(owner(undefined, "/work/b"));
    expect(owner("secret-a-0123456789")).not.toContain("secret-a");
  });
});

const url = process.env.TEST_REDIS_URL;
describe.skipIf(!url)("two apps on one Redis", () => {
  const until = async (cond: () => boolean, ms = 2000) => {
    for (const end = Date.now() + ms; !cond(); ) {
      if (Date.now() > end) throw new Error("timed out");
      await Bun.sleep(5);
    }
  };
  const run = crypto.randomUUID().slice(0, 8);

  test("a cached result is the app's own: another app with the same function and arguments doesn't get it", async () => {
    const orders = await RedisCache.connect(url!, `t-${run}-orders:`);
    const billing = await RedisCache.connect(url!, `t-${run}-billing:`);
    await orders.set("messages:list{}", { from: "orders" }, { ttlMs: 10_000, topics: ["messages"] });
    expect(await billing.get("messages:list{}")).toBeUndefined();
    await billing.set("messages:list{}", { from: "billing" }, { ttlMs: 10_000, topics: ["messages"] });
    expect(await orders.get("messages:list{}")).toEqual({ from: "orders" });
    expect(await billing.get("messages:list{}")).toEqual({ from: "billing" });
    await orders.close();
    await billing.close();
  });

  test("servers of one app share their cache", async () => {
    const a = await RedisCache.connect(url!, `t-${run}-same:`);
    const b = await RedisCache.connect(url!, `t-${run}-same:`);
    await a.set("k", 1, { ttlMs: 10_000 });
    expect(await b.get("k")).toBe(1);
    await a.close();
    await b.close();
  });

  test("invalidating and clearing touch only the app's own entries", async () => {
    const orders = await RedisCache.connect(url!, `t-${run}-o2:`);
    const billing = await RedisCache.connect(url!, `t-${run}-b2:`);
    await orders.set("q", 1, { ttlMs: 10_000, topics: ["notes"] });
    await billing.set("q", 2, { ttlMs: 10_000, topics: ["notes"] });
    expect(await orders.invalidate(["notes"])).toBe(1);
    expect(await orders.get("q")).toBeUndefined();
    expect(await billing.get("q")).toBe(2);
    await orders.set("q", 3, { ttlMs: 10_000 });
    expect(await orders.clear()).toBe(1);
    expect(await billing.get("q")).toBe(2);
    await billing.clear();
    await orders.close();
    await billing.close();
  });

  test("a write in one app doesn't reach the other app's subscribers, and does reach its other servers", async () => {
    const [orders1, orders2, billing] = await Promise.all([
      RedisBus.connect(url!, { broadcastAll: true, prefix: `t-${run}-orders-bus:` }),
      RedisBus.connect(url!, { broadcastAll: true, prefix: `t-${run}-orders-bus:` }),
      RedisBus.connect(url!, { broadcastAll: true, prefix: `t-${run}-billing-bus:` }),
    ]);
    const orders2Got: string[] = [];
    const billingGot: string[] = [];
    const billingAll: string[] = [];
    orders2.subscribe("notes", (t) => orders2Got.push(t));
    billing.subscribe("notes", (t) => billingGot.push(t));
    billing.subscribe("*", (t) => billingAll.push(t));
    await Promise.all([orders2.ready?.(), billing.ready?.()]);
    await orders1.publish(["notes"]);
    await until(() => orders2Got.length === 1);
    await Bun.sleep(100); // long enough for a delivery that shouldn't happen
    expect(billingGot).toEqual([]);
    expect(billingAll).toEqual([]);
    await Promise.all([orders1.close(), orders2.close(), billing.close()]);
  });

  test("a second app with the same prefix is reported, once the first has been seen; the same app is not", async () => {
    const redis = await connectRedis(url!);
    const prefix = `t-${run}-claim:`;
    expect(await claimPrefix(redis, prefix, "app-one")).toBe(false); // first to use it
    expect(await claimPrefix(redis, prefix, "app-one")).toBe(false); // another server of the same app
    expect(await claimPrefix(redis, prefix, "app-two")).toBe(true); // a different app, or a secret that was rotated
    expect(await claimPrefix(redis, prefix, "app-two")).toBe(false); // it has taken over: a rotation settles
    expect(await claimPrefix(redis, prefix, "app-one")).toBe(true); // while a real clash keeps being reported
    await redis.del(`${prefix}owner`);
    redis.close();
  });
});
