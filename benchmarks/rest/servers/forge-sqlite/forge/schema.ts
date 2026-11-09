import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

// The benchmark's items, in the engine's own database (SQLite). `itemId` is the number the API shows; `by_item` finds an item by it and lists a range in order.
export default defineSchema({
  items: defineTable({ itemId: v.number(), name: v.string(), quantity: v.number() }).index("by_item", ["itemId"]),
});
