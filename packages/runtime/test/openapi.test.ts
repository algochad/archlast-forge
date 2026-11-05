import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Validator as OpenApiValidator } from "@seriousme/openapi-schema-validator";
import { join } from "node:path";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { toJsonSchema } from "../src/server/openapi";
import { startServer, type RunningServer } from "../src/server/server";
import { v } from "../src/values";
import fixtureHttp from "./fixture/http";
import { tempDir } from "./helpers";

const fixture = join(import.meta.dir, "fixture");

test("validators become JSON Schema", () => {
  expect(toJsonSchema(v.string())).toEqual({ type: "string" });
  expect(toJsonSchema(v.id("todos"))).toMatchObject({ type: "string", pattern: "^todos:[0-9a-f]{32}$" });
  expect(toJsonSchema(v.array(v.union(v.number(), v.null())))).toEqual({ type: "array", items: { type: ["number", "null"] } });
  expect(toJsonSchema(v.union(v.string(), v.number()))).toEqual({ anyOf: [{ type: "string" }, { type: "number" }] });
  expect(toJsonSchema(v.object({ a: v.boolean(), b: v.optional(v.string()) }))).toEqual({
    type: "object",
    properties: { a: { type: "boolean" }, b: { type: "string" } },
    required: ["a"],
    additionalProperties: false,
  });
});

describe("the OpenAPI document, in dev", () => {
  let srv: RunningServer;
  beforeAll(async () => {
    srv = await startServer({ forgeDir: fixture, dev: true, env: { ...process.env, PORT: "0", DATA_DIR: tempDir() } });
  });
  afterAll(() => srv.stop());
  // decompress: false, or Bun's fetch would undo the encoding before the test sees it.
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`${srv.url}${path}`, { headers: { "accept-encoding": "identity", ...headers }, decompress: false } as RequestInit);

  test("is valid OpenAPI 3.1, lists every /http route and public function, and no internal one", async () => {
    const res = await get("/_api/openapi.json");
    expect(res.headers.get("content-type")).toBe("application/json");
    const text = await res.text();
    expect(text).not.toContain("\n"); // minified
    const doc = JSON.parse(text);
    const check = new OpenApiValidator();
    const result = await check.validate(doc);
    expect(result.errors ?? []).toEqual([]);
    expect(result.valid).toBe(true);
    expect(check.version).toBe("3.1");

    for (const r of fixtureHttp.routes) {
      const path = r.path !== undefined ? `/http${r.path}` : `/http${r.pathPrefix}{rest}`;
      expect(doc.paths[path]?.[r.method.toLowerCase()], `${r.method} ${path}`).toBeDefined();
    }
    expect(doc.paths["/rpc/todos:createList"].post.requestBody.content["application/json"].schema).toEqual({
      type: "object",
      properties: { name: { type: "string" } },
      required: ["name"],
      additionalProperties: false,
    });
    expect(Object.keys(doc.paths).some((p) => p.includes("secretCount"))).toBe(false); // internal
    expect(doc.servers).toEqual([{ url: srv.url }]); // no BETTER_AUTH_URL here: the address it was asked at

    const order = doc.paths["/http/orders"].post;
    expect(order).toMatchObject({ summary: "Place an order", tags: ["Orders"] });
    expect(order.parameters).toEqual([
      { name: "dryRun", in: "query", required: false, schema: { type: "boolean" } },
      { name: "limit", in: "query", required: false, schema: { type: "number" } },
    ]);
    expect(order.requestBody.content["application/json"].schema.required).toEqual(["sku", "qty"]);
    expect(order.responses["200"].content["application/json"].schema.properties.dryRun).toEqual({ type: "boolean" });
  });

  test("is compressed when the client takes it, cached by ETag, and smaller than it would be inline and pretty", async () => {
    const plain = await (await get("/_api/openapi.json")).text();
    const br = await get("/_api/openapi.json", { "accept-encoding": "br" });
    expect(br.headers.get("content-encoding")).toBe("br");
    const brBytes = new Uint8Array(await br.arrayBuffer());
    expect(brotliDecompressSync(brBytes).toString()).toBe(plain);
    const gz = await get("/_api/openapi.json", { "accept-encoding": "gzip" });
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    const gzBytes = new Uint8Array(await gz.arrayBuffer());
    expect(gunzipSync(gzBytes).toString()).toBe(plain);
    const etag = br.headers.get("etag")!;
    expect((await get("/_api/openapi.json", { "if-none-match": etag })).status).toBe(304);

    // What shared components and minifying save, for the docs: the same document pretty-printed with every schema written out.
    const doc = JSON.parse(plain);
    const inline = (node: unknown): unknown =>
      Array.isArray(node) ? node.map(inline) : node && typeof node === "object" ? ("$ref" in node && String((node as any).$ref).startsWith("#/components/schemas/Shared") ? inline(doc.components.schemas[String((node as any).$ref).split("/").pop()!]) : Object.fromEntries(Object.entries(node).map(([k, x]) => [k, inline(x)]))) : node;
    const before = JSON.stringify({ ...doc, paths: inline(doc.paths) }, null, 2).length;
    console.log(`openapi.json: ${before} bytes pretty with schemas inline -> ${plain.length} minified, ${gzBytes.length} gzip, ${brBytes.length} brotli`);
    expect(plain.length).toBeLessThan(before);
  });

  test("a route's query and body are checked before its handler runs", async () => {
    const post = (query: string, body: unknown) => fetch(`${srv.url}/http/orders${query}`, { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
    const ok = await post("?dryRun=true&limit=5", { sku: "a1", qty: 2 });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ sku: "a1", qty: 2, dryRun: true }); // the handler read the body itself
    const bad = await post("", { sku: "a1", qty: "two" });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("body.qty") });
    expect((await (await post("?limit=many", { sku: "a1", qty: 1 })).json()).error.message).toContain("query.limit");
    expect((await (await post("", "not json")).json()).error.message).toBe("The body must be JSON");
  });
});

test("outside dev the API docs are off unless API_DOCS turns them on, at API_DOCS_PATH", async () => {
  const prod = (extra: Record<string, string> = {}) => ({ ...process.env, PORT: "0", DATA_DIR: tempDir(), BETTER_AUTH_SECRET: "s".repeat(32), ALLOW_INSECURE_HTTP: "1", ...extra });
  const off = await startServer({ forgeDir: fixture, env: prod() });
  try {
    expect((await fetch(`${off.url}/_api/openapi.json`)).status).toBe(404);
  } finally {
    await off.stop();
  }
  const on = await startServer({ forgeDir: fixture, env: prod({ API_DOCS: "on", API_DOCS_PATH: "/docs/api" }) });
  try {
    expect((await fetch(`${on.url}/docs/api/openapi.json`)).status).toBe(200);
    expect((await fetch(`${on.url}/_api/openapi.json`)).status).toBe(404);
  } finally {
    await on.stop();
  }
  await expect(startServer({ forgeDir: fixture, env: prod({ API_DOCS_PATH: "/rpc/docs" }) })).rejects.toThrow("API_DOCS_PATH can't be under /rpc");
}, 30_000);
