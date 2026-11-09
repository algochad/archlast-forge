// Tasks for pool.test.ts: a module of its own, as the real ones should be. Each is `task({ f })`, which records this module for the workers.
import { task } from "../../src/pool";

export const square = task({ f: (n: number) => n * n });
export const sum = task({ f: ([a, b]: [number, number]) => a + b });
export const where = task({ f: (_: void) => (Bun.isMainThread ? "main" : "worker") });
export const fail = task({
  f: (message: string): number => {
    throw new Error(message);
  },
});
