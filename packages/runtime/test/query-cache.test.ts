import { describe, expect, test } from "bun:test";
import type { UserIdentity } from "../src/functions";
import { MemoryCache, type Cache } from "../src/server/cache";
import type { FunctionRuntime } from "../src/server/runtime";
import { QueryRunner } from "../src/server/subscriptions";
import { lazyValue } from "../src/server/wire";

type Call = { name: string; args: unknown; identity?: UserIdentity | null; access?: string };

/** A function runtime that answers from memory and records how often it really ran. */
function setup(opts: { delayMs?: number; peruser?: string[]; topics?: string[]; cache?: MemoryCache | null; pinned?: boolean; shared?: string[]; refuse?: string[] } = {}) {
  const calls: Call[] = [];
  let version = 0;
  const runtime = {
    manifest: { functions: [{ name: "todos:list" }, { name: "me:get" }, ...(opts.shared ?? []).map((name) => ({ name, access: true }))] },
    identity: async (headers: Record<string, string>) => (headers.cookie ? ({ userId: headers.cookie, sessionId: "s", email: "", name: headers.cookie } as UserIdentity) : null),
    identityDetail: async (headers: Record<string, string>) => ({ identity: await runtime.identity(headers), ...(opts.pinned && { topics: [`sessions:${headers.cookie}`] }) }),
    call: async (name: string, _kind: string, args: unknown, headers: Record<string, string>, o: { identity?: UserIdentity | null; access?: string } = {}) => {
      calls.push({ name, args, identity: o.identity, access: o.access });
      if (o.access === "only") {
        const who = o.identity && "userId" in o.identity ? String(o.identity.userId) : "";
        if (!who || opts.refuse?.includes(who)) throw new Error("refused");
        return { value: null, topics: [`users:${who}`] };
      }
      const seen = version;
      if (opts.delayMs) await Bun.sleep(opts.delayMs);
      const peruser = opts.peruser?.includes(name);
      const who = peruser ? (o.identity !== undefined ? o.identity : headers.cookie ? { userId: headers.cookie } : null) : undefined;
      return { value: { name, seen, who: who && "userId" in who ? who.userId : null }, topics: opts.topics ?? ["todos"], usedAuth: peruser };
    },
  } as unknown as FunctionRuntime;
  const runner = new QueryRunner(runtime, opts.cache === null ? undefined : (opts.cache ?? new MemoryCache()), 60_000, true);
  return { runner, calls, bump: () => version++ };
}

/** A shared cache like Redis: what is stored is the JSON of the entry, and what comes back is parsed from it. */
class JsonCache implements Cache {
  stored = new Map<string, string>();
  async get<T>(key: string) {
    const raw = this.stored.get(key);
    return raw === undefined ? undefined : (JSON.parse(raw) as T);
  }
  async set(key: string, value: unknown) {
    this.stored.set(key, JSON.stringify(value));
    return true;
  }
  async del(key: string) {
    this.stored.delete(key);
  }
  async invalidate() {
    return 0;
  }
  async clear() {
    const n = this.stored.size;
    this.stored.clear();
    return n;
  }
  stats() {
    return { entries: this.stored.size, bytes: null, evictions: 0 };
  }
  async close() {}
}

describe("a result that crosses from the runtime process as JSON text", () => {
  const sent = { beds: [{ id: 1 }, { id: 2 }] };
  const setupLazy = (cache: Cache) => {
    const parsed = { count: 0 };
    const runtime = {
      manifest: { functions: [{ name: "beds:list" }] },
      call: async () => lazyValue({ topics: ["beds"], json: JSON.stringify(sent) }, () => (parsed.count++, JSON.parse(JSON.stringify(sent)))),
    } as unknown as FunctionRuntime;
    return { runner: new QueryRunner(runtime, cache, 60_000, true), parsed };
  };

  test("is parsed only when its object is read, and once", async () => {
    const { runner, parsed } = setupLazy(new MemoryCache());
    for (let i = 0; i < 3; i++) expect((await runner.run("beds:list", {}, {})).json).toBe(JSON.stringify(sent)); // a miss, then hits: the text is all they use
    expect(parsed.count).toBe(0);
    const r = await runner.run("beds:list", {}, {});
    expect(r.value).toEqual(sent);
    expect(r.value).toBe(r.value);
    expect(parsed.count).toBe(1);
  });

  test("leaves the object out of what a shared cache stores, and still answers `value` from what comes back", async () => {
    const cache = new JsonCache();
    const { runner, parsed } = setupLazy(cache);
    await runner.run("beds:list", {}, {}); // miss: stored
    const [entry] = [...cache.stored.values()];
    expect(JSON.parse(entry!)).toEqual({ topics: ["beds"], clean: true, json: JSON.stringify(sent) }); // one copy of the data, not two
    const hit = await runner.run("beds:list", {}, {});
    expect(hit.json).toBe(JSON.stringify(sent));
    expect(runner.snapshot().hits).toBe(1);
    expect(hit.value).toEqual(sent); // parsed from the entry's JSON
    expect(hit.value).toBe(hit.value);
    expect(parsed.count).toBe(0); // the runtime's own object was never needed
  });

  test("an entry an older server wrote, which has both, is used as it is", async () => {
    const cache = new JsonCache();
    await cache.set("beds:list\u0000{}", { value: sent, topics: ["beds"], clean: true, json: JSON.stringify(sent) });
    const { runner } = setupLazy(cache);
    const hit = await runner.run("beds:list", {}, {}, undefined, "{}");
    expect(hit.value).toEqual(sent);
    expect(runner.snapshot().hits).toBe(1);
  });
});

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

  test("callers waiting on a run that a write overlapped share one new run, instead of each starting their own", async () => {
    const { runner, calls, bump } = setup({ delayMs: 30 });
    const first = runner.run("todos:list", {}, {});
    await Bun.sleep(5);
    const waiting = Array.from({ length: 9 }, () => runner.run("todos:list", {}, {}));
    await Bun.sleep(5);
    bump(); // a write commits while the first run is reading
    runner.invalidated("todos");
    const results = await Promise.all([first, ...waiting]);
    expect(calls.length).toBe(2); // the overlapped run, and one more for all nine waiters
    for (const r of results.slice(1)) expect((r.value as { seen: number }).seen).toBe(1);
  });

  test("queries that read ctx.auth are cached per caller once the first run reveals it", async () => {
    const { runner, calls } = setup({ peruser: ["me:get"] });
    const as = (who?: string) => runner.run("me:get", {}, who ? { cookie: who } : {});
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
    await runner.run("me:get", {}, { cookie: "ada" });
    await runner.reset();
    expect(runner.snapshot().entries).toBe(0);
    await runner.run("todos:list", {}, {});
    expect(calls.length).toBe(3);
    await runner.run("me:get", {}, { cookie: "ada" });
    expect(calls.at(-1)!.identity).toBeUndefined(); // not known to be per-caller again until it runs
  });

  describe("a query with access", () => {
    const options = { shared: ["lists:get"], pinned: true };
    const as = (runner: QueryRunner, who?: string) => runner.run("lists:get", {}, who ? { cookie: who } : {});

    test("runs once for everyone who passes, and each caller's check is kept while what it read is unchanged", async () => {
      const { runner, calls } = setup(options);
      for (const who of ["ada", "bo", "ada", "bo", "ada"]) expect(((await as(runner, who)).value as { name: string }).name).toBe("lists:get");
      expect(calls.filter((c) => c.access === "skip").length).toBe(1); // one run of the handler
      expect(calls.filter((c) => c.access === "only").length).toBe(2); // one check each, then remembered
      expect(calls.filter((c) => c.access === "skip").every((c) => c.identity === undefined)).toBe(true);
      const f = runner.snapshot().functions.find((f) => f.name === "lists:get")!;
      expect([f.misses, f.hits, f.perUser]).toEqual([1, 4, false]);
    });

    test("a write to what the check read ends it, and a refusal is final and not kept", async () => {
      const { runner, calls } = setup({ ...options, refuse: ["bo"] });
      await as(runner, "ada");
      runner.invalidated("users:ada");
      await as(runner, "ada");
      expect(calls.filter((c) => c.access === "only").length).toBe(2);
      await expect(as(runner, "bo")).rejects.toThrow("refused");
      await expect(as(runner, "bo")).rejects.toThrow("refused");
      expect(calls.filter((c) => c.access === "only" && c.identity && "userId" in c.identity && c.identity.userId === "bo").length).toBe(2);
      expect(calls.filter((c) => c.access === "skip").length).toBe(1);
    });

    test("ending the caller's session ends the kept check, and a caller that can't be pinned to topics is checked every time", async () => {
      const pinned = setup(options);
      await as(pinned.runner, "ada");
      pinned.runner.invalidated("sessions:ada");
      await as(pinned.runner, "ada");
      expect(pinned.calls.filter((c) => c.access === "only").length).toBe(2);
      const loose = setup({ shared: ["lists:get"] });
      await as(loose.runner, "ada");
      await as(loose.runner, "ada");
      expect(loose.calls.filter((c) => c.access === "only").length).toBe(2);
    });

    test("the topics of a check reach the observer, so a subscription watches them", async () => {
      const { runner } = setup(options);
      const obs: { access?: string[] } = {};
      await runner.run("lists:get", {}, { cookie: "ada" }, undefined, undefined, obs);
      expect(obs.access).toEqual(["sessions:ada", "users:ada"]);
    });

    test("callers who are signed in are looked up once while their session stands", async () => {
      const { runner } = setup({ ...options, peruser: ["me:get"] });
      const resolved: string[] = [];
      const detail = (runner as unknown as { runtime: { identityDetail: (h: Record<string, string>) => Promise<unknown> } }).runtime.identityDetail;
      (runner as unknown as { runtime: { identityDetail: unknown } }).runtime.identityDetail = (h: Record<string, string>) => (resolved.push(h.cookie!), detail(h));
      await runner.run("me:get", {}, { cookie: "ada" }); // reveals the query reads ctx.auth
      for (let i = 0; i < 3; i++) await runner.run("me:get", {}, { cookie: "ada" });
      expect(resolved).toEqual(["ada"]);
      runner.invalidated("sessions:ada");
      await runner.run("me:get", {}, { cookie: "ada" });
      expect(resolved).toEqual(["ada", "ada"]);
    });
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
