import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

// The same shape as packages/runtime/test/fixture (lists, todos, index by_list on [listId]). The fixture has two more indexes and some
// optional fields on todos; Convex gets only what the workload uses.
export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({ listId: v.id("lists"), title: v.string(), done: v.boolean() }).index("by_list", ["listId"]),
});
