// `@archlast/forge-runtime/pool`: threads for CPU-bound work, on knitting (https://js.knitting.run). A task is a function that takes one value and
// returns one, run on a worker thread; the caller awaits it like any async function, and the server's event loop stays free meanwhile.
//
// Put the tasks in a module of their own, with few imports: every worker imports it again, and its top-level imports run in each worker. Define
// each with `task({ f })`, which is how the workers learn which module it is in (a bare exported function is looked up in the module that
// calls `createPool`, and `computePool` is in this one).
//
//   // forge/_work/hash.ts
//   import { task } from "@archlast/forge-runtime/pool";
//   export const digest = task({ f: (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
//
//   // forge/files.ts
//   import { computePool } from "@archlast/forge-runtime/pool";
//   import * as hash from "./_work/hash";
//   const work = computePool(hash);
//   export const checksum = action({ handler: async (ctx, { id }) => work.call.digest(await readFile(id)) });
//
// What a task must not do: use `ctx`, a transaction or the database. They belong to the thread that called, and a read made elsewhere is not
// part of the call's snapshot and records no topics, so live queries would not see it. Do the work in a task, then write from the action:
// action -> pool -> `ctx.runMutation`. A mutation should not wait on the pool: it holds the writer (SQLite) or a transaction (Postgres) meanwhile.
// A timeout (`task({ f, timeout })`) bounds the wait, not the work.
import { createPool, importTask, isMain, task } from "knitting";
import { serverCores } from "./server/cores";

export { createPool, importTask, isMain, task };

type Tasks = Parameters<ReturnType<typeof createPool>>[0];
type PoolOptions = Parameters<typeof createPool>[0];
type Fn<X> = X extends { readonly f: infer F } ? F : X;
/** What `pool.call` has for each task: its function, taking the argument or a Promise of it, and answering with a Promise. */
export type Calls<T> = { readonly [K in keyof T]: Fn<T[K]> extends (arg: infer A, ...rest: any[]) => infer R ? (arg: A | Promise<A>) => Promise<Awaited<R>> : never };

export interface ComputePool<T extends Tasks> {
  /** The tasks, as async functions: `await pool.call.digest(bytes)`. The threads start with the first call. */
  readonly call: Calls<T>;
  /** Ends the threads once the calls under way are done. A later call starts new ones. */
  shutdown(): Promise<void>;
}

/**
 * Threads for `tasks`, started with the first call and kept for the life of the process. The default is one thread fewer than the cores this
 * process may use (the container's CPU quota counts), at least one, so the server keeps a core; `options.threads` sets it.
 */
export function computePool<T extends Tasks>(tasks: T, options: PoolOptions = {}): ComputePool<T> {
  let pool: { call: unknown; shutdown(): Promise<void> } | undefined;
  const started = () => (pool ??= createPool({ threads: Math.max(1, serverCores() - 1), ...options })(tasks));
  return {
    get call() {
      return started().call as Calls<T>;
    },
    async shutdown() {
      const p = pool;
      pool = undefined;
      await p?.shutdown();
    },
  };
}
