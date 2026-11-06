import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { adminOp, addAdmin, type AdminDeps } from "../src/server/admin-ops";
import { readTarGz } from "../src/server/backup/tar";
import { ConfigError, loadConfig } from "../src/server/config";
import { createSqliteDb } from "../src/server/db/sqlite";
import type { Db } from "../src/server/db/types";
import { rateKeyOf, RedisRateLimiter } from "../src/server/ratelimit";
import { startServer, type RunningServer } from "../src/server/server";
import { SETTING } from "../src/server/settings";
import { migrateSystem } from "../src/server/system";
import { buildSettings } from "../src/server/telemetry/settings";
import { tempDir } from "./helpers";

// Smaller fixes from the 0.19 security review, one block each.
const fixture = join(import.meta.dir, "fixture");
const prod = { BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1" };

test("ALLOW_CUSTOM_FUNCTIONS comes only from the environment: a dashboard session can't turn on running its own code", () => {
  expect(SETTING.get("ALLOW_CUSTOM_FUNCTIONS")?.envOnly).toBeTruthy();
});

test("ADMIN_KEY is at least 16 characters outside dev; dev and generated keys pass", () => {
  expect(() => loadConfig({ ...prod, ADMIN_KEY: "root-key" }, false)).toThrow(ConfigError);
  expect(() => loadConfig({ ...prod, ADMIN_KEY: "0123456789abcdef" }, false)).not.toThrow();
  expect(() => loadConfig({ ...prod, ADMIN_KEY: Buffer.from(crypto.getRandomValues(new Uint8Array(24))).toString("hex") }, false)).not.toThrow();
  expect(() => loadConfig({ ADMIN_KEY: "k" }, true)).not.toThrow();
});

describe("dashboard sessions", () => {
  let db: Db;
  let op: (name: string, args: object) => Promise<any>;
  beforeAll(async () => {
    db = createSqliteDb(join(tempDir(), "app.db"));
    await migrateSystem(db);
    op = (name, args) => adminOp({ db } as unknown as AdminDeps, name, args, "system");
  });
  afterAll(() => db.close());

  test("a new password for an account signs out its sessions", async () => {
    await addAdmin(db, "ada@example.com", "first-password-123", "admin");
    const { token } = await op("login", { email: "ada@example.com", password: "first-password-123" });
    expect(await op("session", { token })).toMatchObject({ email: "ada@example.com" });
    await addAdmin(db, "ada@example.com", "second-password-123", "admin");
    expect(await op("session", { token })).toBeNull();
  });

  test("a session signed in with ADMIN_KEY ends when the key changes", async () => {
    const { token } = await op("keySession", { key: "fingerprint-a" });
    expect(await op("session", { token, key: "fingerprint-a" })).toMatchObject({ role: "owner" });
    expect(await op("session", { token, key: "fingerprint-b" })).toBeNull();
    expect(await op("session", { token })).toBeNull(); // no ADMIN_KEY any more
    // One from before sessions held the key's fingerprint has nothing to compare: it is over too.
    await db.execute(`INSERT INTO "_admin_sessions" ("_id", "adminId", "expiresAt") VALUES (?, ?, ?)`, [new Bun.CryptoHasher("sha256").update("old").digest("hex"), "admin-key", Date.now() + 60_000]);
    expect(await op("session", { token: "old", key: "fingerprint-a" })).toBeNull();
  });
});

describe("a production server", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({
      forgeDir: fixture,
      env: { ...process.env, ...prod, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "k".repeat(32), DASHBOARD: "on", RATE_LIMIT_PER_MINUTE: "5", LOG_FORMAT: "json" },
    });
  });
  afterAll(() => srv.stop({ graceful: false }));

  test("wrong admin keys count against the client's sign-in budget; the right key doesn't", async () => {
    const as = (key: string) => fetch(`${srv.url}/_admin/subscriptions`, { headers: { "x-admin-key": key } }).then((r) => r.status);
    for (let i = 0; i < 8; i++) expect(await as("k".repeat(32))).toBe(200);
    const wrong: number[] = [];
    for (let i = 0; i < 7; i++) wrong.push(await as(`guess-${i}`.padEnd(32, "x")));
    expect(wrong.slice(0, 5).every((s) => s === 401)).toBe(true);
    expect(wrong.at(-1)).toBe(429);
  });

  test("/ready says whether the server is ready, and nothing about why", async () => {
    const res = await fetch(`${srv.url}/ready`);
    expect(await res.json()).toEqual({ ready: true });
  });
});

test("the OpenAPI document built from a request's Host isn't handed to requests for another", async () => {
  const srv = await startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret", API_DOCS: "1", BETTER_AUTH_URL: "" } });
  try {
    const doc = (host?: string) => fetch(`${srv.url}/_api/openapi.json`, host ? { headers: { host } } : {}).then((r) => r.json() as Promise<{ servers: { url: string }[] }>);
    expect((await doc("evil.example")).servers[0]!.url).toBe("http://evil.example");
    expect((await doc()).servers[0]!.url).toBe(new URL(srv.url).origin);
  } finally {
    await srv.stop({ graceful: false });
  }
});

describe("rate limits", () => {
  test("an IPv6 client counts by its /64, and an IPv4 address written as IPv6 as that address", () => {
    expect(rateKeyOf("2001:db8:1:2:aaaa::1")).toBe(rateKeyOf("2001:db8:1:2:bbbb:cccc:dddd:eeee"));
    expect(rateKeyOf("2001:db8:1:2::1")).not.toBe(rateKeyOf("2001:db8:1:3::1"));
    expect(rateKeyOf("::ffff:192.0.2.7")).toBe("192.0.2.7");
    expect(rateKeyOf("192.0.2.7")).toBe("192.0.2.7");
  });

  test("on Redis, a count whose expiry was lost gets one, instead of locking the client out for good", async () => {
    const store = new Map<string, number>();
    const ttl = new Map<string, number>();
    let loseExpire = true;
    const redis = {
      async send(cmd: string, [k, v]: string[]) {
        if (cmd === "INCR") return store.set(k!, (store.get(k!) ?? 0) + 1).get(k!);
        if (cmd === "EXPIRE") {
          if (loseExpire) throw new Error("connection lost"); // the INCR landed, the EXPIRE didn't
          return ttl.set(k!, Number(v)), 1;
        }
        if (cmd === "TTL") return ttl.get(k!) ?? -1;
      },
    };
    const limiter = new RedisRateLimiter(redis as never, "p:");
    expect((await limiter.consume("ip", { window: 60, max: 1 })).allowed).toBe(true); // fell back to counting locally, after the INCR
    loseExpire = false;
    expect((await limiter.consume("ip", { window: 60, max: 1 })).allowed).toBe(false);
    expect(ttl.get("p:ip")).toBe(60);
  });
});

test("alert webhooks don't reach private, loopback or link-local addresses, and say no more than that", async () => {
  let hits = 0;
  const inside = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => (hits++, new Response("ok")) });
  try {
    const settings = buildSettings({} as Db);
    expect(await settings.testAlert({ webhook: `http://127.0.0.1:${inside.port}/hook` })).toBe("failed: the address isn't allowed (private, loopback or link-local)");
    expect(await settings.testAlert({ webhook: "http://169.254.169.254/latest/meta-data" })).toBe("failed: the address isn't allowed (private, loopback or link-local)");
    expect(await settings.testAlert({ webhook: "http://10.0.0.1:22/" })).toStartWith("failed: the address isn't allowed");
    expect(hits).toBe(0);
  } finally {
    inside.stop(true);
  }
});

test("a backup archive whose PAX header claims more than a name's worth is refused before it is read", async () => {
  const h = new Uint8Array(512);
  const put = (at: number, text: string) => h.set(new TextEncoder().encode(text), at);
  put(0, "PaxHeader/x");
  put(100, "0000644\0");
  put(124, "77777777777\0"); // about 8 GB
  put(136, "00000000000\0");
  h[156] = "x".charCodeAt(0);
  put(257, "ustar\0");
  put(148, "        ");
  const sum = h.reduce((a, b) => a + b, 0);
  put(148, `${sum.toString(8).padStart(6, "0")}\0 `);
  const archive = new Blob([gzipSync(Buffer.concat([h, new Uint8Array(1024)]))]);
  const read = async () => {
    for await (const _ of readTarGz(archive.stream()));
  };
  await expect(read()).rejects.toThrow("PAX header");
});
