import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({
  messages: defineTable({ body: v.string(), authorName: v.string() }),
  flags: defineTable({ on: v.boolean() }),
  items: defineTable({ n: v.number() }).index("by_n", ["n"]),
});
