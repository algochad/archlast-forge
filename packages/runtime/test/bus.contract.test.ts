import { describe, expect, test } from "bun:test";
import { MemoryBus, RedisBus, type Bus } from "../src/server/bus";

const adapters: [string, () => Promise<Bus>][] = [
  ["memory", async () => new MemoryBus()],
  ...(process.env.TEST_REDIS_URL ? ([["redis", () => RedisBus.connect(process.env.TEST_REDIS_URL!)]] as [string, () => Promise<Bus>][]) : []),
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
        b.subscribe("todos:by_list:[\"lists:1\"]", (t) => got.push(t));
        await a.publish(['todos:by_list:["lists:1"]']);
        await until(() => got.length === 1);
        await a.close();
        await b.close();
      });
  });
}

test("RedisBus fails fast when Redis is unreachable", async () => {
  await expect(RedisBus.connect("redis://127.0.0.1:1")).rejects.toThrow("unreachable");
});
