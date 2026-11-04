// Webhooks in and out (@archlast/forge-runtime/nest/webhooks), on the engine's own document database, against test/fixture-webhooks.
// One engine with its function runtime in a child process (one Nest app per process: other suites mount theirs in this one), the real
// scheduler and real time; the fixture's retry delay is 10 ms.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createHmac } from "node:crypto";
import { join } from "node:path";
import { signWebhook, standardScheme } from "../src/nest-webhooks";
import { startServer, type RunningServer } from "../src/server/server";
import { tempDir } from "./helpers";

const SECRET = "whsec_" + Buffer.from("payments-secret-0123456789").toString("base64");
let srv: RunningServer;
beforeAll(async () => {
  process.env.PAYMENTS_WEBHOOK_SECRET = SECRET; // the fixture's receiver reads it from the environment, as an app's would
  srv = await startServer({
    forgeDir: join(import.meta.dir, "fixture-webhooks"),
    env: { ...process.env, RUNTIME_MODE: "process", PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "0", LOG_FORMAT: "json" },
  });
}, 30_000);
afterAll(() => srv?.stop({ graceful: false }));

async function call(name: string, args: object): Promise<any> {
  const res = await fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) });
  const body = (await res.json()) as { result?: unknown; error?: { message: string } };
  if (body.error) throw new Error(body.error.message);
  return body.result;
}
const m = (name: string, args: object = {}) => call(name, args);
const q = (name: string, args: object = {}) => call(name, args);

/** A receiver on localhost that answers with the statuses it is given (then 200), and keeps every request. */
function receiver() {
  const statuses: number[] = [];
  const got: { headers: Record<string, string>; body: string }[] = [];
  const server = Bun.serve({
    port: 0,
    async fetch(req) {
      got.push({ headers: Object.fromEntries(req.headers), body: await req.text() });
      const status = statuses.shift() ?? 200;
      return new Response(status === 200 ? "ok" : "nope", { status, headers: status === 503 ? { "retry-after": "0" } : {} });
    },
  });
  return { url: `http://localhost:${server.port}/hook`, statuses, got, stop: () => server.stop(true) };
}

describe("sending", () => {
  let r: ReturnType<typeof receiver>;
  let tenant: string;
  beforeEach(() => {
    r = receiver();
    tenant = `t${crypto.randomUUID().slice(0, 8)}`; // one database for the suite: each test is its own tenant
  });
  afterEach(() => r.stop());

  const setup = async (o: { eventTypes?: string[] } = {}) => {
    const ep = await m("webhooks:createEndpoint", { url: r.url, eventTypes: o.eventTypes ?? ["order.shipped"], tenant });
    const orderId = await m("orders:place", { tenant, item: "cat tree" });
    return { ...ep, orderId } as { id: string; secret: string; orderId: string };
  };
  const deliveriesOf = async (endpointId: string, t = tenant) => (await q("webhooks:deliveries", { endpointId, paginationOpts: { numItems: 50, cursor: null }, tenant: t })).page;
  /** Waits until the endpoint's newest delivery has finished (delivered or failed). */
  const settled = async (endpointId: string, t = tenant) => {
    for (let i = 0; i < 200; i++) {
      const [d] = await deliveriesOf(endpointId, t);
      if (d && (d.status === "delivered" || d.status === "failed")) return d;
      await Bun.sleep(25);
    }
    throw new Error("the delivery did not finish");
  };

  test("a dispatched message is delivered once, signed with Standard Webhooks, after the mutation commits", async () => {
    const { id, secret, orderId } = await setup();
    expect(secret).toStartWith("whsec_");
    const sent = await m("orders:ship", { id: orderId });
    expect(sent.deliveries).toBe(1);
    const d = await settled(id);
    expect(d).toMatchObject({ status: "delivered", attempts: 1, lastStatusCode: 200 });
    expect(r.got).toHaveLength(1);
    const [req] = r.got;
    expect(req!.headers["webhook-id"]).toBe(sent.msgId);
    expect(JSON.parse(req!.body)).toMatchObject({ type: "order.shipped", data: { orderId, item: "cat tree" } });
    // what any Standard Webhooks receiver does with it
    expect(standardScheme.verify({ headers: req!.headers, rawBody: Buffer.from(req!.body) }, [secret])).toEqual({ id: sent.msgId, timestamp: Number(req!.headers["webhook-timestamp"]) * 1000 });
    expect(standardScheme.verify({ headers: req!.headers, rawBody: Buffer.from(req!.body + " ") }, [secret])).toBeNull();
    expect(await q("webhooks:attempts", { deliveryId: d._id, tenant })).toHaveLength(1);
    expect((await q("webhooks:endpoint", { id, tenant })).secretCount).toBe(1); // secrets are never read back
  });

  test("a mutation that fails after dispatching sends nothing (the outbox commits with the change)", async () => {
    const { id, orderId } = await setup();
    await expect(m("orders:ship", { id: orderId, failAfter: true })).rejects.toThrow("Failed after dispatching");
    await Bun.sleep(300);
    expect(r.got).toHaveLength(0);
    expect(await deliveriesOf(id)).toHaveLength(0);
  });

  test("failures are retried with backoff and logged; the endpoint's failure clock resets on success", async () => {
    const { id, orderId } = await setup();
    r.statuses.push(500, 503);
    await m("orders:ship", { id: orderId });
    const d = await settled(id);
    expect(d).toMatchObject({ status: "delivered", attempts: 3 });
    expect(r.got.map((g) => g.headers["webhook-id"])).toEqual(Array(3).fill(r.got[0]!.headers["webhook-id"])); // one id: receivers deduplicate on it
    expect((await q("webhooks:attempts", { deliveryId: d._id, tenant })).map((a: any) => a.statusCode)).toEqual([500, 503, 200]);
    expect((await q("webhooks:endpoint", { id, tenant })).failingSince).toBeUndefined();
  });

  test("an endpoint that keeps failing exhausts the attempts; a failed delivery can be retried", async () => {
    const { id, orderId } = await setup();
    r.statuses.push(500, 500, 500, 500);
    await m("orders:ship", { id: orderId });
    const d = await settled(id);
    expect(d).toMatchObject({ status: "failed", reason: "exhausted", attempts: 4 });
    expect((await q("webhooks:endpoint", { id, tenant })).failingSince).toBeNumber();
    await m("webhooks:retry", { deliveryId: d._id, tenant });
    expect(await settled(id)).toMatchObject({ status: "delivered", attempts: 1 });
  });

  test("410 Gone fails the delivery and disables the endpoint; later messages skip it", async () => {
    const { id, orderId } = await setup();
    r.statuses.push(410);
    await m("orders:ship", { id: orderId });
    expect(await settled(id)).toMatchObject({ status: "failed", reason: "rejected", attempts: 1 });
    expect(await q("webhooks:endpoint", { id, tenant })).toMatchObject({ disabled: true, disabledReason: "gone" });
    const again = await m("orders:place", { tenant, item: "box" });
    expect((await m("orders:ship", { id: again })).deliveries).toBe(0);
  });

  test("messages go only to the tenant's endpoints that subscribe to the type ('*' is every type)", async () => {
    const mine = await setup();
    const other = `${tenant}-other`;
    const theirs = await m("webhooks:createEndpoint", { url: r.url, eventTypes: ["*"], tenant: other });
    const unsubscribed = await m("webhooks:createEndpoint", { url: r.url, eventTypes: ["order.cancelled"], tenant });
    expect((await m("orders:ship", { id: mine.orderId })).deliveries).toBe(1);
    const otherOrder = await m("orders:place", { tenant: other, item: "lamp" });
    expect((await m("orders:ship", { id: otherOrder })).deliveries).toBe(1);
    await settled(mine.id);
    await settled(theirs.id, other);
    expect(await deliveriesOf(unsubscribed.id)).toHaveLength(0);
    await expect(q("webhooks:endpoint", { id: theirs.id, tenant })).rejects.toThrow("No such webhook endpoint"); // another tenant's endpoint
  });

  test("a message id makes dispatch idempotent", async () => {
    const { id, orderId } = await setup();
    const msgId = `order-${orderId}-shipped`;
    const first = await m("orders:ship", { id: orderId, messageId: msgId });
    const second = await m("orders:ship", { id: orderId, messageId: msgId });
    expect([first.deliveries, second.deliveries, second.msgId]).toEqual([1, 0, msgId]);
    await settled(id);
    expect(r.got).toHaveLength(1);
  });

  test("after a secret rotation both secrets sign until the overlap ends", async () => {
    const { id, secret, orderId } = await setup();
    const { secret: next } = await m("webhooks:rotateSecret", { id, tenant });
    await m("orders:ship", { id: orderId });
    await settled(id);
    const [req] = r.got;
    expect(req!.headers["webhook-signature"]!.split(" ")).toHaveLength(2);
    for (const s of [secret, next]) expect(standardScheme.verify({ headers: req!.headers, rawBody: Buffer.from(req!.body) }, [s])).not.toBeNull();
  });

  test("link-local and metadata addresses are never called, and the delivery is not retried", async () => {
    const ep = await m("webhooks:createEndpoint", { url: "http://169.254.169.254/latest/meta-data", eventTypes: ["order.shipped"], tenant });
    const orderId = await m("orders:place", { tenant, item: "x" });
    await m("orders:ship", { id: orderId });
    expect(await settled(ep.id)).toMatchObject({ status: "failed", reason: "blocked", attempts: 1 });
  });

  test("endpoint URLs and event types are checked", async () => {
    await expect(m("webhooks:createEndpoint", { url: "not a url", eventTypes: ["order.shipped"], tenant })).rejects.toThrow("not a URL");
    await expect(m("webhooks:createEndpoint", { url: r.url, eventTypes: ["order.exploded"], tenant })).rejects.toThrow('Unknown webhook event type "order.exploded"');
  });
});

describe("receiving", () => {
  const send = (body: string, o: { id?: string; timestamp?: number; secret?: string } = {}) => {
    const id = o.id ?? `evt_${crypto.randomUUID()}`;
    const timestamp = o.timestamp ?? Math.floor(Date.now() / 1000);
    return fetch(`${srv.url}/http/webhooks/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": id, "webhook-timestamp": String(timestamp), "webhook-signature": signWebhook({ id, timestamp, body, secrets: o.secret ?? SECRET }) },
      body,
    });
  };

  test("a verified webhook is applied once; a redelivery of the same id changes nothing", async () => {
    const body = JSON.stringify({ orderId: "orders:1", amount: 42 });
    const id = `evt_${crypto.randomUUID()}`;
    const first = await send(body, { id });
    expect(first.status).toBe(200);
    expect(await first.json()).toEqual({ applied: true });
    const again = await send(body, { id });
    expect(await again.json()).toEqual({ applied: false });
  });

  test("a wrong signature, an old timestamp or a changed body is refused with 401 before the handler runs", async () => {
    const body = JSON.stringify({ orderId: "orders:2", amount: 1 });
    expect((await send(body, { secret: "whsec_" + Buffer.from("wrong").toString("base64") })).status).toBe(401);
    expect((await send(body, { timestamp: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const now = Math.floor(Date.now() / 1000);
    const tampered = await fetch(`${srv.url}/http/webhooks/payments`, {
      method: "POST",
      headers: { "content-type": "application/json", "webhook-id": "evt_x", "webhook-timestamp": String(now), "webhook-signature": signWebhook({ id: "evt_x", timestamp: now, body, secrets: SECRET }) },
      body: body.replace("1", "1000"),
    });
    expect(tampered.status).toBe(401);
  });

  test("an HMAC-of-the-body sender (GitHub style) is verified and deduplicated on a hash of what it signed", async () => {
    const body = JSON.stringify({ action: "opened" });
    const sig = "sha256=" + createHmac("sha256", "gh-secret").update(body).digest("hex");
    const ok = await fetch(`${srv.url}/http/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": sig }, body });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as any).payload).toEqual({ action: "opened" });
    const bad = await fetch(`${srv.url}/http/webhooks/github`, { method: "POST", headers: { "content-type": "application/json", "x-hub-signature-256": "sha256=00" }, body });
    expect(bad.status).toBe(401);
  });
});
