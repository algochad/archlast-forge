import { describe, expect, test } from "bun:test";
import { MemoryBus, RedisBus, type Bus } from "../src/server/bus";

const adapters: [string, () => Promise<Bus>][] = [
  ["memory", async () => new MemoryBus()],
  ...(process.env.TEST_REDIS_URL ? ([["redis", () => RedisBus.connect(process.env.TEST_REDIS_URL!, { broadcastAll: true })]] as [string, () => Promise<Bus>][]) : []),
];

const until = async (cond: () => boolean, ms = 2000) => {
  for (const end = Date.now() + ms; !cond(); ) {
    if (Date.now() > end) throw new Error("timed out");
    await Bun.sleep(5);
  }
};

for (const [label, make] of adapters) {
  describe(`Bus contract: ${label}`, () => {
    test("delivers published topics to topic and wildcard subscribers", async () => {
      const bus = await make();
      const got: string[] = [];
      const all: string[] = [];
      const off = bus.subscribe("todos", (t) => got.push(t));
      bus.subscribe("*", (t) => all.push(t));
      await bus.ready?.();
      await bus.publish(["todos", "lists"]);
      await until(() => all.length === 2);
      expect(got).toEqual(["todos"]);
      off();
      await bus.publish(["todos"]);
      await until(() => all.length === 3);
      expect(got).toEqual(["todos"]);
      await bus.close();
    });

    if (label === "redis")
      test("reaches subscribers on another server", async () => {
        const [a, b] = [await make(), await make()];
        const got: string[] = [];
        const other: string[] = [];
        b.subscribe("todos:by_list:[\"lists:1\"]", (t) => got.push(t));
        b.subscribe("lists", (t) => other.push(t));
        await b.ready?.();
        await a.publish(['todos:by_list:["lists:1"]', 'todos:by_list:["lists:2"]']);
        await until(() => got.length === 1);
        await Bun.sleep(50);
        expect(other).toEqual([]); // per-topic channels: only subscribed topics arrive
        await a.close();
        await b.close();
      });
  });
}

test("RedisBus fails fast when Redis is unreachable", async () => {
  await expect(RedisBus.connect("redis://127.0.0.1:1")).rejects.toThrow("unreachable");
});
