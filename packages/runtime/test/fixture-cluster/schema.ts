import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  counters: defineTable({ name: v.string(), n: v.number() }).index("by_name", ["name"]),
  blobs: defineTable({ text: v.string() }),
});
