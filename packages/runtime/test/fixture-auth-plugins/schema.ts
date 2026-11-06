import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

export default defineSchema({
  notes: defineTable({ text: v.string() }),
});
