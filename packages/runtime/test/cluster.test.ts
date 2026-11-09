import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { nativeEngine } from "../src/server/engine";
import { nativeDb } from "../src/server/db/native";
import { clusterSizeFor, runtimeWorkersPerServer } from "../src/server/cluster";
import { addAdmin } from "../src/server/admin-ops";
import { createSqliteDb } from "../src/server/db/sqlite";
import { migrateSystem } from "../src/server/system";
import { tempDir } from "./helpers";

// A cluster: several servers of one app on one machine, sharing the port, one SQLite file and the native database layer. These start the CLI as a user does
// (`archlast-forge start` with SERVER_PROCESSES) and ask what must hold: both servers answer, no write is lost between them, a write by one is seen by the other, what each
// records reaches the first server's dashboard, a server that dies comes back, and stopping the first stops all.
const cli = join(import.meta.dir, "../../cli/src/index.ts");
const fixture = join(import.meta.dir, "fixture-cluster");
const ADMIN = "k".repeat(32);
const capable = Boolean(nativeDb()) && process.platform === "linux";

const GiB = 1024 ** 3;

test("two servers from 4 cores, one below, and fewer when they would not fit in memory", () => {
  expect([1, 2, 3, 4, 5, 6, 8, 12, 16, 64].map((c) => clusterSizeFor(c))).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 2, 2]);
  expect(clusterSizeFor(8, 2 * GiB)).toBe(2);
  expect(clusterSizeFor(8, 0.5 * GiB)).toBe(1); // (two would not fit beside each other)
  expect(clusterSizeFor(16, 0.25 * GiB)).toBe(1);
});

test("runtime processes per server: `auto` shares the cores among the servers, a number is each server's own", () => {
  const auto = (cores: number) => ({ workers: Math.max(1, Math.floor(cores * 0.5)), auto: true });
  // 4 cores: the runtime stays inline in each server; 8 cores: two processes each; 16: four each
  expect([4, 8, 16].map((c) => runtimeWorkersPerServer(auto(c), 2))).toEqual([1, 2, 4]);
  expect(runtimeWorkersPerServer(auto(16), 2, 1 * GiB)).toBe(1); // (memory short: the servers first, the runtime inline)
  expect(runtimeWorkersPerServer({ workers: 3, auto: false }, 2)).toBe(3);
});

const freePort = () => {
  const s = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = s.port!;
  s.stop(true);
  return port;
};

interface Running {
  url: string;
  data: string;
  proc: ReturnType<typeof Bun.spawn>;
  /** A request on a connection of its own, which the kernel gives to one of the servers. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  stop(): Promise<void>;
}

async function start(env: Record<string, string> = {}, processes = 2, data = tempDir()): Promise<Running> {
  const port = freePort();
  const proc = Bun.spawn(["bun", cli, "start", "--no-docker", "--dir", fixture], {
    env: { ...process.env, PORT: String(port), DATA_DIR: data, SERVER_PROCESSES: String(processes), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "0", ADMIN_KEY: ADMIN, DASHBOARD: "on", DB_ENGINE: "native", LOG_LEVEL: "warn", ...env },
    stdout: "ignore",
    stderr: "ignore",
  });
  const url = `http://127.0.0.1:${port}`;
  const request = (path: string, init: RequestInit = {}) => fetch(`${url}${path}`, { ...init, headers: { connection: "close", ...init.headers } });
  const running: Running = {
    url,
    data,
    proc,
    fetch: request,
    async stop() {
      proc.kill("SIGTERM");
      await Promise.race([proc.exited, Bun.sleep(20_000)]);
      proc.kill("SIGKILL");
    },
  };
  // up when every server has answered
  const until = Date.now() + 40_000;
  const seen = new Set<number>();
  while (Date.now() < until && seen.size < processes) {
    try {
      const r = await request("/http/who", { headers: { "x-forwarded-for": "10.9.9.9" } }); // (the probe is a client of its own, for the rate limit's sake)
      if (r.ok) seen.add(((await r.json()) as { index: number }).index);
    } catch {}
    await Bun.sleep(50);
  }
  if (seen.size < processes) {
    await running.stop();
    throw new Error(`only ${[...seen]} of ${processes} servers came up`);
  }
  return running;
}

const who = async (c: Running) => (await (await c.fetch("/http/who")).json()) as { index: number; pid: number };

describe.skipIf(!capable)("a cluster of servers on one database", () => {
  let c: Running;
  beforeAll(async () => {
    if (!(await nativeEngine())) return;
    c = await start();
  }, 60_000);
  afterAll(async () => c?.stop());

  test("both servers answer requests", async () => {
    const pids = new Set<number>();
    for (let i = 0; i < 60; i++) pids.add((await who(c)).pid);
    expect(pids.size).toBe(2);
  });

  test("no update is lost between the servers: 300 concurrent read-modify-writes add up to 300", async () => {
    const results = await Promise.all(Array.from({ length: 300 }, () => c.fetch("/http/inc", { method: "POST" })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await (await c.fetch("/http/count")).json()).toBe(300);
    // every server reads the same, whichever it is
    const counts = new Set<unknown>();
    for (let i = 0; i < 20; i++) counts.add(await (await c.fetch("/http/count")).json());
    expect([...counts]).toEqual([300]);
  });

  test("read your writes: with the read caches on, a read after a write sees it whichever server each went to", async () => {
    const count = async () => (await (await c.fetch("/http/count")).json()) as number;
    const base = await count();
    let crossed = 0;
    let last = -1;
    for (let i = 1; i <= 150; i++) {
      const wrote = await (await c.fetch("/http/who")).json().then((w) => (w as { pid: number }).pid); // (which server a connection reaches is the kernel's: the pids tell how often the pair crossed)
      await c.fetch("/http/inc", { method: "POST" });
      expect(await count()).toBe(base + i);
      const read = (await (await c.fetch("/http/who")).json()) as { pid: number };
      if (read.pid !== wrote) crossed++;
      last = base + i;
    }
    expect(last).toBe(base + 150);
    expect(crossed).toBeGreaterThan(20); // the pairs did go to both servers
  }, 60_000);

  test("a write through one server is seen by the next read through the other, cached queries included", async () => {
    const call = async (fn: string, body: object = {}) => ((await (await c.fetch(`/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json()) as { result: number }).result;
    const read = async () => ((await (await c.fetch(`/rpc/counter:get?args=${encodeURIComponent(JSON.stringify({ name: "seen" }))}`)).json()) as { result: number }).result;
    for (let i = 1; i <= 40; i++) {
      await call("counter:inc", { name: "seen" });
      // the query is cached by the server that ran it; the write was committed by whichever server took it, and the bus told them all
      for (let tries = 0; tries < 50 && (await read()) !== i; tries++) await Bun.sleep(20);
      expect(await read()).toBe(i);
    }
  });

  test("what each server records reaches the first server's dashboard", async () => {
    const before = 60;
    const get = async () => {
      const r = await c.fetch(`/_admin/obs.requests?input=${encodeURIComponent(JSON.stringify({ from: Date.now() - 3600_000, to: Date.now() + 60_000 }))}`, { headers: { "x-admin-key": ADMIN } });
      return ((await r.json()) as { operations: { kind: string; operation: string; count: number }[] }).operations;
    };
    // the admin API answers from either server (the second passes it on)
    for (let i = 0; i < 12; i++) expect((await c.fetch("/_admin/me", { headers: { "x-admin-key": ADMIN } })).status).toBe(200);
    let counted = 0;
    for (let i = 0; i < 60 && counted < before; i++) {
      counted = (await get()).filter((o) => o.kind === "http" && o.operation === "GET /who").reduce((a, o) => a + o.count, 0);
      if (counted < before) await Bun.sleep(250);
    }
    expect(counted).toBeGreaterThanOrEqual(before); // requests the first and the second server answered, counted in one place
  });

  test("/metrics counts what every server did", async () => {
    const calls = async () => {
      const text = await (await c.fetch("/metrics", { headers: { authorization: `Bearer ${ADMIN}` } })).text();
      return Number(/forge_function_calls_total\{function="counter:inc"\} (\d+)/.exec(text)?.[1] ?? 0);
    };
    // the other servers tell the first every two seconds: wait until what earlier tests did has arrived
    let before = await calls();
    for (;;) {
      await Bun.sleep(2300);
      const again = await calls();
      if (again === before) break;
      before = again;
    }
    await Promise.all(Array.from({ length: 30 }, () => c.fetch("/rpc/counter:inc", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "metrics" }) })));
    let after = before;
    for (let i = 0; i < 40 && after - before < 30; i++) {
      await Bun.sleep(250); // the others tell the first every two seconds
      after = await calls();
    }
    expect(after - before).toBe(30);
  }, 30_000);

  test("a server that dies is started again, and the app keeps answering", async () => {
    let second: { index: number; pid: number } | undefined;
    for (let i = 0; i < 100 && second?.index !== 1; i++) second = await who(c);
    expect(second?.index).toBe(1);
    process.kill(second!.pid, "SIGKILL");
    // requests keep being answered meanwhile
    let answered = 0;
    let again: number | undefined;
    const until = Date.now() + 30_000;
    while (Date.now() < until && again === undefined) {
      const w = await who(c).catch(() => undefined);
      if (w) {
        answered++;
        if (w.index === 1 && w.pid !== second!.pid) again = w.pid;
      }
      await Bun.sleep(20);
    }
    expect(answered).toBeGreaterThan(10);
    expect(again).toBeDefined();
  }, 45_000);

  test("stopping the first server stops them all and removes the sockets", async () => {
    const pids = new Set<number>();
    for (let i = 0; i < 80; i++) pids.add((await who(c)).pid);
    expect(pids.size).toBe(2);
    c.proc.kill("SIGTERM");
    await Promise.race([c.proc.exited, Bun.sleep(20_000)]);
    await Bun.sleep(500);
    for (const pid of pids) expect(() => process.kill(pid, 0)).toThrow();
    expect(existsSync(join(c.data, ".cluster", "hub.sock"))).toBe(false);
  }, 40_000);
});

describe.skipIf(!capable)("restarting a cluster", () => {
  test("the dashboard's Restart stops the other servers and starts the cluster again, data kept", async () => {
    if (!(await nativeEngine())) return;
    const data = tempDir();
    const db = createSqliteDb(join(data, "app.db"));
    await migrateSystem(db);
    await addAdmin(db, "owner@example.com", "owner-password-123", "owner");
    await db.close();
    const c = await start({}, 2, data);
    try {
      const login = await c.fetch("/_admin/login", { method: "POST", headers: { "content-type": "application/json", "x-forge-admin": "1", origin: c.url }, body: JSON.stringify({ email: "owner@example.com", password: "owner-password-123" }) });
      expect(login.status).toBe(200);
      const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
      await c.fetch("/http/inc", { method: "POST" });
      const before = new Set<number>();
      for (let i = 0; i < 80; i++) before.add((await who(c)).pid);
      expect(before.size).toBe(2);
      const r = await c.fetch("/_admin/restart", { method: "POST", headers: { cookie, "x-forge-admin": "1", "content-type": "application/json", origin: c.url }, body: "{}" });
      expect(r.status).toBe(200);
      // both servers are new processes (the first stays the CLI's own: it restarts in place), and the app answers again
      const now = new Set<number>();
      const until = Date.now() + 40_000;
      while (Date.now() < until && now.size < 2) {
        const w = await who(c).catch(() => undefined);
        if (w && (w.index === 1 ? !before.has(w.pid) : true)) now.add(w.pid);
        await Bun.sleep(30);
      }
      expect(now.size).toBe(2);
      for (const pid of before) if (pid !== c.proc.pid) expect(now.has(pid)).toBe(false);
      expect(await (await c.fetch("/http/count")).json()).toBe(1); // the data is where it was
    } finally {
      await c.stop();
    }
  }, 90_000);
});

describe.skipIf(!capable)("reloading a cluster", () => {
  // `env set` and `env rm` change what the next load of the function runtime reads, and the CLI asks the first server (SIGHUP) to reload: every server must follow, with its
  // caches (the native read cache, the query cache) still right afterwards.
  test("a reload on the first server reaches the others: a stored variable is read by every server, and the caches keep up with writes after it", async () => {
    if (!(await nativeEngine())) return;
    const data = tempDir();
    const withDb = async <T>(fn: (db: ReturnType<typeof createSqliteDb>) => Promise<T>) => {
      const db = createSqliteDb(join(data, "app.db"));
      try {
        return await fn(db);
      } finally {
        await db.close();
      }
    };
    await withDb((db) => migrateSystem(db));
    const c = await start({}, 2, data);
    const flags = async () => {
      const seen = new Map<number, string | null>();
      for (let i = 0; i < 80; i++) {
        const r = (await (await c.fetch("/http/env")).json()) as { flag: string | null; pid: number };
        seen.set(r.pid, r.flag);
      }
      return seen;
    };
    const reloaded = async (flag: string | null) => {
      c.proc.kill("SIGHUP");
      const until = Date.now() + 30_000;
      while (Date.now() < until) {
        const seen = await flags().catch(() => new Map<number, string | null>());
        if (seen.size === 2 && [...seen.values()].every((f) => f === flag)) return seen;
        await Bun.sleep(100);
      }
      return flags();
    };
    try {
      expect([...(await flags()).values()]).toEqual([null, null]);
      await withDb(async (db) => db.execute(`INSERT INTO "_env" ("name", "value", "updatedAt") VALUES ('CLUSTER_FLAG', 'on', 0)`));
      expect([...(await reloaded("on")).values()]).toEqual(["on", "on"]); // (both servers, not only the one that got the signal)
      // the caches after a reload: a cached query and the read cache see every write, whichever server took it
      const call = async (fn: string, body: object = {}) => c.fetch(`/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const read = async () => ((await (await c.fetch(`/rpc/counter:get?args=${encodeURIComponent(JSON.stringify({ name: "after" }))}`)).json()) as { result: number }).result;
      for (let i = 1; i <= 40; i++) {
        expect((await call("counter:inc", { name: "after" })).ok).toBe(true);
        for (let tries = 0; tries < 50 && (await read()) !== i; tries++) await Bun.sleep(20);
        expect(await read()).toBe(i);
      }
      const total = await Promise.all(Array.from({ length: 100 }, () => c.fetch("/http/inc", { method: "POST" })));
      expect(total.every((r) => r.ok)).toBe(true);
      expect(await (await c.fetch("/http/count")).json()).toBe(100);
      // and a variable removed is gone from both
      await withDb(async (db) => db.execute(`DELETE FROM "_env" WHERE "name" = 'CLUSTER_FLAG'`));
      expect([...(await reloaded(null)).values()]).toEqual([null, null]);
      expect(await (await c.fetch("/http/count")).json()).toBe(100); // the data is where it was
    } finally {
      await c.stop();
    }
  }, 120_000);
});

describe.skipIf(!capable)("a cluster whose servers run their functions in runtime processes", () => {
  // RUNTIME_WORKERS above 1 gives every server a pool of runtime processes of its own (restarted alone, killed when stuck), beside the other server's: the processes
  // share the one SQLite file, so their writes, their caches and their wake-ups for the write lock have to work across all of them.
  let c: Running;
  const pids = async (n = 150) => {
    const seen = new Map<number, number>(); // pid -> server index
    for (let i = 0; i < n; i++) {
      const w = await who(c);
      seen.set(w.pid, w.index);
    }
    return seen;
  };
  beforeAll(async () => {
    if (!(await nativeEngine())) return;
    c = await start({ RUNTIME_WORKERS: "2", ACTION_TIMEOUT_MS: "1000" }, 2);
  }, 90_000);
  afterAll(async () => c?.stop());

  test("both servers answer, each from its own runtime processes", async () => {
    const seen = await pids();
    expect(new Set(seen.values())).toEqual(new Set([0, 1]));
    expect(seen.size).toBeGreaterThan(2); // (more processes than servers: the requests were run by the runtime processes)
    expect(seen.has(c.proc.pid)).toBe(false); // (and none by the server process itself)
  });

  test("no update is lost between the processes, and reads see every write", async () => {
    const results = await Promise.all(Array.from({ length: 300 }, () => c.fetch("/http/inc", { method: "POST" })));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(await (await c.fetch("/http/count")).json()).toBe(300);
    const call = async (fn: string, body: object) => c.fetch(`/rpc/${fn}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const read = async () => ((await (await c.fetch(`/rpc/counter:get?args=${encodeURIComponent(JSON.stringify({ name: "p" }))}`)).json()) as { result: number }).result;
    for (let i = 1; i <= 30; i++) {
      expect((await call("counter:inc", { name: "p" })).ok).toBe(true);
      for (let tries = 0; tries < 50 && (await read()) !== i; tries++) await Bun.sleep(20);
      expect(await read()).toBe(i);
    }
  }, 60_000);

  test("a runtime process that dies is replaced, and a stuck one is killed alone", async () => {
    const before = await pids(100);
    const victim = [...before.keys()][0]!;
    process.kill(victim, "SIGKILL");
    let after = new Map<number, number>();
    for (let i = 0; i < 40; i++) {
      after = await pids(60).catch(() => new Map());
      if (after.size >= 4 && !after.has(victim)) break;
      await Bun.sleep(100);
    }
    expect(after.has(victim)).toBe(false);
    expect(after.size).toBeGreaterThan(2);
    // a function that never returns: its process is killed after the time limit and a grace period, while the app goes on answering
    const stuck = c.fetch("/http/spin").catch(() => undefined);
    const started = Date.now();
    let answered = 0;
    while (Date.now() - started < 9_000) {
      const r = await c.fetch("/http/who").catch(() => undefined);
      if (r?.ok) answered++;
      await Bun.sleep(50);
    }
    expect(answered).toBeGreaterThan(40); // (the other processes answered throughout)
    await stuck;
    const later = await pids(100);
    expect(later.size).toBeGreaterThan(2); // (the stuck one is back too)
    expect(await (await c.fetch("/http/count")).json()).toBe(300); // the data is where it was
  }, 90_000);

  test("a reload reaches every server and its runtime processes", async () => {
    const data = tempDir();
    const withDb = async <T>(fn: (db: ReturnType<typeof createSqliteDb>) => Promise<T>) => {
      const db = createSqliteDb(join(data, "app.db"));
      try {
        return await fn(db);
      } finally {
        await db.close();
      }
    };
    await withDb((db) => migrateSystem(db));
    const own = await start({ RUNTIME_WORKERS: "2" }, 2, data);
    try {
      const flags = async () => {
        const seen = new Map<number, string | null>();
        for (let i = 0; i < 120; i++) {
          const r = (await (await own.fetch("/http/env")).json()) as { flag: string | null; pid: number };
          seen.set(r.pid, r.flag);
        }
        return seen;
      };
      expect([...(await flags()).values()].every((f) => f === null)).toBe(true);
      await withDb(async (db) => db.execute(`INSERT INTO "_env" ("name", "value", "updatedAt") VALUES ('CLUSTER_FLAG', 'on', 0)`));
      own.proc.kill("SIGHUP");
      const until = Date.now() + 40_000;
      let seen = new Map<number, string | null>();
      while (Date.now() < until) {
        seen = await flags().catch(() => new Map());
        if (seen.size > 2 && [...seen.values()].every((f) => f === "on")) break;
        await Bun.sleep(150);
      }
      expect(seen.size).toBeGreaterThan(2);
      expect([...seen.values()].every((f) => f === "on")).toBe(true);
    } finally {
      await own.stop();
    }
  }, 120_000);
});

describe.skipIf(!capable)("a cluster under saturated writes and a rate limit", () => {
  test("the write-ahead log stays bounded when both servers write without pause", async () => {
    if (!(await nativeEngine())) return;
    const c = await start({ SQLITE_SYNCHRONOUS: "NORMAL" });
    try {
      const wal = join(c.data, "app.db-wal");
      const sizeOf = () => (existsSync(wal) ? statSync(wal).size : 0);
      let biggest = 0;
      const watcher = setInterval(() => (biggest = Math.max(biggest, sizeOf())), 25);
      let failed = 0;
      const total = 30_000; // 480 MB of documents: without a restart of the log it would grow to that
      let next = 0;
      await Promise.all(
        Array.from({ length: 96 }, async () => {
          while (next++ < total) {
            const r = await c.fetch("/http/big", { method: "POST" }).catch(() => undefined);
            if (!r?.ok) failed++;
          }
        }),
      );
      clearInterval(watcher);
      expect(failed).toBe(0);
      // the log's keeper restarts it past 64 MB, looking every 50 ms: it can pass that by what is written between two looks
      expect(biggest).toBeLessThan(240 * 1024 * 1024);
    } finally {
      await c.stop();
    }
  }, 240_000);

  test("a client's rate limit is the app's, not each server's", async () => {
    if (!(await nativeEngine())) return;
    // fixed windows by the clock: not across a minute's end
    const toNextMinute = 60_000 - (Date.now() % 60_000);
    if (toNextMinute < 15_000) await Bun.sleep(toNextMinute + 100);
    const c = await start({ RATE_LIMIT_PER_MINUTE: "60", TRUST_PROXY: "1" });
    try {
      const results = await Promise.all(Array.from({ length: 400 }, () => c.fetch("/http/who", { headers: { "x-forwarded-for": "10.1.1.1" } }).then((r) => r.status)));
      const allowed = results.filter((s) => s === 200).length;
      expect(results.filter((s) => s === 429).length).toBeGreaterThan(300);
      expect(allowed).toBe(60); // the counts are shared in memory: exactly the app's limit, whichever server took each request
    } finally {
      await c.stop();
    }
  }, 60_000);
});
