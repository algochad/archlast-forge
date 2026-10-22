import { defineSchema, defineTable, v } from "@archlast-forge/runtime";

// `users` (and Better Auth's sessions/accounts/verifications) are built in.
export default defineSchema({
  lists: defineTable({ name: v.string() }),

  todos: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    done: v.boolean(),
    ownerId: v.id("users"),
    attachmentId: v.optional(v.id("_storage")),
    remindedAt: v.optional(v.number()),
  })
    .index("by_list", ["listId"])
    .index("by_owner", ["ownerId"])
    .searchIndex("search_title", { searchField: "title", filterFields: ["listId"] }),
});
