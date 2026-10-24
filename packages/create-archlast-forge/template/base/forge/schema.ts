import { defineSchema, defineTable, v } from "@archlast-forge/runtime";

// `users` and Better Auth's tables are built in.
export default defineSchema({
  messages: defineTable({ body: v.string(), authorId: v.id("users"), authorName: v.string() }).searchIndex("search_body", { searchField: "body" }),
});
