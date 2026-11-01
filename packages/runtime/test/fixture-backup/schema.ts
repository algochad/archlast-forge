import { defineSchema, defineTable, v } from "../../src/index";

export default defineSchema({
  posts: defineTable({ title: v.string(), body: v.string(), tag: v.string(), imageId: v.optional(v.id("_storage")) })
    .index("by_tag", ["tag"])
    .searchIndex("search_body", { searchField: "body", filterFields: ["tag"] }),
  counters: defineTable({ name: v.string(), n: v.number() }).index("by_name", ["name"]),
});
