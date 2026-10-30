import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  notes: defineTable({ text: v.string() }),
});
