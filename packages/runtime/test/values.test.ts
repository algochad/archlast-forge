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
});

test("defineSchema adds auth and system tables and rejects bad definitions", () => {
  const s = defineSchema({ todos: defineTable({ title: v.string() }).index("by_title", ["title"]) });
  expect(Object.keys(s.tables).sort()).toEqual(["_storage", "accounts", "sessions", "todos", "users", "verifications"]);
  expect(s.tables.todos.indexes).toEqual({ by_title: ["title"] });
  expect(() => defineSchema({ users: defineTable({}) } as any)).toThrow("reserved");
  expect(() => defineSchema({ "bad-name": defineTable({}) })).toThrow("must match");
  expect(() => defineSchema({ t: defineTable({ a: v.string() }).index("by_b", ["b" as "a"]) })).toThrow('unknown field "b"');
});
