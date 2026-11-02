import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({ items: defineTable({ name: v.string(), n: v.number(), tags: v.array(v.string()) }).index("by_n", ["n"]) });
