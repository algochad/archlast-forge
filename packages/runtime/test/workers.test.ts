import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { join } from "node:path";
import { loadConfig, runtimeWorkersFor, serverCores } from "../src/server/config";
import { startServer, type RunningServer } from "../src/server/server";
import { checkValue, SETTING, withSettings } from "../src/server/settings";
import { tempDir } from "./helpers";

describe("how many function runtime processes", () => {
  test("auto is half the cores, rounded down, at least 1; the ratio is configurable", () => {
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "auto" }, 4)).toMatchObject({ workers: 2, auto: true, cores: 4, ratio: 0.5 });
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "auto" }, 8).workers).toBe(4);
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "auto" }, 3).workers).toBe(1);
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "auto" }, 1).workers).toBe(1);
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "auto", RUNTIME_WORKERS_RATIO: "1" }, 4).workers).toBe(4);
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "auto", RUNTIME_WORKERS_RATIO: "0.25" }, 16).workers).toBe(4);
    expect(runtimeWorkersFor({}, 8)).toMatchObject({ workers: 1, auto: false }); // the default stays 1
    expect(runtimeWorkersFor({ RUNTIME_WORKERS: "3" }, 8)).toMatchObject({ workers: 3, auto: false });
    expect(() => runtimeWorkersFor({ RUNTIME_WORKERS: "0" }, 4)).toThrow('RUNTIME_WORKERS must be an integer ≥ 1 or "auto", got "0"');
    expect(() => runtimeWorkersFor({ RUNTIME_WORKERS: "auto", RUNTIME_WORKERS_RATIO: "0" }, 4)).toThrow("RUNTIME_WORKERS_RATIO must be a number above 0");
    expect(serverCores()).toBeGreaterThanOrEqual(1);
    expect(serverCores()).toBeLessThanOrEqual(availableParallelism());
  });

  test("more than one process means process mode; auto at 1 keeps inline", () => {
    const prod = { BETTER_AUTH_SECRET: "x".repeat(32), BETTER_AUTH_URL: "https://app.example.com" };
    expect(loadConfig({ ...prod, RUNTIME_WORKERS: "auto", RUNTIME_WORKERS_RATIO: "4" }, false)).toMatchObject({ runtimeMode: "process", runtimeWorkers: serverCores() * 4 });
    expect(loadConfig({ ...prod, RUNTIME_WORKERS: "auto", RUNTIME_WORKERS_RATIO: "0.01" }, false)).toMatchObject({ runtimeMode: "inline", runtimeWorkers: 1 });
  });

  test(".env wins over the dashboard; the dashboard's value applies when .env doesn't set it", () => {
    expect(loadConfig(withSettings({ RUNTIME_WORKERS: "3" }, { RUNTIME_WORKERS: "2" }), true).runtimeWorkers).toBe(3);
    expect(loadConfig(withSettings({}, { RUNTIME_WORKERS: "2" }), true).runtimeWorkers).toBe(2);
    expect(loadConfig(withSettings({}, { RUNTIME_WORKERS: "auto", RUNTIME_WORKERS_RATIO: "4" }), true).runtimeWorkers).toBe(serverCores() * 4);
    expect(checkValue(SETTING.get("RUNTIME_WORKERS")!, "auto")).toBe("auto");
    expect(() => checkValue(SETTING.get("RUNTIME_WORKERS")!, "0")).toThrow("RUNTIME_WORKERS must be an integer ≥ 1 or auto");
  });
});

describe("resizing a running pool from the dashboard", () => {
  const admin = { "x-admin-key": "secret", "x-forge-admin": "1", "content-type": "application/json" };
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ forgeDir: join(import.meta.dir, "fixture"), dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret" } });
  });
  afterAll(() => srv.stop());

  const op = async (name: string, input?: object) => {
    const res = await fetch(`${srv.url}/_admin/${name}`, input ? { method: "POST", headers: admin, body: JSON.stringify(input) } : { headers: admin });
    const body = (await res.json()) as any;
    if (!res.ok) throw new Error(body.message ?? res.status);
    return body;
  };
  const workers = async () => (await op("server")).workers;
  const call = (path: string, args: unknown) =>
    fetch(`${srv.url}/rpc/${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) }).then(async (r) => ({ status: r.status, body: (await r.json()) as any }));

  test("grows and shrinks without dropping a call or a subscription, and is kept", async () => {
    // A live query, on its own socket.
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
    const updates: any[] = [];
    let closed = false;
    ws.addEventListener("message", (e) => {
      const msg = JSON.parse(String(e.data));
      if (msg.type === "data") updates.push(msg.data);
    });
    ws.addEventListener("close", () => (closed = true));
    await new Promise((r) => ws.addEventListener("open", r));
    ws.send(JSON.stringify({ type: "subscribe", id: "1", name: "todos:events", args: {} }));
    for (let i = 0; updates.length < 1 && i < 300; i++) await Bun.sleep(10);

    expect(await workers()).toBe(1);
    expect(await op("saveSetting", { name: "RUNTIME_WORKERS", value: "3" })).toMatchObject({ applied: "3 function runtime processes running" });
    expect(await workers()).toBe(3);

    // Calls spread over the three, then the pool shrinks to one while they run: the two that leave finish theirs first.
    const inFlight = Array.from({ length: 6 }, () => call("todos:slowAction", { ms: 700 }));
    await Bun.sleep(150);
    const shrink = op("saveSetting", { name: "RUNTIME_WORKERS", value: "1" });
    const results = await Promise.all(inFlight);
    expect(results.map((r) => [r.status, r.body.result])).toEqual(Array(6).fill([200, "done"]));
    expect(await shrink).toMatchObject({ applied: "1 function runtime process running" });
    expect(await workers()).toBe(1);

    // The subscription carried on: it never closed, and a write still reaches it.
    expect((await call("todos:logEvent", { kind: "after-resize" })).status).toBe(200);
    const seen = () => updates.some((u) => u.value?.some((e: any) => e.kind === "after-resize"));
    for (let i = 0; !seen() && i < 300; i++) await Bun.sleep(10);
    expect(seen()).toBe(true);
    expect(closed).toBe(false);

    // The value is saved (a restart keeps it), and the page shows what is in effect.
    const setting = (await op("settings")).settings.find((s: any) => s.name === "RUNTIME_WORKERS");
    expect(setting).toMatchObject({ source: "dashboard", value: "1", pending: false });
    expect(setting.effective).toMatch(/^1 running · \d+ CPU cores detected$/);
    ws.close();
  }, 30_000);

  test("a process added by a resize is brought back when it crashes", async () => {
    await op("saveSetting", { name: "RUNTIME_WORKERS", value: "2" });
    const pool = (srv.runtime as unknown as { workers: { proc?: { pid: number } }[] }).workers;
    const victim = pool[1]!.proc!.pid;
    process.kill(victim, "SIGKILL");
    for (let i = 0; i < 100 && (pool[1]?.proc?.pid ?? victim) === victim; i++) await Bun.sleep(100);
    expect(pool[1]!.proc!.pid).not.toBe(victim);
    for (let i = 0; i < 50 && (await call("todos:events", {})).status !== 200; i++) await Bun.sleep(100);
    expect((await Promise.all(Array.from({ length: 6 }, () => call("todos:events", {})))).map((r) => r.status)).toEqual(Array(6).fill(200));
    await op("saveSetting", { name: "RUNTIME_WORKERS", value: null });
    expect(await workers()).toBe(1);
  }, 30_000);
});
