import { afterAll, describe, expect, test } from "bun:test";
import { computePool } from "../src/pool";
import { work as inline } from "./fixture-pool/inline";
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

  test("a pool made from plain functions, in a module that is not a task module and has no isMain guard", async () => {
    expect(await inline.call.double(21)).toBe(42);
    expect(await inline.call.lengthOf("hello")).toBe("5:aaf4c6");
    expect(await inline.call.where()).toBe("worker");
    const all = await Promise.all(Array.from({ length: 100 }, (_, i) => inline.call.double(i)));
    expect(all.every((r, i) => r === i * 2)).toBe(true);
    await inline.shutdown();
  });

  test("a plain function that uses a variable of its file fails with a message that says what to do", async () => {
    await expect(inline.call.leaks()).rejects.toThrow(/secret is not defined.*import what it needs inside it/);
    await inline.shutdown();
  });

  test("plain functions and task modules can be mixed, and a bound function is refused", async () => {
    const mixed = computePool({ triple: (n: number) => n * 3, square: tasks.square }, { threads: 1 });
    expect(await mixed.call.triple(4)).toBe(12);
    expect(await mixed.call.square(4)).toBe(16);
    await mixed.shutdown();
    expect(() => computePool({ bound: ((n: number) => n).bind(null) }).call.bound(1)).toThrow(/no source/);
  });
});
