import { afterAll, describe, expect, test } from "bun:test";
import { computePool } from "../src/pool";
import * as tasks from "./fixture-pool/tasks";

describe("@archlast/forge-runtime/pool", () => {
  const work = computePool(tasks, { threads: 2 });
  afterAll(() => work.shutdown());

  test("a task runs on a worker thread and its result comes back", async () => {
    expect(await work.call.square(12)).toBe(144);
    expect(await work.call.sum([2, 3])).toBe(5);
    expect(await work.call.where()).toBe("worker");
  });

  test("calls run in parallel and keep their own results", async () => {
    const results = await Promise.all(Array.from({ length: 200 }, (_, i) => work.call.square(i)));
    expect(results.every((r, i) => r === i * i)).toBe(true);
  });

  test("a task that throws rejects with its message", async () => {
    await expect(work.call.fail("nope")).rejects.toThrow("nope");
    expect(await work.call.square(3)).toBe(9); // the pool is still there
  });

  test("shutdown ends the threads and a later call starts new ones", async () => {
    const again = computePool(tasks, { threads: 1 });
    expect(await again.call.square(4)).toBe(16);
    await again.shutdown();
    expect(await again.call.square(5)).toBe(25);
    await again.shutdown();
  });
});
