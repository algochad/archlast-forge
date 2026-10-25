import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({
  messages: defineTable({ body: v.string(), authorName: v.string() }),
  flags: defineTable({ on: v.boolean() }),
});
