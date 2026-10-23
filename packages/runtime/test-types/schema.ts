import { defineSchema, defineTable, v } from "../src/index";

export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    done: v.boolean(),
    note: v.optional(v.string()),
    points: v.optional(v.number()),
    assigneeId: v.optional(v.id("users")),
    blockedBy: v.optional(v.array(v.id("todos"))),
  }).index("by_list", ["listId"]),
  comments: defineTable({ todoId: v.id("todos"), body: v.string() }).index("by_todo", ["todoId"]),
});
