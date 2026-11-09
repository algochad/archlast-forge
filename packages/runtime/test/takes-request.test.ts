import { describe, expect, test } from "bun:test";
import { takesRequest } from "../src/server/http";

describe("takesRequest", () => {
  test("is false only for a handler that declares nothing but ctx", () => {
    expect(takesRequest(async (ctx: unknown) => ctx)).toBe(false);
    expect(takesRequest(async (_ctx: unknown) => new Response("ok"))).toBe(false);
    // @ts-ignore: a parameter with no parentheses, which the language spells without a type
    expect(takesRequest(async ctx => ctx)).toBe(false);
    expect(takesRequest((ctx: any) => ctx.runQuery({ a: 1, b: [2, 3] }))).toBe(false);
    expect(takesRequest(function (ctx: unknown) { return ctx; })).toBe(false);
    expect(takesRequest(async ({ runQuery }: { runQuery: unknown }) => runQuery)).toBe(false); // ctx taken apart
    expect(takesRequest(async ({ x }: { x: number }) => ({ a: x, b: 1 }))).toBe(false);
    expect(takesRequest({ async h(ctx: unknown) { return ctx; } }.h)).toBe(false);
  });
  test("is true for anything that could reach the request", () => {
    expect(takesRequest(async (_ctx: unknown, _req: unknown) => 1)).toBe(true);
    expect(takesRequest(async (_ctx: unknown, req: Request = undefined as never) => req)).toBe(true); // length 1, a second parameter
    expect(takesRequest(async (...args: unknown[]) => args)).toBe(true);
    expect(takesRequest(async function (_ctx: unknown) { return arguments[1]; })).toBe(true);
    expect(takesRequest(async () => 1)).toBe(true); // declares nothing, so `arguments` could be read
    expect(takesRequest(Math.max)).toBe(true);
  });
});
