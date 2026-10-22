import { defineSchema, defineTable, v } from "../src/index";

export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    done: v.boolean(),
    note: v.optional(v.string()),
  }).index("by_list", ["listId"]),
});
