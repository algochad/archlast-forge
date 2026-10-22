import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    done: v.boolean(),
    tags: v.optional(v.array(v.string())),
  })
    .index("by_list", ["listId"])
    .index("by_list_done", ["listId", "done"]),
  events: defineTable({ kind: v.string(), at: v.number() }),
});
