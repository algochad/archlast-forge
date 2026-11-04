// The Forge RPC fork (src/forge-rpc): the wire format, the batching client, and compatibility with stock tRPC in both directions.
import { afterAll, describe, expect, test } from "bun:test";
import { createTRPCUntypedClient, httpBatchLink } from "@trpc/client";
import { initTRPC } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { z } from "zod";
import {
  createCaller,
  createHandler,
  createRpc,
  RpcFailure,
  type Procedure,
  type WireError,
} from "../src/forge-rpc";

const TOKEN = "Bearer test-token-0123456789";
const servers: ReturnType<typeof Bun.serve>[] = [];
afterAll(() => servers.forEach((s) => s.stop(true)));

const procedures = new Map<string, Procedure>([
  [
    "math.add",
    {
      kind: "query",
      input: z.object({ a: z.number(), b: z.number() }),
      output: z.object({ sum: z.number() }),
      run: async (i: any) => ({ sum: i.a + i.b }),
    },
  ],
  [
    "math.store",
    {
      kind: "mutation",
      input: z.object({ n: z.number() }),
      run: async (i: any) => ({ stored: i.n }),
    },
  ],
  ["math.nothing", { kind: "mutation", run: async () => undefined }],
  [
    "math.noinput",
    { kind: "query", run: async (i) => ({ gotInput: i !== undefined }) },
  ],
  [
    "math.refused",
    {
      kind: "mutation",
      run: async () =>
        Promise.reject(
          new RpcFailure("BAD_REQUEST", "out of stock", { sku: "a" }, "req-1"),
        ),
    },
  ],
  [
    "math.crash",
    {
      kind: "mutation",
      run: async () => Promise.reject(new Error("SELECT secret FROM users")),
    },
  ],
  [
    "math.drift",
    {
      kind: "query",
      output: z.object({ ok: z.boolean() }),
      run: async () => ({ ok: "yes" }),
    },
  ],
  [
    "math.slow",
    {
      kind: "query",
      input: z.object({ ms: z.number() }),
      run: async (i: any) => (await Bun.sleep(i.ms), "done"),
    },
  ],
  [
    "math.nullable",
    {
      kind: "query",
      input: z.union([z.null(), z.undefined()]),
      run: async (i) => ({ isNull: i === null, isUndefined: i === undefined }),
    },
  ],
  ["math.trace", { kind: "query", run: async (_i, trace) => ({ trace }) }],
  [
    "math.async",
    {
      kind: "query",
      input: z
        .string()
        .refine(async (s) => (await Bun.sleep(1), s.startsWith("ok"))),
      run: async (i) => i,
    },
  ],
  [
    "math.standard",
    {
      kind: "query",
      input: {
        "~standard": {
          version: 1,
          vendor: "test",
          validate: (v: any) =>
            typeof v?.x === "number"
              ? { value: v }
              : { issues: [{ message: "x must be a number" }] },
        },
      },
      run: async (i) => i,
    },
  ],
]);

let requests = 0;
const serve = (maxBatch?: number) => {
  const handler = createHandler({
    procedures,
    authorized: (h) => h === TOKEN,
    maxBatch,
  });
  const s = Bun.serve({ port: 0, fetch: (req) => (requests++, handler(req)) });
  servers.push(s);
  return `http://127.0.0.1:${s.port}`;
};
const url = serve();
const post = (
  path: string,
  body: unknown,
  headers: Record<string, string> = { authorization: TOKEN },
) =>
  fetch(`${url}/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("wire format", () => {
  test("a batch is answered in order with one status", async () => {
    const res = await post("math.add,math.add?batch=1", {
      0: { a: 1, b: 2 },
      1: { a: 10, b: 20 },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual([
      { result: { data: { sum: 3 } } },
      { result: { data: { sum: 30 } } },
    ]);
  });

  test("a single call is answered with an object, not an array", async () => {
    const res = await post("math.add", { a: 1, b: 1 });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ result: { data: { sum: 2 } } });
  });

  test("an error carries tRPC's code, the HTTP status and the path; the status is the common one, or 207", async () => {
    const mixed = await post("math.add,nope.x,math.add?batch=1", {
      0: { a: 1, b: 1 },
      1: {},
      2: { a: "1" },
    });
    expect(mixed.status).toBe(207);
    const [ok, missing, bad] = (await mixed.json()) as any[];
    expect(ok).toEqual({ result: { data: { sum: 2 } } });
    expect(missing).toEqual({
      error: {
        message: 'No procedure found on path "nope.x"',
        code: -32004,
        data: { code: "NOT_FOUND", httpStatus: 404, path: "nope.x" },
      },
    });
    expect(bad.error).toMatchObject({
      code: -32600,
      data: { code: "BAD_REQUEST", httpStatus: 400, path: "math.add" },
    });
    expect(bad.error.message).toContain("expected number");
    const allMissing = await post("a.b,c.d?batch=1", { 0: {}, 1: {} });
    expect(allMissing.status).toBe(404);
  });

  test("a call's own failure keeps its message, data and request id; anything else is a request id and nothing more", async () => {
    const refused = await post("math.refused", {});
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({
      error: {
        message: "out of stock",
        code: -32600,
        data: {
          code: "BAD_REQUEST",
          httpStatus: 400,
          path: "math.refused",
          requestId: "req-1",
          data: { sku: "a" },
        },
      },
    });
    const crash = await post("math.crash", {});
    const body = await crash.text();
    expect(crash.status).toBe(500);
    expect(body).not.toContain("SELECT");
    expect(body).not.toContain("stack");
    expect(JSON.parse(body).error.message).toMatch(
      /^Server error \(request [0-9a-f-]{36}\)$/,
    );
    const drift = await post("math.drift", {});
    expect(drift.status).toBe(500);
    expect(JSON.parse(await drift.text()).error.message).toMatch(
      /^Server error \(request /,
    );
  });

  test("the token is checked before anything else, and every call in the batch is refused", async () => {
    for (const headers of [
      {} as Record<string, string>,
      { authorization: "Bearer wrong" },
    ]) {
      const res = await post(
        "math.add,nope.x?batch=1",
        { 0: { a: 1, b: 1 }, 1: {} },
        headers,
      );
      expect(res.status).toBe(401);
      const body = (await res.json()) as any[];
      expect(body.map((r) => r.error.data.code)).toEqual([
        "UNAUTHORIZED",
        "UNAUTHORIZED",
      ]);
    }
  });

  test("a procedure without an input schema gets no input; an output of undefined has no data", async () => {
    expect(await (await post("math.noinput", { anything: 1 })).json()).toEqual({
      result: { data: { gotInput: false } },
    });
    expect(await (await post("math.nothing", {})).text()).toBe('{"result":{}}');
  });

  test("GET reads a query's input from the URL and refuses a mutation", async () => {
    const get = await fetch(
      `${url}/math.add?input=${encodeURIComponent(JSON.stringify({ a: 2, b: 2 }))}`,
      { headers: { authorization: TOKEN } },
    );
    expect(await get.json()).toEqual({ result: { data: { sum: 4 } } });
    const batch = await fetch(
      `${url}/math.add,math.store?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { a: 1, b: 1 }, 1: { n: 1 } }))}`,
      { headers: { authorization: TOKEN } },
    );
    const [q, m] = (await batch.json()) as any[];
    expect(q.result.data).toEqual({ sum: 2 });
    expect(m.error.data).toMatchObject({
      code: "METHOD_NOT_SUPPORTED",
      httpStatus: 405,
    });
    expect(
      (
        await fetch(`${url}/math.add`, {
          method: "PUT",
          headers: { authorization: TOKEN },
        })
      ).status,
    ).toBe(405);
  });

  test("a body that isn't JSON is a BAD_REQUEST; a batch over the limit is refused whole", async () => {
    const bad = await post("math.add", "{oops");
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as any).error.data.code).toBe("BAD_REQUEST");
    const small = serve(2);
    const res = await fetch(
      `${small}/math.noinput,math.noinput,math.noinput?batch=1`,
      { method: "POST", headers: { authorization: TOKEN }, body: "{}" },
    );
    expect(res.status).toBe(413);
    expect(((await res.json()) as any[]).length).toBe(3);
  });

  test("an async Zod schema and a plain Standard Schema both validate, with a message", async () => {
    expect(await (await post("math.async", '"ok-1"')).json()).toEqual({
      result: { data: "ok-1" },
    });
    expect(await (await post("math.async", '"ok-1"')).json()).toEqual({
      result: { data: "ok-1" },
    }); // the second goes straight to the async path
    expect(
      ((await (await post("math.async", '"no"')).json()) as any).error.data
        .code,
    ).toBe("BAD_REQUEST");
    expect(await (await post("math.standard", { x: 1 })).json()).toEqual({
      result: { data: { x: 1 } },
    });
    const bad = (await (await post("math.standard", { x: "1" })).json()) as any;
    expect(bad.error.data.code).toBe("BAD_REQUEST");
    expect(bad.error.message).toContain("x must be a number");
  });
});

describe("the caller over HTTP", () => {
  const caller = (
    u = url,
    extra: Partial<Parameters<typeof createCaller>[0]> = {},
  ) =>
    createCaller({
      url: u,
      authorization: () => TOKEN,
      timeoutMs: 2000,
      websocket: false,
      ...extra,
    });
  const call = (
    c: ReturnType<typeof createCaller>,
    pattern: string,
    input: unknown,
  ) =>
    new Promise<{ error: WireError | null; value?: unknown }>((resolve) =>
      c(pattern, input, (error, value) => resolve({ error, value })),
    );

  test("calls made in one tick go out as one request, in chunks of maxItems", async () => {
    const c = caller(url, { maxItems: 10 });
    requests = 0;
    const all = await Promise.all(
      Array.from({ length: 25 }, (_, i) => call(c, "math.add", { a: i, b: 1 })),
    );
    expect(all.map((r) => (r.value as any).sum)).toEqual(
      Array.from({ length: 25 }, (_, i) => i + 1),
    );
    expect(requests).toBe(3);
  });

  test("a failed call carries the server's code, message, data and request id", async () => {
    const r = await call(caller(), "math.refused", {});
    expect(r.error).toEqual({
      status: "error",
      message: "out of stock",
      code: "BAD_REQUEST",
      data: { sku: "a" },
      requestId: "req-1",
    });
    expect((await call(caller(), "nope.x", {})).error).toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await call(caller(), "math.add", { a: 1, b: 1 })).value).toEqual({
      sum: 2,
    });
  });

  test("an input of undefined is sent as no input", async () => {
    expect((await call(caller(), "math.noinput", undefined)).value).toEqual({
      gotInput: false,
    });
  });

  test("a call that outlives the timeout fails with TIMEOUT, the others in its request still answer", async () => {
    const c = caller(url, { timeoutMs: 100 });
    const started = performance.now();
    const [slow, fast] = await Promise.all([
      call(c, "math.slow", { ms: 1000 }),
      call(c, "math.add", { a: 1, b: 1 }),
    ]);
    // They share a request, so the answer for both comes when the server has it all: the fast one waits for the slow one and also times out.
    expect(slow.error?.code).toBe("TIMEOUT");
    expect(fast.error?.code ?? "TIMEOUT").toBe("TIMEOUT");
    expect(performance.now() - started).toBeLessThan(900);
    // Apart, each in its own request, the fast one is unaffected.
    const apart = await call(c, "math.add", { a: 2, b: 2 });
    expect(apart.value).toEqual({ sum: 4 });
  });

  test("a cancelled call never answers; one cancelled before the tick never goes out; the request stops when all its calls are over", async () => {
    const c = caller();
    const answers: unknown[] = [];
    requests = 0;
    const cancel = c("math.slow", { ms: 150 }, (e, v) => answers.push(e ?? v));
    cancel();
    await Bun.sleep(50);
    expect(requests).toBe(0);
    const cancelLate = c("math.slow", { ms: 100 }, (e, v) =>
      answers.push(e ?? v),
    );
    await Bun.sleep(20);
    cancelLate();
    await Bun.sleep(250);
    expect(answers).toEqual([]);
  });

  test("an unreachable service, a server that isn't Forge RPC, and a token that can't be read", async () => {
    const dead = Bun.serve({ port: 0, fetch: () => new Response("") });
    const port = dead.port;
    await dead.stop(true);
    expect(
      (
        await call(caller(`http://127.0.0.1:${port}`), "math.add", {
          a: 1,
          b: 1,
        })
      ).error,
    ).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.stringContaining("did not answer math.add"),
    });
    const html = Bun.serve({
      port: 0,
      fetch: () => new Response("<html>nope</html>", { status: 502 }),
    });
    servers.push(html);
    expect(
      (
        await call(caller(`http://127.0.0.1:${html.port}`), "math.add", {
          a: 1,
          b: 1,
        })
      ).error,
    ).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.stringContaining("status 502"),
    });
    const noToken = createCaller({
      url,
      timeoutMs: 1000,
      authorization: () => {
        throw new Error("no token");
      },
    });
    expect((await call(noToken, "math.add", { a: 1, b: 1 })).error).toEqual({
      status: "error",
      message: "no token",
      code: "UNAUTHORIZED",
    });
  });
});

describe("the caller over a WebSocket", () => {
  let upgrades = 0;
  const serveWs = (maxBatch?: number, token = TOKEN) => {
    const rpc = createRpc({
      procedures,
      authorized: (h) => h === token,
      maxBatch,
    });
    const s = Bun.serve({
      port: 0,
      fetch: (req, server) => {
        if (req.headers.get("upgrade") === "websocket") upgrades++;
        return rpc.fetch(req, server);
      },
      websocket: rpc.websocket,
    });
    servers.push(s);
    return { url: `http://127.0.0.1:${s.port}`, server: s };
  };
  const wsUrl = serveWs().url;
  type Call = ReturnType<typeof createCaller>;
  const caller = (
    u = wsUrl,
    extra: Partial<Parameters<typeof createCaller>[0]> = {},
  ) =>
    createCaller({
      url: u,
      authorization: () => TOKEN,
      timeoutMs: 2000,
      ...extra,
    });
  const call = (c: Call, pattern: string, input: unknown) =>
    new Promise<{ error: WireError | null; value?: unknown }>((resolve) =>
      c(pattern, input, (error, value) => resolve({ error, value })),
    );
  const open = async (base: string) => {
    const ws = new WebSocket(`ws://${base.slice(7)}/_ws`, {
      headers: { authorization: TOKEN },
    } as never);
    await new Promise((r) => (ws.onopen = r));
    return ws;
  };

  test("the protocol: a frame of calls is answered with frames of [id, result] pairs", async () => {
    const ws = await open(wsUrl);
    const frames: any[] = [];
    ws.onmessage = (e) => frames.push(JSON.parse(e.data as string));
    ws.send(
      JSON.stringify([
        [1, "math.add", { a: 1, b: 2 }],
        [-2, "math.noinput"],
        [3, "nope.x", {}],
        [4, "math.add", { a: "1" }],
      ]),
    );
    await Bun.sleep(100);
    const answers = Object.fromEntries(
      frames.flat().map(([id, r]: [number, any]) => [id, r]),
    );
    expect(answers[1]).toEqual({ result: { data: { sum: 3 } } });
    expect(answers[2]).toEqual({ result: { data: { gotInput: false } } });
    expect(answers[3].error.data).toMatchObject({
      code: "NOT_FOUND",
      httpStatus: 404,
      path: "nope.x",
    });
    expect(answers[4].error.data).toMatchObject({ code: "BAD_REQUEST" });
    ws.close();
  });

  test("the upgrade needs the token; a bad frame closes the connection", async () => {
    const refused = await fetch(`${wsUrl}/_ws`, {
      headers: {
        upgrade: "websocket",
        connection: "Upgrade",
        "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
        "sec-websocket-version": "13",
      },
    });
    expect(refused.status).toBe(401);
    const small = serveWs(2).url;
    for (const [frame, code] of [
      [
        JSON.stringify([
          [1, "math.noinput"],
          [2, "math.noinput"],
          [3, "math.noinput"],
        ]),
        1009,
      ],
      ["not json", 1007],
      [JSON.stringify([[1, 5]]), 1007],
    ] as const) {
      const ws = await open(small);
      const closed = new Promise<number>(
        (r) => (ws.onclose = (e) => r(e.code)),
      );
      ws.send(frame);
      expect(await closed).toBe(code);
    }
  });

  test("calls made in one tick share a connection and are answered", async () => {
    const c = caller();
    upgrades = 0;
    const all = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        call(c, "math.add", { a: i, b: 1 }),
      ),
    );
    expect(all.map((r) => (r.value as any).sum)).toEqual(
      Array.from({ length: 300 }, (_, i) => i + 1),
    );
    expect((await call(c, "math.add", { a: 5, b: 5 })).value).toEqual({
      sum: 10,
    });
    expect(upgrades).toBe(1);
    c.close();
  });

  test("errors carry the service's code, message, data and request id", async () => {
    const c = caller();
    expect((await call(c, "math.refused", {})).error).toEqual({
      status: "error",
      message: "out of stock",
      code: "BAD_REQUEST",
      data: { sku: "a" },
      requestId: "req-1",
    });
    expect((await call(c, "nope.x", {})).error).toMatchObject({
      code: "NOT_FOUND",
    });
    const crash = (await call(c, "math.crash", {})).error!;
    expect(crash.code).toBe("INTERNAL_SERVER_ERROR");
    expect(crash.message).toMatch(/^Server error \(request /);
    expect(JSON.stringify(crash)).not.toContain("SELECT");
    c.close();
  });

  test("no input and a null input stay different", async () => {
    const c = caller();
    expect((await call(c, "math.nullable", null)).value).toEqual({
      isNull: true,
      isUndefined: false,
    });
    expect((await call(c, "math.nullable", undefined)).value).toEqual({
      isNull: false,
      isUndefined: true,
    });
    c.close();
  });

  test("the trace goes along as a traceparent, and its span ends once with how the call ended", async () => {
    const ended: (string | undefined)[] = [];
    const tp = "00-0af7651916cd43dd8448eb211c80319c-b7ad6b7169203331-01";
    const c = caller(wsUrl, {
      trace: () => ({ traceparent: tp, end: (e) => ended.push(e) }),
    });
    expect((await call(c, "math.trace", {})).value).toEqual({ trace: tp });
    await call(c, "nope.x", {});
    expect(ended.length).toBe(2);
    expect(ended[0]).toBeUndefined();
    expect(ended[1]).toContain("NOT_FOUND");
    c.close();
  });

  test("a slow call doesn't hold up the others, and a timeout leaves the connection usable", async () => {
    const c = caller(wsUrl, { timeoutMs: 150 });
    const started = performance.now();
    const [slow, fast] = await Promise.all([
      call(c, "math.slow", { ms: 500 }),
      call(c, "math.add", { a: 1, b: 1 }),
    ]);
    expect(fast.value).toEqual({ sum: 2 }); // answered as soon as it finishes, though it shares a frame and a deadline with the slow one
    expect(slow.error?.code).toBe("TIMEOUT");
    expect(performance.now() - started).toBeLessThan(450);
    expect((await call(c, "math.add", { a: 2, b: 2 })).value).toEqual({
      sum: 4,
    });
    await Bun.sleep(450); // the slow one's late answer is ignored
    expect((await call(c, "math.add", { a: 3, b: 3 })).value).toEqual({
      sum: 6,
    });
    c.close();
  });

  test("a cancelled call never answers", async () => {
    const c = caller();
    const answers: unknown[] = [];
    const cancel = c("math.slow", { ms: 80 }, (e, v) => answers.push(e ?? v));
    await Bun.sleep(20);
    cancel();
    await Bun.sleep(200);
    expect(answers).toEqual([]);
    c.close();
  });

  test("a call in flight when the connection drops fails, and the next call connects again", async () => {
    const { url: u, server } = serveWs();
    const c = caller(u);
    expect((await call(c, "math.add", { a: 1, b: 1 })).value).toEqual({
      sum: 2,
    });
    const inFlight = call(c, "math.slow", { ms: 400 });
    await Bun.sleep(30);
    await server.stop(true);
    expect((await inFlight).error).toMatchObject({
      code: "SERVICE_UNAVAILABLE",
      message: expect.stringContaining("connection closed"),
    });
    c.close();
  });

  test("a service that won't take a WebSocket is called over HTTP and not asked again for a while; a wrong token is reported", async () => {
    const c = caller(url); // `url` is the HTTP-only server at the top
    expect((await call(c, "math.add", { a: 1, b: 1 })).value).toEqual({
      sum: 2,
    });
    expect((await call(c, "math.add", { a: 2, b: 2 })).value).toEqual({
      sum: 4,
    });
    const w = caller(serveWs(undefined, "Bearer other").url);
    expect((await call(w, "math.add", { a: 1, b: 1 })).error).toMatchObject({
      code: "UNAUTHORIZED",
    });
    c.close();
    w.close();
  });

  test("a caller can always choose HTTP", async () => {
    upgrades = 0;
    const c = caller(wsUrl, { websocket: false });
    expect((await call(c, "math.add", { a: 1, b: 1 })).value).toEqual({
      sum: 2,
    });
    expect(upgrades).toBe(0);
  });
});

describe("compatibility with stock tRPC", () => {
  test("a stock tRPC client (httpBatchLink) calls a Forge RPC server, batched, with mixed results", async () => {
    const client = createTRPCUntypedClient({
      links: [
        httpBatchLink({
          url,
          methodOverride: "POST",
          headers: { authorization: TOKEN },
        }),
      ],
    });
    const [sum, stored, refused] = await Promise.allSettled([
      client.query("math.add", { a: 4, b: 5 }),
      client.mutation("math.store", { n: 7 }),
      client.mutation("math.refused", {}),
    ]);
    expect(sum).toMatchObject({ status: "fulfilled", value: { sum: 9 } });
    expect(stored).toMatchObject({ status: "fulfilled", value: { stored: 7 } });
    expect(refused).toMatchObject({
      status: "rejected",
      reason: {
        message: "out of stock",
        data: { code: "BAD_REQUEST", httpStatus: 400, requestId: "req-1" },
      },
    });
    await expect(client.mutation("math.nothing", {})).resolves.toBeUndefined();
  });

  test("a Forge RPC caller calls a stock tRPC server", async () => {
    const t = initTRPC.create({ isDev: false });
    const router = t.router({
      math: t.router({
        add: t.procedure
          .input(z.object({ a: z.number(), b: z.number() }))
          .query(({ input }) => ({ sum: input.a + input.b })),
        store: t.procedure
          .input(z.object({ n: z.number() }))
          .mutation(({ input }) => ({ stored: input.n })),
      }),
    });
    const s = Bun.serve({
      port: 0,
      fetch: (req) =>
        fetchRequestHandler({
          endpoint: "",
          req,
          router,
          allowMethodOverride: true,
          createContext: () => ({}),
        }),
    });
    servers.push(s);
    const c = createCaller({
      url: `http://127.0.0.1:${s.port}`,
      authorization: () => TOKEN,
      timeoutMs: 2000,
    });
    const call = (p: string, i: unknown) =>
      new Promise<{ error: WireError | null; value?: unknown }>((resolve) =>
        c(p, i, (error, value) => resolve({ error, value })),
      );
    // tRPC's own rule: a request carries calls of one kind, so the mutations go together and the query goes alone.
    const [stored, bad, missing] = await Promise.all([
      call("math.store", { n: 3 }),
      call("math.store", { n: "x" }),
      call("math.nope", {}),
    ]);
    expect(stored.value).toEqual({ stored: 3 });
    expect(bad.error).toMatchObject({ code: "BAD_REQUEST" });
    expect(missing.error).toMatchObject({ code: "NOT_FOUND" });
    expect((await call("math.add", { a: 1, b: 2 })).value).toEqual({ sum: 3 });
  });
});
