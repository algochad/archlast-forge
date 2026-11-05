// The API docs as an app's public REST reference (issue #18): validators that document and check more, a document for one audience with the
// app's real authentication, errors, headers and webhooks, configured in code, and served only at the paths the docs own.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Validator as OpenApiValidator } from "@seriousme/openapi-schema-validator";
import { join } from "node:path";
import { docsRouting } from "../src/api-docs";
import { httpRouter } from "../src/functions";
import { queryValue } from "../src/server/http";
import { buildOpenApi, toJsonSchema } from "../src/server/openapi";
import { startServer, type ApiDocsHost, type AppHost, type RunningServer } from "../src/server/server";
import { v, validate } from "../src/values";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture-docs");
const fails = (validator: Parameters<typeof validate>[0], value: unknown) => {
  try {
    validate(validator, value, "x");
    return null;
  } catch (e) {
    return (e as Error).message;
  }
};

describe("validators that say more", () => {
  test("literals and enums check their values and say which they are", () => {
    expect(fails(v.literal("v1"), "v1")).toBeNull();
    expect(fails(v.literal("v1"), "v2")).toBe(`x must be "v1", got "v2"`);
    const kind = v.enum("one_time", "subscription");
    expect(fails(kind, "subscription")).toBeNull();
    expect(fails(kind, "monthly")).toBe(`x must be one of "one_time" | "subscription", got "monthly"`);
    expect(() => v.enum("a", "a")).toThrow(/different/);
  });

  test("nullable is present-but-null; optional stays may-be-absent", () => {
    const at = v.nullable(v.string());
    expect(fails(at, null)).toBeNull();
    expect(fails(at, "2026-01-01")).toBeNull();
    expect(fails(at, undefined)).toBe("x is required");
    expect(fails(v.optional(v.nullable(v.number())), undefined)).toBeNull();
  });

  test("constraints are enforced, with messages that say which rule", () => {
    const limit = v.number({ int: true, min: 1, max: 100 });
    expect(fails(limit, 50)).toBeNull();
    expect(fails(limit, 0)).toBe("x must be at least 1, got 0");
    expect(fails(limit, 101)).toBe("x must be at most 100, got 101");
    expect(fails(limit, 1.5)).toBe("x must be a whole number, got 1.5");
    expect(fails(v.number({ exclusiveMin: 0 }), 0)).toBe("x must be more than 0, got 0");
    const code = v.string({ minLength: 3, maxLength: 3, pattern: "^[A-Z]+$" });
    expect(fails(code, "USD")).toBeNull();
    expect(fails(code, "US")).toBe("x must be at least 3 characters, got 2");
    expect(fails(code, "usd")).toBe(`x must match ^[A-Z]+$, got "usd"`);
    expect(fails(v.string({ minLength: 1 }), "")).toBe("x must not be empty");
    expect(fails(v.string({ format: "email" }), "ada@example.com")).toBeNull();
    expect(fails(v.string({ format: "email" }), "ada")).toMatch(/must be an email address/);
    expect(fails(v.string({ format: "date-time" }), "2026-01-31T12:00:00Z")).toBeNull();
    expect(fails(v.string({ format: "date-time" }), "yesterday")).toMatch(/ISO 8601/);
    expect(fails(v.string({ format: "uri" }), "https://example.com/x")).toBeNull();
    const batch = v.array(v.string(), { minItems: 1, maxItems: 2, unique: true });
    expect(fails(batch, [])).toBe("x must have at least 1 item, got 0");
    expect(fails(batch, ["a", "b", "c"])).toBe("x must have at most 2 items, got 3");
    expect(fails(batch, ["a", "a"])).toBe("x must not repeat an item");
    // In an object, the path names the field.
    expect(fails(v.object({ price: v.object({ amount: v.number({ min: 1 }) }) }), { price: { amount: 0 } })).toBe("x.price.amount must be at least 1, got 0");
  });

  test("documentation is plain data and checks nothing; a bad constraint fails where it is written", () => {
    const described = v.describe(v.enum("a", "b"), { description: "Which.", example: "a" });
    expect(described.meta).toEqual({ description: "Which.", example: "a" });
    expect(fails(described, "a")).toBeNull();
    expect(JSON.parse(JSON.stringify(v.string({ maxLength: 4, description: "d" })))).toEqual({ kind: "string", optional: false, meta: { description: "d" }, checks: { maxLength: 4 } });
    expect(v.string()).toEqual({ kind: "string", optional: false }); // unchanged without options
    expect(() => v.string({ pattern: "(" })).toThrow();
    expect(() => v.array(v.string(), { minItems: -1 })).toThrow(/minItems/);
  });

  test("query values arrive as text and become the literal they spell", () => {
    expect(queryValue(v.enum("one_time", "subscription"), ["subscription"])).toBe("subscription");
    expect(queryValue(v.literal(1), ["1"])).toBe(1);
    expect(queryValue(v.literal(true), ["true"])).toBe(true);
    expect(queryValue(v.union(v.literal(1), v.literal(2)), ["2"])).toBe(2);
    expect(queryValue(v.nullable(v.string()), ["null"])).toBe(null);
  });
});

describe("JSON Schema for the document", () => {
  test("constraints, enums, nullables and documentation are in it", () => {
    expect(toJsonSchema(v.number({ int: true, min: 1, max: 100, description: "Page size", default: 20 }))).toEqual({ type: "integer", minimum: 1, maximum: 100, description: "Page size", default: 20 });
    expect(toJsonSchema(v.string({ format: "date-time", pattern: "^2", minLength: 1, example: "2026-01-31T00:00:00Z" }))).toEqual({
      type: "string",
      minLength: 1,
      pattern: "^2",
      format: "date-time",
      examples: ["2026-01-31T00:00:00Z"],
    });
    expect(toJsonSchema(v.enum("one_time", "subscription"))).toEqual({ type: "string", enum: ["one_time", "subscription"] });
    expect(toJsonSchema(v.nullable(v.enum("a", "b")))).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
    expect(toJsonSchema(v.nullable(v.string({ format: "date-time" })))).toEqual({ type: ["string", "null"], format: "date-time" });
    expect(toJsonSchema(v.literal(3))).toEqual({ type: "integer", const: 3 });
    expect(toJsonSchema(v.array(v.string(), { minItems: 1, maxItems: 100, unique: true }))).toEqual({ type: "array", items: { type: "string" }, minItems: 1, maxItems: 100, uniqueItems: true });
    expect(toJsonSchema(v.string({ deprecated: true, title: "Old" }))).toEqual({ type: "string", title: "Old", deprecated: true });
  });

  test("named validators are one schema each, under their own name, and two different ones can't share a name", () => {
    const Price = v.object({ amount: v.number() }, { name: "Price" });
    const doc = buildOpenApi({
      title: "t",
      version: "1",
      functions: [],
      nest: [],
      http: [
        { method: "GET", path: "/a", returns: v.object({ price: Price }), handler: { kind: "httpAction" } as never },
        { method: "GET", path: "/b", returns: v.array(Price), handler: { kind: "httpAction" } as never },
      ],
    });
    expect(Object.keys(doc.components.schemas)).toEqual(["Price"]);
    expect((doc.paths["/http/b"]!.get as any).responses["200"].content["application/json"].schema).toEqual({ type: "array", items: { $ref: "#/components/schemas/Price" } });
    // Unnamed shapes stay where they are: no Shared1, Shared2 that renumber when a schema is added.
    expect(JSON.stringify(doc)).not.toContain("Shared");
    const clash = () =>
      buildOpenApi({
        title: "t",
        version: "1",
        functions: [],
        nest: [],
        http: [
          { method: "GET", path: "/a", returns: Price, handler: { kind: "httpAction" } as never },
          { method: "GET", path: "/b", returns: v.object({ cents: v.number() }, { name: "Price" }), handler: { kind: "httpAction" } as never },
        ],
      });
    expect(clash).toThrow(/Two different validators are named "Price"/);
  });
});

describe("the document an app configures", () => {
  let http: ReturnType<typeof httpRouter>;
  let doc: any;
  beforeAll(async () => {
    http = (await import("./fixture-docs/http")).default;
    doc = buildOpenApi({
      title: "@midas/web",
      version: "abc123",
      functions: [{ name: "payments:count", kind: "query", visibility: "public", args: { status: v.optional(v.string()) }, returns: v.number() }],
      http: http.routes,
      httpRoot: true,
      nest: [],
      docs: http.docsConfig,
    });
  });

  test("is valid OpenAPI 3.1", async () => {
    const check = new OpenApiValidator();
    const result = await check.validate(doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
  });

  test("is for its audience: the REST API under /api/v1, without /rpc, the hidden inbound webhook, or anything else", () => {
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/payments"]);
    expect(JSON.stringify(doc)).not.toContain("/rpc/");
    expect(doc.components.securitySchemes.session).toBeUndefined(); // the engine's own schemes describe /rpc only
  });

  test("has the app's name, version, servers, tags and their groups", () => {
    expect(doc.info).toEqual({ title: "Midas API", version: "v1", description: "Payments." });
    expect(doc.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(doc.tags).toEqual([{ name: "Payments", description: "Charge a customer." }]);
    expect(doc["x-tagGroups"]).toEqual([{ name: "Core", tags: ["Payments"] }]);
  });

  test("states the real authentication, with each route's scopes", () => {
    expect(doc.components.securitySchemes.oauth.flows.clientCredentials.scopes).toHaveProperty("payments:write");
    expect(doc.security).toEqual([{ oauth: [] }]);
    const create = doc.paths["/api/v1/payments"].post;
    expect(create.security).toEqual([{ oauth: ["payments:write"] }]);
    expect(create["x-scopes"]).toEqual(["payments:write"]);
  });

  test("lists each route's errors in the app's error shape, with their codes", () => {
    const create = doc.paths["/api/v1/payments"].post;
    expect(Object.keys(create.responses).sort()).toEqual(["201", "400", "401", "409", "422", "429"]);
    expect(create.responses["409"]).toEqual({
      description: "`duplicate_payment`: The idempotency key was used for another request.",
      content: { "application/problem+json": { schema: { $ref: "#/components/schemas/Problem" } } },
    });
    expect(create["x-error-codes"]).toContainEqual({ status: "422", code: "currency_unsupported" });
    expect(create["x-error-codes"]).toContainEqual({ status: "401", code: "unauthorized" });
    // An http.route()'s validation error is the engine's own answer, so its 400 is the engine's error body.
    expect(create.responses["400"].content["application/json"].schema).toEqual({ $ref: "#/components/schemas/ErrorBody" });
    expect(doc.components.schemas.Problem.required).toEqual(["type", "title", "status", "code"]);
  });

  test("has headers, reusable parameters, examples and the app's own code samples", () => {
    const list = doc.paths["/api/v1/payments"].get;
    const create = doc.paths["/api/v1/payments"].post;
    expect(create.parameters).toContainEqual({ $ref: "#/components/parameters/idempotencyKey" });
    expect(create.parameters).toContainEqual({ $ref: "#/components/parameters/version" }); // global
    expect(list.parameters).toContainEqual({ $ref: "#/components/parameters/version" });
    expect(list.parameters).not.toContainEqual({ $ref: "#/components/parameters/idempotencyKey" });
    expect(doc.components.parameters.limit.schema).toEqual({ type: "integer", minimum: 1, maximum: 100, default: 20 });
    expect(create.responses["201"].headers).toEqual({ "x-request-id": { description: "The request's id, for support.", schema: { type: "string" } }, "Idempotent-Replayed": { description: "true when this answer is a replay.", schema: { type: "string" } } });
    expect(create.requestBody.content["application/json"].example).toEqual({ type: "one_time", price: { amount: 1, currency: "USD" } });
    expect(create["x-codeSamples"]).toEqual([{ lang: "node", label: "Node SDK", source: "await midas.payments.create({ ... })" }]);
    expect(list.parameters.find((p: any) => p.name === "type").schema).toEqual({ type: "string", enum: ["one_time", "subscription"] });
    expect(doc.components.schemas.Payment.properties.refundedAt).toEqual({ type: ["string", "null"], format: "date-time" });
  });

  test("describes the webhooks it sends: envelope, signature headers, retries", () => {
    const event = doc.webhooks["payment.succeeded"].post;
    expect(event.summary).toBe("A payment went through.");
    expect(event.parameters.map((p: any) => p.name)).toEqual(["webhook-id", "webhook-timestamp", "webhook-signature"]);
    const schema = event.requestBody.content["application/json"].schema;
    expect(schema.properties.type).toEqual({ type: "string", const: "payment.succeeded" });
    expect(schema.properties.data).toEqual({ $ref: "#/components/schemas/Payment" });
    expect(event.requestBody.content["application/json"].example.data.id).toBe("pay_123");
    expect(doc["x-webhooks-signing"]).toMatchObject({ scheme: "standard", retry: { attempts: 5, delayMs: 5000, factor: 4 }, toleranceMs: 300000 });
  });

  test("the complete document, for development, lists everything and marks what the public one leaves out", () => {
    const all = buildOpenApi({ title: "t", version: "1", functions: [{ name: "payments:count", kind: "query", visibility: "public", args: {} }], http: http.routes, httpRoot: true, nest: [], docs: http.docsConfig, audience: "all" });
    expect(all.paths["/api/webhooks/dodo"]!.post).toMatchObject({ "x-internal": true });
    expect(all.paths["/internal/stats"]!.get).toMatchObject({ "x-internal": true });
    expect(all.paths["/rpc/payments:count"]!.post).toMatchObject({ "x-internal": true });
    expect((all.paths["/api/v1/payments"]!.get as any)["x-internal"]).toBeUndefined();
  });

  test("mistakes in the configuration fail where they are written", () => {
    const router = httpRouter();
    expect(() => router.docs({ path: "/" })).toThrow(/path can't be "\/"/);
    expect(() => httpRouter().docs({ security: [{ nope: [] }] })).toThrow(/security scheme "nope"/);
    expect(() => httpRouter().docs({ include: ["api"] })).toThrow(/include/);
    router.docs({});
    expect(() => router.docs({})).toThrow(/once/);
    expect(docsRouting({ path: "/docs/" })).toMatchObject({ path: "/docs", openapi: "/docs/openapi.json", explorer: "/docs/explorer" });
    expect(docsRouting({ path: "/docs", explorer: false }, "/developers/api")).toMatchObject({ path: "/developers/api", openapi: "/developers/api/openapi.json", explorer: null, page: { explorer: false } });
  });
});

describe("serving the docs", () => {
  const started: RunningServer[] = [];
  afterAll(() => Promise.all(started.map((s) => s.stop({ graceful: false }))));
  const calls: Parameters<ApiDocsHost["serve"]>[1][] = [];
  const host: ApiDocsHost = {
    async serve(req, o) {
      calls.push(o);
      const path = new URL(req.url).pathname;
      if (path === o.base || path === `${o.base}/` || path === o.explorerPath) return new Response("the docs page", { headers: { "content-type": "text/html" } });
      if (path === `${o.base}/_docs/app.js`) return new Response("asset");
      return null;
    },
  };
  const app = (pages: string[]): AppHost => ({
    fetch: (req) => {
      const path = new URL(req.url).pathname;
      return pages.some((p) => path === p || path.startsWith(`${p}/`)) ? new Response(`app page ${path}`) : undefined;
    },
    matches: (path) => pages.some((p) => path === p),
  });
  const serve = async (o: { dev?: boolean; env?: Record<string, string>; app?: AppHost } = {}) => {
    const srv = await startServer({
      forgeDir: fixture,
      dev: o.dev ?? false,
      apiDocs: host,
      ...(o.app && { app: o.app }),
      env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", LOG_FORMAT: "json", RATE_LIMIT_PER_MINUTE: "100000", ...o.env },
    });
    started.push(srv);
    return srv;
  };
  const text = (srv: RunningServer, path: string) => fetch(`${srv.url}${path}`).then(async (r) => `${r.status} ${await r.text()}`);

  test("in production with production: true, at the configured paths only; the rest of /docs is the app's", async () => {
    const srv = await serve({ app: app(["/docs/api/products", "/docs/authentication"]) });
    expect(await text(srv, "/docs")).toBe("200 the docs page");
    expect(await text(srv, "/docs/try")).toBe("200 the docs page");
    expect(await text(srv, "/docs/_docs/app.js")).toBe("200 asset");
    // The app's own pages under the same prefix are not shadowed (they were a silent 404).
    expect(await text(srv, "/docs/api/products")).toBe("200 app page /docs/api/products");
    expect(await text(srv, "/docs/authentication")).toBe("200 app page /docs/authentication");
    const doc = await (await fetch(`${srv.url}/openapi.json`)).json();
    expect(doc.info.title).toBe("Midas API");
    expect(doc.servers).toEqual([{ url: "https://api.example.com" }]);
    expect(Object.keys(doc.paths)).toEqual(["/api/v1/payments"]);
    expect((await fetch(`${srv.url}/openapi.json?audience=all`).then((r) => r.json())).paths["/rpc/payments:count"]).toBeUndefined(); // dev only
    expect(calls.at(-1)).toMatchObject({ base: "/docs", publicBase: "/docs", openapiUrl: "/openapi.json", explorerPath: "/docs/try", dev: false, page: { title: "Midas", theme: { accent: "#6d28d9" } } });
    // The REST routes themselves still answer, with their validators (an enum in the query) applied.
    const bad = await fetch(`${srv.url}/api/v1/payments?type=monthly`);
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: { message: string } }).error.message).toBe(`query.type must be one of "one_time" | "subscription", got "monthly"`);
    expect(await text(srv, "/api/v1/payments?type=subscription")).toBe(`200 {"type":"subscription","page":[],"isDone":true}`);
  });

  test("API_DOCS and API_DOCS_PATH win over the code, and basePath reaches the page's URLs", async () => {
    const off = await serve({ env: { API_DOCS: "off" } });
    expect((await fetch(`${off.url}/openapi.json`)).status).toBe(404);
    expect((await fetch(`${off.url}/docs`)).status).toBe(404);
    const moved = await serve({ env: { API_DOCS_PATH: "/developers/api" } });
    expect(await text(moved, "/developers/api")).toBe("200 the docs page");
    expect((await fetch(`${moved.url}/openapi.json`)).status).toBe(200); // set in code on its own, so it stays
  });

  test("in development the complete document is there too", async () => {
    const srv = await serve({ dev: true });
    const all = await (await fetch(`${srv.url}/openapi.json?audience=all`)).json();
    expect(all.paths["/rpc/payments:count"].post["x-internal"]).toBe(true);
    expect(all.paths["/api/webhooks/dodo"].post["x-internal"]).toBe(true);
  });

  test("a page where the docs want to be: the app keeps it, and production refuses to start", async () => {
    const dev = await serve({ dev: true, app: app(["/docs"]) });
    expect(await text(dev, "/docs")).toBe("200 app page /docs");
    expect(await text(dev, "/docs/try")).toBe("200 the docs page"); // the rest of the docs' paths are still theirs
    await expect(serve({ app: app(["/docs"]) })).rejects.toThrow(/the API docs and the app both claim \/docs/);
  });
});
