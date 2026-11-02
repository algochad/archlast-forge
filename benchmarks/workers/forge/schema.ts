import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({ hits: defineTable({ n: v.number() }) });
