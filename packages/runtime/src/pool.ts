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
// A pool can also be made anywhere, with no task module and no `isMain` guard, from plain functions that need nothing but their argument (no variable,
// import or helper of the file around them; import inside the function with `await import("node:crypto")`). Their source goes to a small module of its own
// (in the temp folder), and that is all a worker loads, so the file that made the pool is never run again in a thread: a Nest service with decorators, or
// a forge module with side effects, is fine.
//
//   const work = computePool({ digest: (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex") });
//   const hex = await work.call.digest(bytes);
//
// What a task must not do: use `ctx`, a transaction or the database. They belong to the thread that called, and a read made elsewhere is not
// part of the call's snapshot and records no topics, so live queries would not see it. Do the work in a task, then write from the action:
// action -> pool -> `ctx.runMutation`. A mutation should not wait on the pool: it holds the writer (SQLite) or a transaction (Postgres) meanwhile.
// A timeout (`task({ f, timeout })`) bounds the wait, not the work.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPool, importTask, isMain, task } from "knitting";
import { serverCores } from "./server/cores";

export { createPool, importTask, isMain, task };

type Tasks = Parameters<ReturnType<typeof createPool>>[0] | Record<string, (arg: any) => unknown>;
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

const isModule = (x: unknown) => Object.prototype.toString.call(x) === "[object Module]";

/**
 * Plain functions in `tasks` become tasks of a generated module that holds only their source, so a worker never loads the file that made the pool. The
 * module is named by a hash of its content: the same functions are written once, and another process finds it there.
 */
function materialize<T extends Tasks>(tasks: T): T {
  if (isModule(tasks)) return tasks;
  const plain = Object.entries(tasks).filter(([, v]) => typeof v === "function");
  if (!plain.length) return tasks;
  // each is exported under the caller's name: the workers number tasks by name
  const lines = plain.map(([name, fn], i) => {
    const src = Function.prototype.toString.call(fn);
    if (/\{\s*\[native code\]\s*\}\s*$/.test(src)) throw new TypeError(`computePool: ${name} is a built-in or bound function, which has no source to send to a worker`);
    // `{ digest(x) { … } }` gives the method's text, which is not an expression by itself
    let expression = `(${src})`;
    try {
      new Function(`return ${expression}`);
    } catch {
      expression = `({ ${src} })[${JSON.stringify(src.match(/^(?:async\s+)?(?:\*\s*)?([\w$]+)/)?.[1] ?? name)}]`;
    }
    return `const k${i} = task({ f: ${expression} });\nexport { k${i} as ${JSON.stringify(name)} };`;
  });
  const code = `import { task } from ${JSON.stringify(import.meta.url)};\n${lines.join("\n")}\n`;
  const dir = join(tmpdir(), `archlast-forge-pool-${process.getuid?.() ?? 0}`);
  const file = join(dir, `${createHash("sha256").update(code).digest("hex").slice(0, 24)}.mjs`);
  if (!existsSync(file)) {
    mkdirSync(dir, { recursive: true });
    const part = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}`;
    writeFileSync(part, code);
    renameSync(part, file); // whole or not there, for a process that starts in the same moment
  }
  const generated = require(file) as Record<string, unknown>;
  const out: Record<string, unknown> = { ...tasks };
  for (const [name] of plain) out[name] = generated[name];
  return out as T;
}

/** A task that cannot see a variable of the file it was written in says so in words that name the way out. */
function explain(e: unknown): unknown {
  if (e instanceof Error && /\bis not defined\b/.test(e.message) && !e.message.includes("computePool"))
    e.message += " (a function given to computePool runs in a worker and sees only its own argument: import what it needs inside it, or put it in a module with `task({ f })`)";
  return e;
}

/**
 * Threads for `tasks`, started with the first call and kept for the life of the process. The default is one thread fewer than the cores this
 * process may use (the container's CPU quota counts), at least one, so the server keeps a core; `options.threads` sets it.
 */
export function computePool<T extends Tasks>(tasks: T, options: PoolOptions = {}): ComputePool<T> {
  let pool: { call: unknown; shutdown(): Promise<void> } | undefined;
  const started = () => (pool ??= createPool({ threads: Math.max(1, serverCores() - 1), ...options })(materialize(tasks)));
  let calls: Calls<T> | undefined;
  return {
    get call() {
      return (calls ??= new Proxy({} as Calls<T>, {
        get: (_, name: string) => (arg: unknown) => ((started().call as Record<string, (a: unknown) => Promise<unknown>>)[name]!(arg) as Promise<unknown>).catch((e) => Promise.reject(explain(e))),
      }));
    },
    async shutdown() {
      const p = pool;
      pool = undefined;
      await p?.shutdown();
    },
  };
}
