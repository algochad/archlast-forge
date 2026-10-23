import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    done: v.boolean(),
    tags: v.optional(v.array(v.string())),
    assigneeId: v.optional(v.id("users")),
    blockedBy: v.optional(v.array(v.id("todos"))),
  })
    .index("by_list", ["listId"])
    .index("by_list_done", ["listId", "done"]),
  comments: defineTable({ todoId: v.id("todos"), body: v.string(), score: v.optional(v.number()) })
    .index("by_todo", ["todoId"])
    .index("by_todo_score", ["todoId", "score"]),
  events: defineTable({ kind: v.string(), at: v.number() }),
  notes: defineTable({ body: v.string(), tag: v.string(), n: v.number() })
    .index("by_n", ["n"])
    .index("by_tag_n", ["tag", "n"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["tag"] }),
});
