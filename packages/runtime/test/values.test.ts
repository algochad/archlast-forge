import { expect, test } from "bun:test";
import { defineSchema, defineTable } from "../src/schema";
import { v, validate } from "../src/values";

test("validators accept matching values and reject others with a path", () => {
  const todo = v.object({ title: v.string(), done: v.boolean(), n: v.optional(v.number()), tags: v.array(v.string()), list: v.id("lists") });
  validate(todo, { title: "a", done: false, tags: ["x"], list: "lists:abc" });
  expect(() => validate(todo, { title: "a", done: "no", tags: [], list: "lists:abc" })).toThrow("value.done must be a boolean");
  expect(() => validate(todo, { title: "a", done: true, tags: [1], list: "lists:abc" })).toThrow("value.tags[0] must be a string");
  expect(() => validate(todo, { title: "a", done: true, tags: [], list: "todos:abc" })).toThrow('value.list must be an Id<"lists">');
  expect(() => validate(todo, { done: true, tags: [], list: "lists:abc" })).toThrow("value.title is required");
  expect(() => validate(todo, { title: "a", done: true, tags: [], list: "lists:abc", x: 1 })).toThrow("value.x is not in the validator");
  expect(() => validate(v.number(), Number.NaN)).toThrow("finite number");
  expect(() => validate(v.number(), Infinity)).toThrow("finite number");
});

test("null and union validators", () => {
  const maybeId = v.union(v.id("lists"), v.null());
  validate(maybeId, null);
  validate(maybeId, "lists:abc");
  expect(() => validate(maybeId, "todos:abc")).toThrow('value must be an Id<"lists">'); // Zod reports the closest member
  expect(() => validate(v.object({ a: v.union(v.string(), v.number()) }), { a: true })).toThrow("value.a must be one of string | number");
  expect(() => validate(v.array(v.object({ n: v.null() })), [{ n: null }, { n: 1 }])).toThrow("value[1].n must be null, got 1");
});

test("defineSchema adds auth and system tables and rejects bad definitions", () => {
  const s = defineSchema({ todos: defineTable({ title: v.string() }).index("by_title", ["title"]) });
  expect(Object.keys(s.tables).sort()).toEqual(["_storage", "accounts", "sessions", "todos", "users", "verifications"]);
  expect(s.tables.todos.indexes).toEqual({ by_title: ["title"] });
  expect(() => defineSchema({ users: defineTable({}) } as any)).toThrow("reserved");
  expect(() => defineSchema({ t: defineTable({ a: v.string() }).index("by_creation_time", ["a"]) })).toThrow("invalid or reserved"); // the built-in index would shadow it
  expect(() => defineSchema({ "bad-name": defineTable({}) })).toThrow("must match");
  expect(() => defineSchema({ t: defineTable({ a: v.string() }).index("by_b", ["b" as "a"]) })).toThrow('unknown field "b"');
});
