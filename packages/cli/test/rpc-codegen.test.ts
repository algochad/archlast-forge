import { expect, test } from "bun:test";
import { join } from "node:path";
import { listModules } from "@archlast/forge-runtime/server";
import { renderRpc, rpcRouters, tsOf } from "../src/rpc-types";

const fixture = join(import.meta.dir, "../../runtime/test/fixture-nest");

test("JSON Schema becomes TypeScript", () => {
  expect(tsOf({ type: "object", properties: { a: { type: "string" }, b: { type: "integer" } }, required: ["a"], additionalProperties: false })).toBe("{ a: string; b?: number }");
  expect(tsOf({ anyOf: [{ type: "string" }, { type: "null" }] })).toBe("string | null");
  expect(tsOf({ type: "array", items: { enum: ["a", "b"] } })).toBe('Array<"a" | "b">');
  expect(tsOf({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }] })).toBe("[string, number]");
  expect(tsOf({ type: "object", propertyNames: { type: "string" }, additionalProperties: { type: "number" } })).toBe("Record<string, number>");
  expect(tsOf({ type: "object", properties: { "a-b": { const: 1 } }, required: ["a-b"] })).toBe('{ "a-b": 1 }');
  expect(tsOf({ type: ["string", "null"] })).toBe("string | null");
  expect(tsOf({ $defs: { n: { type: "object", properties: { next: { $ref: "#/$defs/n" } } } }, $ref: "#/$defs/n" })).toContain("unknown"); // a recursive type stops
  expect(tsOf({})).toBe("unknown");
});

test("codegen imports the routers and writes their procedures: schemas as types, the return type where there is no output schema", async () => {
  const routers = await rpcRouters(fixture, listModules(fixture));
  expect(routers.map((r) => [r.module, r.exportName, r.alias])).toEqual([["shop.router", "ShopRouter", "shop"]]);
  const text = renderRpc(routers, "// header\n");
  expect(text).toContain('import type * as m0 from "../shop.router";');
  expect(text).toContain('add: { kind: "query"; input: { a: number; b: number }; output: { sum: number } };');
  expect(text).toContain('order: { kind: "mutation"; input: { userId: string; items: Array<{ sku: string; qty: number }> }; output: { orderId: string; units: number } };');
  expect(text).toContain('notes: { kind: "query"; input: undefined; output: Awaited<ReturnType<m0.ShopRouter["notes"]>> };');
  expect(text).toContain('fail: { kind: "mutation"; input: { kind: "forge" | "rpc" | "crash" }; output: Awaited<ReturnType<m0.ShopRouter["fail"]>> };');
  expect(() => renderRpc([...routers, { ...routers[0]!, module: "other" }], "")).toThrow('both use the Forge RPC alias "shop"');
});
