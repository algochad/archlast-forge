import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({
  jobs: defineTable({ app: v.string(), status: v.string(), n: v.number() }).index("by_app", ["app"]),
});
