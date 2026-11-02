import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { anyApi } from "../src/index";
import { startServer, type RunningServer } from "../src/server/server";
import { createTestBackend } from "../src/testing";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture-nest");
let srv: RunningServer;
let tcpPort: number;
let rpcPort: number;
const RPC_TOKEN = "t".repeat(24);

beforeAll(async () => {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  tcpPort = probe.port!;
  await probe.stop(true);
  rpcPort = await freePort();
  // Functions in a child process, so sockets and streamed bodies cross IPC (the production describe below runs them inline).
  srv = await startServer({
    forgeDir: fixture,
    env: { ...process.env, RUNTIME_MODE: "process", PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json", NEST_TCP_PORT: String(tcpPort), NEST_RPC_PORT: String(rpcPort), FORGE_RPC_TOKEN: RPC_TOKEN, API_DOCS: "on" },
  });
});
afterAll(() => srv.stop({ graceful: false }));

const http = (path: string, init?: RequestInit) => fetch(`${srv.url}/http${path}`, init);
const call = async (name: string, args: unknown = {}) =>
  ((await (await fetch(`${srv.url}/rpc/${name}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(args) })).json()) as any).result;

/** A WebSocket to a gateway path, collecting what it is sent. */
async function socket(base: string, path: string) {
  const ws = new WebSocket(`${base.replace(/^http/, "ws")}/http${path}`);
  const received: any[] = [];
  const waiters: (() => void)[] = [];
  ws.onmessage = (e) => (received.push(JSON.parse(String(e.data))), waiters.splice(0).forEach((w) => w()));
  const closed = new Promise<{ code: number; reason: string }>((r) => (ws.onclose = (e) => r({ code: e.code, reason: e.reason })));
  await new Promise<void>((resolve) => ((ws.onopen = () => resolve()), (ws.onerror = () => resolve())));
  const next = async () => {
    while (!received.length) await new Promise<void>((r) => waiters.push(r));
    return received.shift();
  };
  const ask = async (event: string, data?: unknown) => (ws.send(JSON.stringify({ event, data })), next());
  return { ws, next, ask, closed };
}

describe("Nest controllers under /http", () => {
  test("routes added with http.route() keep priority over the Nest mount", async () => {
    expect(await (await http("/plain")).text()).toBe("from httpRouter");
  });

  test("a controller creates and lists through functions, which use services with their own ctx", async () => {
    const created = await http("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "first" }) });
    expect(created.status).toBe(201);
    expect(typeof ((await created.json()) as any).id).toBe("string");
    const list = await http("/notes");
    expect(list.status).toBe(200);
    expect(list.headers.get("content-type")).toContain("application/json");
    expect(((await list.json()) as any[]).map((n) => [n.text, n.at])).toEqual([["first", 42]]);
  });

  test("params, query and headers reach the handler, and pipes and guards run", async () => {
    expect(await (await http("/notes/echo/abc?x=1", { headers: { "x-thing": "t" } })).json()).toEqual({ id: "abc", x: "1", thing: "t" });
    expect(await (await http("/notes/plus/1")).json()).toEqual({ n: 2 });
    expect((await http("/notes/plus/one")).status).toBe(400);
    expect((await http("/notes/secret")).status).toBe(403);
    expect(await (await http("/notes/secret", { headers: { "x-key": "open sesame" } })).json()).toEqual({ secret: true });
  });

  test("a request-scoped service in a controller gets the request's ctx", async () => {
    expect(await (await http("/notes/who")).json()).toEqual({ identity: null });
  });

  test("middleware runs for its routes, and interceptors run: on a route, and global through APP_INTERCEPTOR", async () => {
    const res = await http("/notes/text");
    expect(res.headers.get("x-middleware")).toBe("yes");
    expect(res.headers.get("x-stamp")).toBe("1");
    expect(await (await http("/notes/wrapped")).json()).toEqual({ wrapped: 7 });
  });

  test("a StreamableFile streams with its type and disposition", async () => {
    const res = await http("/notes/file");
    expect([res.headers.get("content-type"), res.headers.get("content-disposition"), await res.text()]).toEqual(["text/csv", 'attachment; filename="rows.csv"', "a,b\n1,2\n"]);
  });

  test("answers: text, a Response a controller built, a redirect, and Nest's 404", async () => {
    const text = await http("/notes/text");
    expect(await text.text()).toBe("plain");
    expect(text.headers.get("content-type")).toContain("text/plain");
    const raw = await http("/notes/raw");
    expect([raw.status, raw.headers.get("x-raw"), await raw.text()]).toEqual([202, "1", "raw body"]);
    const away = await http("/notes/away", { redirect: "manual" });
    expect([away.status, away.headers.get("location")]).toEqual([302, "/elsewhere"]);
    const missing = await http("/nowhere");
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).statusCode).toBe(404);
  });

  test("errors: HttpExceptions as Nest sends them, ForgeError and anything else as an HTTP action's", async () => {
    const teapot = await http("/notes/teapot");
    expect(teapot.status).toBe(418);
    expect(await teapot.json()).toEqual({ statusCode: 418, message: "short and stout" });
    const forge = await http("/notes/forge");
    expect(forge.status).toBe(400);
    expect(((await forge.json()) as any).error.data).toEqual({ code: "NOPE" });
    const boom = await http("/notes/boom", { headers: { "x-request-id": "req-nest-1" } });
    expect(boom.status).toBe(500);
    const text = await boom.text();
    expect(text).toContain("Server error (request req-nest-1)");
    expect(text).not.toContain("secret internal detail");
    const bad = await http("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: "{not json" });
    expect(bad.status).toBe(400);
  });
});

describe("controllers in the OpenAPI document", () => {
  test("every controller route is listed with its @Contract's schemas, and the contract is checked on each request", async () => {
    const doc = (await (await fetch(`${srv.url}/_api/openapi.json`)).json()) as any;
    const { Validator } = await import("@seriousme/openapi-schema-validator");
    expect((await new Validator().validate(doc)).valid).toBe(true);
    const order = doc.paths["/http/orders/{shop}"].post;
    expect(order.summary).toBe("Order from a shop");
    expect(order.tags).toEqual(["OrdersController"]);
    expect(order.parameters).toEqual([
      { name: "shop", in: "path", required: true, schema: { type: "string" } },
      { name: "express", in: "query", required: false, schema: { type: "boolean" } },
    ]);
    expect(order.requestBody.content["application/json"].schema.required).toEqual(["sku", "qty"]);
    expect(order.responses["201"].content["application/json"].schema.properties.express).toEqual({ type: "boolean" });
    expect(doc.paths["/http/orders"].get).toBeDefined(); // without a contract: listed, with no schemas
    expect(doc.paths["/http/plain"].get).toBeDefined(); // http.route() beside the Nest mount
    expect(Object.keys(doc.paths).filter((p) => p.endsWith("{rest}"))).toEqual([]); // the mount itself isn't a route

    const post = (body: unknown) => http("/orders/acme?express=true", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const ok = await post({ sku: "a1", qty: 2 });
    expect(ok.status).toBe(201);
    expect(await ok.json()).toEqual({ shop: "acme", sku: "a1", qty: 2, express: true });
    const bad = await post({ sku: "a1", qty: "two" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ message: 'body.qty must be a finite number, got "two"', error: "Bad Request", statusCode: 400 });
  });
});

describe("services in functions", () => {
  test("inject() gives a call its own request-scoped services and the shared singletons", async () => {
    const one = await call("notes:scopes");
    const two = await call("notes:scopes");
    expect(one.shared).toBe(true);
    expect(one.clock).toBe(two.clock);
  });

  test("a query reads through a service, and @InjectCtx() works without the base class", async () => {
    await call("notes:add", { text: "second" });
    expect(((await call("notes:list")) as any[]).map((n) => n.text)).toEqual(["first", "second"]);
    expect(await call("notes:count")).toBe(2);
  });
});

describe("in production, with functions inline in the server", () => {
  let prod: RunningServer;
  beforeAll(async () => {
    prod = await startServer({
      forgeDir: fixture,
      env: { ...process.env, NODE_ENV: "production", PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", ADMIN_KEY: "k", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json" },
    });
  });
  afterAll(() => prod.stop({ graceful: false }));

  test("controllers and services work the same, and errors stay hidden", async () => {
    const at = (path: string, init?: RequestInit) => fetch(`${prod.url}/http${path}`, init);
    expect((await at("/notes", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text: "prod" }) })).status).toBe(201);
    expect(((await (await at("/notes")).json()) as any[]).map((n) => n.text)).toEqual(["prod"]);
    const boom = await at("/notes/boom");
    expect(boom.status).toBe(500);
    expect(await boom.text()).not.toContain("secret internal detail");
  });

  test("gateway sockets, streamed writes and GraphQL work inline too", async () => {
    const ws = await socket(prod.url, "/ws");
    expect(await ws.ask("echo", "inline")).toEqual({ event: "echo", data: "inline" });
    ws.ws.close();
    const start = performance.now();
    const reader = (await fetch(`${prod.url}/http/express/stream`)).body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe("first ");
    expect(performance.now() - start).toBeLessThan(350);
    await reader.cancel();
    const gql = await fetch(`${prod.url}/http/graphql`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "{ notes { text } }" }) });
    expect(((await gql.json()) as any).data.notes.map((n: any) => n.text)).toContain("prod");
  });
});

test("createTestBackend runs functions that use services, as the server does", async () => {
  const t = await createTestBackend(fixture);
  try {
    await t.mutation(anyApi.notes.add, { text: "in a test" });
    expect(((await t.query(anyApi.notes.list)) as any[]).map((n) => [n.text, n.at])).toEqual([["in a test", 42]]);
  } finally {
    t.close();
  }
});

describe("CORS and Express-style responses", () => {
  test("the cors option answers preflights and marks responses", async () => {
    const pre = await http("/notes", { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe("https://app.example");
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");
    expect((await http("/notes/text", { headers: { origin: "https://app.example" } })).headers.get("access-control-allow-origin")).toBe("https://app.example");
  });

  test("res.status().set().cookie().json(), send(), passthrough, redirect and the request's helpers", async () => {
    const json = await http("/express/json");
    expect([json.status, json.headers.get("x-a"), await json.json()]).toEqual([201, "1", { ok: true }]);
    expect(json.headers.get("set-cookie")).toMatch(/^k=v;.*HttpOnly/i);
    const send = await http("/express/send");
    expect(send.headers.get("content-type")).toStartWith("text/html");
    expect(await send.text()).toBe("<b>hi</b>");
    const pass = await http("/express/passthrough");
    expect([pass.headers.get("x-pass"), await pass.json()]).toEqual(["yes", { passed: true }]);
    const away = await http("/express/redirect", { redirect: "manual" });
    expect([away.status, away.headers.get("location")]).toEqual([301, "/elsewhere"]);
    expect(await (await http("/express/request", { headers: { cookie: "a=1; b=2", "x-thing": "t" } })).json()).toEqual({ cookies: { a: "1", b: "2" }, protocol: "http", thing: "t" });
  });

  test("res.write() streams: the first bytes arrive before the handler ends", async () => {
    const start = performance.now();
    const res = await http("/express/stream");
    const reader = res.body!.getReader();
    const first = new TextDecoder().decode((await reader.read()).value);
    expect(first).toBe("first ");
    expect(performance.now() - start).toBeLessThan(350); // the end comes 400 ms later
    let rest = "";
    for (let r = await reader.read(); !r.done; r = await reader.read()) rest += new TextDecoder().decode(r.value);
    expect(rest).toBe("last");
  });

  test("@Sse() sends server-sent events", async () => {
    const res = await http("/express/ticks");
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    for (const i of [0, 1, 2]) expect(text).toContain(`data: {"i":${i}}`);
  });
});

describe("WebSocket gateways", () => {
  test("messages reach handlers, answers come back, and the handler has the ctx", async () => {
    const a = await socket(srv.url, "/ws");
    expect(await a.ask("echo", "hi")).toEqual({ event: "echo", data: "hi" });
    expect(await a.ask("who")).toEqual({ event: "who", data: null });
    expect((await a.ask("count")).event).toBe("count");
    expect(await a.ask("fail")).toMatchObject({ event: "exception", data: { status: "error", message: "nope" } });
    a.ws.close();
  });

  test("a gateway can send to every client, and a path without one is closed", async () => {
    const [a, b] = await Promise.all([socket(srv.url, "/ws"), socket(srv.url, "/ws")]);
    a.ws.send(JSON.stringify({ event: "shout", data: "all" }));
    expect(await a.next()).toEqual({ event: "shout", data: "all" });
    expect(await b.next()).toEqual({ event: "shout", data: "all" });
    a.ws.close();
    b.ws.close();
    const none = await socket(srv.url, "/no-gateway");
    expect((await none.closed).code).toBe(1008);
  });
});

describe("GraphQL", () => {
  const gql = async (query: string) => (await (await http("/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).json()) as any;

  test("queries and mutations run through the ctx, and subscriptions arrive over graphql-ws", async () => {
    const { createClient } = await import("graphql-ws");
    const client = createClient({ url: `${srv.url.replace(/^http/, "ws")}/http/graphql`, webSocketImpl: WebSocket, retryAttempts: 0 });
    const events: any[] = [];
    const subscribed = new Promise<void>((resolve) => {
      const unsubscribe = client.subscribe({ query: "subscription { noteAdded { text at } }" }, { next: (v) => (events.push(v.data), unsubscribe(), resolve()), error: () => resolve(), complete: () => {} });
    });
    await Bun.sleep(300); // the subscription is in place before the mutation
    const added = await gql('mutation { addNote(text: "from graphql") }');
    expect(typeof added.data.addNote).toBe("string");
    expect((await gql("{ notes { text } }")).data.notes.map((n: any) => n.text)).toContain("from graphql");
    await subscribed;
    expect(events).toEqual([{ noteAdded: { text: "from graphql", at: 42 } }]);
    await client.dispose();
  });
});

describe("microservices", () => {
  test("a TCP microservice answers message patterns, with an anonymous ActionCtx", async () => {
    const { ClientProxyFactory, Transport } = await import("../src/nest-microservices");
    const { rxjs } = await import("../src/nest");
    const client = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: "127.0.0.1", port: tcpPort } });
    try {
      expect(await rxjs.firstValueFrom(client.send("sum", [1, 2, 3]))).toBe(6);
      expect(typeof (await rxjs.firstValueFrom(client.send("count", {})))).toBe("number");
    } finally {
      await client.close();
    }
  });
});

describe("Forge RPC", () => {
  // What `archlast-forge codegen` writes for fixture-nest/shop.router.ts (packages/cli/test/rpc-codegen.test.ts checks that it does).
  type Rpc = {
    shop: {
      add: { kind: "query"; input: { a: number; b: number }; output: { sum: number } };
      order: { kind: "mutation"; input: { userId: string; items: Array<{ sku: string; qty: number }> }; output: { orderId: string; units: number } };
      notes: { kind: "query"; input: undefined; output: { count: number } };
      drift: { kind: "query"; input: undefined; output: { ok: boolean } };
      fail: { kind: "mutation"; input: { kind: "forge" | "rpc" | "crash" }; output: never };
      slow: { kind: "query"; input: { ms: number }; output: string };
      missing: { kind: "query"; input: undefined; output: unknown };
    };
  };
  const rpc = async () => import("../src/nest-rpc");
  const url = () => `http://127.0.0.1:${rpcPort}`;
  const failure = (p: Promise<unknown>) => p.then(() => undefined, (e: any) => e);

  test("typed calls reach the router's methods: input fields by key, the ActionCtx, a plain send()", async () => {
    const { createForgeRpcClient, ForgeRpcClient } = await rpc();
    const { rxjs } = await import("../src/nest");
    const client = new ForgeRpcClient({ url: url(), token: RPC_TOKEN });
    const shop = createForgeRpcClient<Rpc>(client).shop;
    expect(await shop.add.query({ a: 2, b: 3 })).toEqual({ sum: 5 });
    expect(await shop.order.mutate({ userId: "u1", items: [{ sku: "a", qty: 2 }, { sku: "b", qty: 3 }] })).toEqual({ orderId: "u1-2", units: 5 });
    expect(typeof (await shop.notes.query()).count).toBe("number");
    expect(await rxjs.lastValueFrom(client.send("shop.add", { a: 1, b: 1 }))).toEqual({ sum: 2 }); // a query, sent as Nest sends anything
    // Calls in one tick share an HTTP request.
    expect(await Promise.all(Array.from({ length: 40 }, (_, i) => shop.add.query({ a: i, b: 1 })))).toEqual(Array.from({ length: 40 }, (_, i) => ({ sum: i + 1 })));
  });

  test("errors: the service's ForgeError and RpcException come back as ForgeErrors; anything else is a request id, never its message", async () => {
    const { createForgeRpcClient, ForgeRpcError } = await rpc();
    const shop = createForgeRpcClient<Rpc>({ url: url(), token: RPC_TOKEN }).shop;
    const forge = await failure(shop.fail.mutate({ kind: "forge" }));
    expect(forge).toMatchObject({ name: "ForgeError", data: { reason: "out of stock" } });
    expect(await failure(shop.fail.mutate({ kind: "rpc" }))).toMatchObject({ name: "ForgeError", message: "bad sku (shop.fail)" });
    const badInput = await failure(shop.add.query({ a: "2" } as never));
    expect(badInput.name).toBe("ForgeError");
    expect(badInput.message).toContain("expected number");

    const crash = await failure(shop.fail.mutate({ kind: "crash" }));
    expect(crash).toBeInstanceOf(ForgeRpcError);
    expect(crash).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: `Server error (request ${crash.requestId})` });
    expect(crash.requestId).toMatch(/^[0-9a-f-]{36}$/);
    const drift = await failure(shop.drift.query()); // the method broke its own output schema
    expect(drift).toMatchObject({ code: "INTERNAL_SERVER_ERROR", message: `Server error (request ${drift.requestId})` });
    expect(await failure(shop.missing.query())).toMatchObject({ code: "NOT_FOUND" });

    // On the wire: no stack, no SQL, for a crash as for a refused token.
    const raw = await fetch(`${url()}/shop.fail`, { method: "POST", headers: { authorization: `Bearer ${RPC_TOKEN}`, "content-type": "application/json" }, body: JSON.stringify({ kind: "crash" }) });
    const body = await raw.text();
    expect(raw.status).toBe(500);
    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("stack");
  });

  test("the token is checked on every call, and must be long enough on both sides", async () => {
    const { createForgeRpcClient, ForgeRpcServer, ForgeRpcClient } = await rpc();
    const wrong = createForgeRpcClient<Rpc>({ url: url(), token: "w".repeat(24) }).shop;
    expect(await failure(wrong.add.query({ a: 1, b: 1 }))).toMatchObject({ name: "ForgeRpcError", code: "UNAUTHORIZED" });
    const raw = await fetch(`${url()}/shop.add`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ a: 1, b: 1 }) });
    expect(raw.status).toBe(401);
    expect(() => new ForgeRpcClient({ url: url(), token: "short" })).toThrow("16 characters or more");
    expect(() => new ForgeRpcServer({ port: 0, token: "" })).toThrow("FORGE_RPC_TOKEN");
  });

  test("backend to backend only: where there is a window (a page, a mobile or desktop app) neither side can be made", async () => {
    const { ForgeRpcServer, ForgeRpcClient } = await rpc();
    const g = globalThis as { window?: unknown };
    g.window = {};
    try {
      expect(() => new ForgeRpcClient({ url: url(), token: RPC_TOKEN })).toThrow("Forge RPC is for calls between backends");
      expect(() => new ForgeRpcServer({ port: 0, token: RPC_TOKEN })).toThrow("Forge RPC is for calls between backends");
    } finally {
      delete g.window;
    }
  });

  test("a call that outlives its timeout fails with TIMEOUT; one unsubscribed from is aborted and never answers; an unreachable service is SERVICE_UNAVAILABLE", async () => {
    const { createForgeRpcClient, ForgeRpcClient } = await rpc();
    const client = new ForgeRpcClient({ url: url(), token: RPC_TOKEN, timeoutMs: 100 });
    const started = performance.now();
    expect(await failure(createForgeRpcClient<Rpc>(client).shop.slow.query({ ms: 1000 }))).toMatchObject({ code: "TIMEOUT" });
    expect(performance.now() - started).toBeLessThan(900);

    const answers: unknown[] = [];
    const sub = new ForgeRpcClient({ url: url(), token: RPC_TOKEN }).send("shop.slow", { ms: 150 }).subscribe({ next: (v) => answers.push(v), error: (e) => answers.push(e) });
    sub.unsubscribe();
    await Bun.sleep(300);
    expect(answers).toEqual([]);

    const down = createForgeRpcClient<Rpc>({ url: `http://127.0.0.1:${await freePort()}`, token: RPC_TOKEN }).shop;
    expect(await failure(down.add.query({ a: 1, b: 1 }))).toMatchObject({ code: "SERVICE_UNAVAILABLE" });
  });

  test("emit() is refused: request-response only", async () => {
    const { ForgeRpcClient } = await rpc();
    const { rxjs } = await import("../src/nest");
    expect(await failure(rxjs.lastValueFrom(new ForgeRpcClient({ url: url(), token: RPC_TOKEN }).emit("shop.add", {})))).toMatchObject({ message: expect.stringContaining("request-response only") });
  });
});

/** A free port, for a server or a microservice of its own. */
async function freePort() {
  const probe = Bun.serve({ port: 0, fetch: () => new Response() });
  const port = probe.port!;
  await probe.stop(true);
  return port;
}
const startFixture = (dir: string, env: Record<string, string> = {}) =>
  startServer({
    forgeDir: join(import.meta.dir, dir),
    env: { ...process.env, RUNTIME_MODE: "process", PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", RATE_LIMIT_PER_MINUTE: "100000", LOG_FORMAT: "json", ...env },
  });

test("a client that leaves a streamed response is heard by the handler, through a child process too", async () => {
  const stop = new AbortController();
  const res = await http("/express/forever", { signal: stop.signal });
  const reader = res.body!.getReader();
  expect(new TextDecoder().decode((await reader.read()).value)).toContain("start");
  stop.abort();
  await reader.cancel().catch(() => {});
  let closed = false;
  for (let i = 0; i < 40 && !closed; i++) (await Bun.sleep(50), (closed = ((await (await http("/express/forever-closed")).json()) as any).closed));
  expect(closed).toBe(true);
});

test("the transport clients are installed where @nestjs/microservices loads them", async () => {
  const { createRequire } = await import("node:module");
  const load = createRequire(Bun.resolveSync("@nestjs/microservices", import.meta.dir));
  for (const name of ["ioredis", "nats", "mqtt", "kafkajs", "amqplib", "amqp-connection-manager", "@grpc/grpc-js", "@grpc/proto-loader"]) expect(load.resolve(name), name).toBeString();
});

describe("with two function runtime processes", () => {
  let pool: RunningServer;
  let port: number;
  // Two processes that each load Nest, GraphQL and the fixture: slower than the default 5 s while the rest of the file runs beside them.
  beforeAll(async () => {
    port = await freePort();
    pool = await startFixture("fixture-nest", { RUNTIME_WORKERS: "2", NEST_TCP_PORT: String(port) });
  }, 20_000);
  afterAll(() => pool.stop({ graceful: false }));

  test("every gateway socket is on the first worker, so a broadcast reaches all of them", async () => {
    const sockets = await Promise.all([1, 2, 3].map(() => socket(pool.url, "/ws")));
    for (const s of sockets) expect(await s.ask("worker")).toEqual({ event: "worker", data: "0" });
    sockets[0]!.ws.send(JSON.stringify({ event: "shout", data: "everyone" }));
    for (const s of sockets) expect(await s.next()).toEqual({ event: "shout", data: "everyone" });
    sockets.forEach((s) => s.ws.close());
  });

  test("a subscription hears mutations that ran on either worker, and the microservice is bound once", async () => {
    const { createClient } = await import("graphql-ws");
    const client = createClient({ url: `${pool.url.replace(/^http/, "ws")}/http/graphql`, webSocketImpl: WebSocket, retryAttempts: 0 });
    const texts: string[] = [];
    const all = new Promise<void>((resolve) => client.subscribe({ query: "subscription { noteAdded { text } }" }, { next: (v: any) => (texts.push(v.data.noteAdded.text), texts.length === 4 && resolve()), error: () => resolve(), complete: () => {} }));
    await Bun.sleep(300);
    // Requests take turns between the two workers, so these four ran on both.
    for (const i of [1, 2, 3, 4]) await http0(pool, "/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: `mutation { addNote(text: "n${i}") }` }) });
    await all;
    expect(texts.sort()).toEqual(["n1", "n2", "n3", "n4"]);
    await client.dispose();

    const { ClientProxyFactory, Transport } = await import("../src/nest-microservices");
    const { rxjs } = await import("../src/nest");
    const tcp = ClientProxyFactory.create({ transport: Transport.TCP, options: { host: "127.0.0.1", port } });
    expect(await rxjs.firstValueFrom(tcp.send("sum", [2, 3]))).toBe(5);
    await tcp.close();
    for (const i of [1, 2]) expect((await http0(pool, "/notes/text")).status).toBe(200); // the Nest app runs on both workers (a second bind would have failed it on one)
  });
});
const http0 = (server: RunningServer, path: string, init?: RequestInit) => fetch(`${server.url}/http${path}`, init);

describe("Socket.IO gateways", () => {
  let io: RunningServer;
  beforeAll(async () => (io = await startFixture("fixture-nest-io")));
  afterAll(() => io.stop({ graceful: false }));
  const connect = async (namespace = "", transports: ("websocket" | "polling")[] = ["websocket"]) => {
    const { io: client } = await import("socket.io-client");
    const s = client(`${io.url}${namespace}`, { path: "/http/socket.io", transports, reconnection: false });
    await new Promise<void>((resolve, reject) => (s.on("connect", () => resolve()), s.on("connect_error", reject)));
    return s;
  };

  test("acks, the ctx, rooms, a namespace and exceptions, over WebSocket", async () => {
    const a = await connect();
    const b = await connect();
    expect(await a.emitWithAck("echo", { hi: 1 })).toEqual({ hi: 1 });
    expect(await a.emitWithAck("who")).toEqual({ identity: null });
    expect(await b.emitWithAck("join", "room1")).toBe("joined");
    const told = new Promise<string>((resolve) => b.on("told", resolve));
    a.emit("tell", { room: "room1", text: "psst" });
    expect(await told).toBe("psst");
    const failed = new Promise<any>((resolve) => a.on("exception", resolve));
    a.emit("fail", {});
    expect(await failed).toMatchObject({ status: "error", message: "nope" });
    const admin = await connect("/admin");
    expect(await admin.emitWithAck("ping")).toBe("pong");
    [a, b, admin].forEach((s) => s.disconnect());
  });

  test("clients that start with long-polling work, and upgrade", async () => {
    const polling = await connect("", ["polling"]);
    expect(await polling.emitWithAck("echo", "by polling")).toBe("by polling");
    polling.disconnect();
    const upgrading = await connect("", ["polling", "websocket"]);
    expect(await upgrading.emitWithAck("echo", "either")).toBe("either");
    upgrading.disconnect();
  });
});

describe("schema-first GraphQL, mounted as nest(http, AppModule)", () => {
  let sdl: RunningServer;
  beforeAll(async () => (sdl = await startFixture("fixture-nest-sdl")));
  afterAll(() => sdl.stop({ graceful: false }));

  test("the resolvers named in notes.graphql answer", async () => {
    const gql = async (query: string) => (await (await http0(sdl, "/graphql", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query }) })).json()) as any;
    expect(typeof (await gql('mutation { addNote(text: "sdl") }')).data.addNote).toBe("string");
    expect((await gql("{ notes { text } }")).data.notes).toEqual([{ text: "sdl" }]);
  });
});
