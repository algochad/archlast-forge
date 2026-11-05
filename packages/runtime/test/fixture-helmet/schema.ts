import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  pings: defineTable({ at: v.number() }),
});
