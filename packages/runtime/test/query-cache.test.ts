import { describe, expect, test } from "bun:test";
import type { UserIdentity } from "../src/functions";
import { MemoryCache } from "../src/server/cache";
import type { FunctionRuntime } from "../src/server/runtime";
import { QueryRunner } from "../src/server/subscriptions";

type Call = { name: string; args: unknown; identity?: UserIdentity | null };

/** A function runtime that answers from memory and records how often it really ran. */
function setup(opts: { delayMs?: number; peruser?: string[]; topics?: string[]; cache?: MemoryCache | null } = {}) {
  const calls: Call[] = [];
  let version = 0;
  const runtime = {
    manifest: { functions: [{ name: "todos:list" }, { name: "me:get" }] },
    identity: async (headers: Record<string, string>) => (headers.who ? ({ userId: headers.who, sessionId: "s", email: "", name: headers.who } as UserIdentity) : null),
    call: async (name: string, _kind: string, args: unknown, headers: Record<string, string>, o: { identity?: UserIdentity | null } = {}) => {
      calls.push({ name, args, identity: o.identity });
      const seen = version;
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      const peruser = opts.peruser?.includes(name);
      const who = peruser ? (o.identity !== undefined ? o.identity : headers.who ? { userId: headers.who } : null) : undefined;
      return { value: { name, seen, who: who && "userId" in who ? who.userId : null }, topics: opts.topics ?? ["todos"], usedAuth: peruser };
    },
  } as unknown as FunctionRuntime;
  const runner = new QueryRunner(runtime, opts.cache === null ? undefined : (opts.cache ?? new MemoryCache()), 60_000, true);
  return { runner, calls, bump: () => version++ };
}

describe("QueryRunner cache", () => {
  test("the second identical call is a hit; different args are separate entries", async () => {
    const { runner, calls } = setup();
    await runner.run("todos:list", { a: 1 }, {});
    await runner.run("todos:list", { a: 1 }, {});
    await runner.run("todos:list", { a: 2 }, {});
    expect(calls.length).toBe(2);
    const s = runner.snapshot();
    expect([s.hits, s.misses, s.coalesced]).toEqual([1, 2, 0]);
    expect(s.entries).toBe(2);
    expect(s.functions[0]!.name).toBe("todos:list");
  });

  test("a write to a topic the result read evicts it", async () => {
    const { runner, calls } = setup();
    await runner.run("todos:list", {}, {});
    runner.invalidated("unrelated");
    await runner.run("todos:list", {}, {});
    expect(calls.length).toBe(1);
    runner.invalidated("todos");
    await runner.run("todos:list", {}, {});
    expect(calls.length).toBe(2);
    expect(runner.snapshot().invalidatedEntries).toBe(1);
  });

  test("concurrent identical calls share one execution", async () => {
    const { runner, calls } = setup({ delayMs: 40 });
    const results = await Promise.all(Array.from({ length: 5 }, () => runner.run("todos:list", {}, {})));
    expect(calls.length).toBe(1);
    expect(new Set(results.map((r) => JSON.stringify(r.value))).size).toBe(1);
    const s = runner.snapshot();
    expect([s.misses, s.coalesced]).toEqual([1, 4]);
  });

  test("without a cache, identical calls still share one execution and its JSON, but never a run a write overlapped", async () => {
    const { runner, calls, bump } = setup({ delayMs: 40, cache: null });
    const results = await Promise.all(Array.from({ length: 5 }, () => runner.run("todos:list", {}, {})));
    expect(calls.length).toBe(1);
    expect(new Set(results.map((r) => r.json)).size).toBe(1);
    const first = runner.run("todos:list", {}, {});
    await Bun.sleep(10);
    bump();
    runner.invalidated("todos");
    const second = await runner.run("todos:list", {}, {});
    await first;
    expect(calls.length).toBe(3);
    expect((second.value as { seen: number }).seen).toBe(1);
  });

  test("a call woken by a write never shares a run the write overlapped", async () => {
    const { runner, calls, bump } = setup({ delayMs: 60 });
    const first = runner.run("todos:list", {}, {});
    await Bun.sleep(10);
    bump(); // the mutation commits while the first run is reading…
    runner.invalidated("todos"); // …and announces itself
    const second = await runner.run("todos:list", {}, {}); // woken by that write
    await first;
    expect(calls.length).toBe(2); // it ran again instead of joining the stale run
    expect((second.value as { seen: number }).seen).toBe(1);
    // and the stale run's result was not kept
    const third = await runner.run("todos:list", {}, {});
    expect((third.value as { seen: number }).seen).toBe(1);
  });

  test("queries that read ctx.auth are cached per caller once the first run reveals it", async () => {
    const { runner, calls } = setup({ peruser: ["me:get"] });
    const as = (who?: string) => runner.run("me:get", {}, who ? { who } : {});
    await as("ada"); // unknown to be per-caller: runs, isn't kept
    expect(runner.snapshot().entries).toBe(0);
    expect(((await as("ada")).value as { who: string }).who).toBe("ada"); // keyed now: miss, stored
    expect(((await as("ada")).value as { who: string }).who).toBe("ada"); // hit
    expect(((await as("bo")).value as { who: string }).who).toBe("bo"); // someone else never sees ada's entry
    expect(((await as()).value as { who: string | null }).who).toBeNull(); // nor does an anonymous caller
    expect(calls.length).toBe(4);
    const s = runner.snapshot();
    expect(s.hits).toBe(1);
    expect(s.functions.find((f) => f.name === "me:get")!.perUser).toBe(true);
    // the identity was resolved once and handed to the function, not resolved again
    expect(calls.slice(1).every((c) => c.identity !== undefined)).toBe(true);
  });

  test("reset forgets cached results and which queries are per-caller", async () => {
    const { runner, calls } = setup({ peruser: ["me:get"] });
    await runner.run("todos:list", {}, {});
    await runner.run("me:get", {}, { who: "ada" });
    await runner.reset();
    expect(runner.snapshot().entries).toBe(0);
    await runner.run("todos:list", {}, {});
    expect(calls.length).toBe(3);
    await runner.run("me:get", {}, { who: "ada" });
    expect(calls.at(-1)!.identity).toBeUndefined(); // not known to be per-caller again until it runs
  });

  test("results too big for the cache count as skipped, not hits", async () => {
    const { runner, calls } = setup({ cache: new MemoryCache(10, 100) });
    await runner.run("todos:list", {}, {});
    await runner.run("todos:list", {}, {});
    expect(calls.length).toBe(2);
    const s = runner.snapshot();
    expect([s.hits, s.misses, s.skipped]).toEqual([0, 2, 2]);
  });

  test("calls to functions that don't exist are not counted", async () => {
    const { runner } = setup();
    await runner.run("nope:nothing", {}, {});
    expect(runner.snapshot().functions).toEqual([]);
  });

  test("with the cache off every call runs and nothing is counted", async () => {
    const calls: unknown[] = [];
    const runtime = { manifest: { functions: [{ name: "todos:list" }] }, call: async () => (calls.push(1), { value: 1, topics: ["todos"] }) } as unknown as FunctionRuntime;
    const runner = new QueryRunner(runtime, undefined, 0);
    await runner.run("todos:list", {}, {});
    await runner.run("todos:list", {}, {});
    expect(calls.length).toBe(2);
    expect(runner.snapshot()).toMatchObject({ enabled: false, hits: 0, misses: 0 });
  });
});
