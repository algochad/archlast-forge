import { afterAll, describe, expect, spyOn, test } from "bun:test";
import { SQL } from "bun";
import { join } from "node:path";
import { describePlan, isTooManyClients, planPools, readPostgresLimits } from "../src/server/db/pool-size";
import { createPostgresDb } from "../src/server/db/postgres";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

/** A Postgres as it comes: max_connections 100, 3 reserved for superusers. */
const STOCK = { maxConnections: 100, reserved: 3, inUse: 0 };

describe("sizing the Postgres pools", () => {
  test("a default Postgres on 16 cores: the pools take 60% of it, not 99 of 100", () => {
    const plan = planPools({ cores: 16, workers: 1, dev: false, limits: STOCK });
    expect(plan).toMatchObject({ read: 18, write: 36, auto: true, total: 57 });
    expect(plan.total).toBeLessThanOrEqual(0.6 * 97);
  });

  test("processes and servers share the budget", () => {
    const four = planPools({ cores: 16, workers: 4, dev: false, limits: STOCK });
    expect(four).toMatchObject({ read: 4, write: 8, total: 51 });
    const two = planPools({ cores: 16, workers: 1, replicas: 2, dev: false, limits: STOCK });
    expect(two).toMatchObject({ read: 8, write: 16, total: 27 });
    expect(2 * two.total).toBeLessThanOrEqual(0.6 * 97);
  });

  test("never more than the old defaults on a large Postgres, and at least one connection each on a tiny one", () => {
    expect(planPools({ cores: 16, workers: 1, dev: false, limits: { maxConnections: 1000, reserved: 3, inUse: 0 } })).toMatchObject({ read: 32, write: 64 });
    expect(planPools({ cores: 4, workers: 1, dev: false, limits: { maxConnections: 500, reserved: 3, inUse: 0 } })).toMatchObject({ read: 8, write: 16 });
    expect(planPools({ cores: 16, workers: 1, dev: false, limits: { maxConnections: 10, reserved: 3, inUse: 0 } })).toMatchObject({ read: 1, write: 1 });
    // A managed Postgres with 25 connections.
    const small = planPools({ cores: 8, workers: 1, dev: false, limits: { maxConnections: 25, reserved: 3, inUse: 0 } });
    expect(small).toMatchObject({ read: 3, write: 6 });
    expect(small.total).toBeLessThanOrEqual(22);
  });

  test("development gets small pools, whatever the machine", () => {
    expect(planPools({ cores: 64, workers: 1, dev: true, limits: { maxConnections: 1000, reserved: 3, inUse: 0 } })).toMatchObject({ read: 4, write: 8, total: 15 });
  });

  test("what is set wins: both, the read pool alone (writes twice it, as before), or the write pool alone", () => {
    expect(planPools({ cores: 16, workers: 1, dev: false, read: 32, write: 64, limits: STOCK })).toMatchObject({ read: 32, write: 64, auto: false, total: 99 });
    expect(planPools({ cores: 16, workers: 1, dev: false, read: 5, limits: STOCK })).toMatchObject({ read: 5, write: 10, auto: false });
    expect(planPools({ cores: 16, workers: 1, dev: false, write: 40, limits: STOCK })).toMatchObject({ read: 15, write: 40, auto: true });
  });

  test("without the database's limit, pools that fit any Postgres", () => {
    expect(planPools({ cores: 16, workers: 1, dev: false })).toMatchObject({ read: 4, write: 8, auto: true });
  });

  test("the start-up line gives the numbers, and warns when the server is close to the limit", () => {
    const fine = describePlan(planPools({ cores: 16, workers: 1, dev: false, limits: STOCK }));
    expect(fine.level).toBe("info");
    expect(fine.message).toContain("(18 read + 36 write) + 3 telemetry = 57 of the 97 Postgres allows (max_connections 100, 3 reserved)");
    const set = describePlan(planPools({ cores: 16, workers: 1, dev: false, read: 32, write: 64, limits: STOCK }));
    expect(set.level).toBe("warn");
    expect(set.message).toContain("= 99");
    expect(set.message).toContain("DATABASE_POOL_SIZE");
    // Connections already open (another server, a tool) count too.
    expect(describePlan(planPools({ cores: 16, workers: 1, dev: false, limits: { ...STOCK, inUse: 30 } })).level).toBe("warn");
    // As do the servers that haven't started yet.
    expect(describePlan(planPools({ cores: 16, workers: 1, replicas: 3, dev: false, read: 12, write: 12, limits: STOCK })).message).toContain("3 servers: 81");
  });

  test("Postgres's too-many-clients error is recognized as Bun reports it", () => {
    expect(isTooManyClients({ code: "ERR_POSTGRES_SERVER_ERROR", errno: "53300", message: "sorry, too many clients already" })).toBe(true);
    expect(isTooManyClients({ errno: "40001" })).toBe(false);
    expect(isTooManyClients(new Error("x"))).toBe(false);
  });
});

const url = process.env.TEST_POSTGRES_URL;

describe.skipIf(!url)("on Postgres", () => {
  const admin = url ? new SQL(url, { max: 1 }) : undefined!;
  const started: RunningServer[] = [];
  afterAll(async () => {
    await Promise.all(started.map((s) => s.stop({ graceful: false })));
    await admin.unsafe("DROP ROLE IF EXISTS forge_pool_test").catch(() => {});
    await admin.close();
  });
  const connections = async () =>
    Number((await admin.unsafe(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE backend_type = 'client backend' AND pid <> pg_backend_pid()`))[0].n);

  test("the limit is read from the database", async () => {
    const limits = await readPostgresLimits(url!);
    expect(limits!.maxConnections).toBeGreaterThan(0);
    expect(limits!.reserved).toBeGreaterThanOrEqual(0);
    expect(await readPostgresLimits("postgres://nobody:wrong@127.0.0.1:1/none")).toBeUndefined();
  });

  test("an engine started with no pool settings holds what it says, within the database's limit", async () => {
    const before = await connections();
    const log = spyOn(console, "log");
    try {
      const srv = await startServer({
        forgeDir: join(import.meta.dir, "fixture"),
        env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), DATABASE_URL: url!, BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", LOG_FORMAT: "json", RUNTIME_WORKERS: "1" },
      });
      started.push(srv);
      await fetch(`${srv.url}/rpc/todos:events?args=%7B%7D`);
      const line = log.mock.calls.map((c) => String(c[0])).find((m) => m.startsWith("Postgres connections:"));
      expect(line).toBeDefined();
      const total = Number(/= (\d+) of the (\d+)/.exec(line!)![1]);
      const usable = Number(/= (\d+) of the (\d+)/.exec(line!)![2]);
      expect(total).toBeLessThanOrEqual(Math.floor(usable * 0.6));
      const opened = (await connections()) - before;
      expect(opened).toBeGreaterThan(0);
      expect(opened).toBeLessThanOrEqual(total);
    } finally {
      log.mockRestore();
    }
  });

  test("a refused connection logs what to change, once a minute, and the error still reaches the caller", async () => {
    // A role allowed no connections gets Postgres's 53300 (too many connections), as a full server does.
    await admin.unsafe("DROP ROLE IF EXISTS forge_pool_test");
    await admin.unsafe("CREATE ROLE forge_pool_test LOGIN PASSWORD 'pool' CONNECTION LIMIT 0");
    const limited = new URL(url!);
    limited.username = "forge_pool_test";
    limited.password = "pool";
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    const db = createPostgresDb(limited.href, 3, 3);
    try {
      const first = await db.query("SELECT 1").catch((e) => e);
      expect(isTooManyClients(first)).toBe(true);
      await db.query("SELECT 1").catch(() => {});
      const hints = warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes("too many clients"));
      expect(hints.length).toBe(1);
      expect(hints[0]).toContain("DATABASE_POOL_SIZE");
      expect(hints[0]).toContain("max_connections");
    } finally {
      warn.mockRestore();
      await db.close().catch(() => {});
    }
  });
});
