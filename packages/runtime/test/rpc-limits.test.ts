import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

// What a client can make the server hold, and which requests count as the client's own.
const fixture = join(import.meta.dir, "fixture");
const prod = { BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", DASHBOARD: "on" };

const until = async (cond: () => boolean, ms = 5000) => {
  for (const end = Date.now() + ms; !cond(); await Bun.sleep(10)) if (Date.now() > end) throw new Error("timed out");
};

// In dev the functions run in a child process; in production, inline in the server.
describe.each([
  ["dev", true, {}],
  ["production", false, prod],
] as const)("%s", (_, dev, extra) => {
  let srv: RunningServer;

  beforeAll(async () => {
    srv = await startServer({ forgeDir: fixture, dev, env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), ADMIN_KEY: "secret", MAX_SUBSCRIPTION_BYTES: "4096", ...extra } });
  });
  afterAll(() => srv.stop({ graceful: false }));

  async function socket() {
    const ws = new WebSocket(`${srv.url.replace("http", "ws")}/rpc`);
    const got: any[] = [];
    ws.addEventListener("message", (e) => got.push(JSON.parse(String(e.data))));
    await new Promise((r) => ws.addEventListener("open", r));
    return { got, send: (m: object) => ws.send(JSON.stringify(m)), close: () => ws.close() };
  }

  const createList = async (name: string) =>
    ((await (await fetch(`${srv.url}/rpc/todos:createList`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name }) })).json()) as any).result;
  const live = async () => ((await (await fetch(`${srv.url}/_admin/subscriptions`, { headers: { "x-admin-key": "secret" } })).json()) as unknown[]).length;

  test("a subscription whose arguments fail validation ends with the error instead of waiting with them", async () => {
    const before = await live();
    const s = await socket();
    s.send({ type: "subscribe", id: "bad", name: "todos:listByList", args: { listId: [{}, {}, {}] } });
    await until(() => s.got.length === 1);
    expect(s.got[0]).toMatchObject({ type: "error", id: "bad", error: { code: "BAD_REQUEST" } });
    expect(s.got[0].error.message).toContain("args.listId");
    await Bun.sleep(50);
    expect(await live()).toBe(before);
    s.close();
  });

  test("a subscribe message over MAX_SUBSCRIPTION_BYTES is refused, and the socket keeps working", async () => {
    const s = await socket();
    s.send({ type: "subscribe", id: "big", name: "todos:listByList", args: { listId: "x".repeat(5000) } });
    await until(() => s.got.length === 1);
    expect(s.got[0]).toMatchObject({ type: "error", id: "big", error: { code: "PAYLOAD_TOO_LARGE" } });
    const listId = await createList("ok");
    s.send({ type: "subscribe", id: "ok", name: "todos:listByList", args: { listId } });
    await until(() => s.got.length === 2);
    expect(s.got[1]).toEqual({ type: "data", id: "ok", data: { value: [] } });
    s.close();
  });

  test("one connection's live queries hold at most 16 × MAX_SUBSCRIPTION_BYTES of subscribe messages", async () => {
    const listId = await createList("budget");
    const s = await socket();
    // Valid subscriptions that stay live, each message padded (the server ignores fields it doesn't know) to nearly the cap.
    const sub = (i: number) => ({ type: "subscribe", id: `s${i}`, name: "todos:listByList", args: { listId }, pad: "x".repeat(3900) });
    for (let i = 0; i < 17; i++) s.send(sub(i));
    await until(() => s.got.length === 17);
    const refused = s.got.filter((m) => m.type === "error");
    expect(refused.map((m) => m.error.code)).toEqual(["PAYLOAD_TOO_LARGE"]);
    // Unsubscribing makes room for another.
    s.send({ type: "unsubscribe", id: "s0" });
    await Bun.sleep(50);
    s.send(sub(100));
    await until(() => s.got.some((m) => m.id === "s100"));
    expect(s.got.find((m) => m.id === "s100").type).toBe("data");
    s.close();
  });
});
