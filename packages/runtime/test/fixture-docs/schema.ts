import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  payments: defineTable({ amount: v.number(), status: v.string() }),
});
