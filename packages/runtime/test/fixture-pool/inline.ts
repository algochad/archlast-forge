// A module that makes a pool from plain functions, as a forge module or a Nest service would: it must never be loaded by a worker.
import { computePool } from "../../src/pool";

if (!Bun.isMainThread) throw new Error("the module that made the pool was loaded in a worker");

const secret = 41; // not visible to the functions below, which run elsewhere

export const work = computePool(
  {
    double: (n: number) => n * 2,
    async lengthOf(text: string) {
      const { createHash } = await import("node:crypto");
      return `${text.length}:${createHash("sha1").update(text).digest("hex").slice(0, 6)}`;
    },
    where: (_: void) => (Bun.isMainThread ? "main" : "worker"),
    leaks: (_: void) => secret + 1,
  },
  { threads: 2 },
);
