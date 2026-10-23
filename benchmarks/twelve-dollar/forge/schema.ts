import { defineSchema, defineTable, v } from "@archlast-forge/runtime";

// The challenge's users table is the built-in `users` (name is the username); the rest is the same shape as its schema.sql.
// `_creationTime` is posts.created_at, so the built-in by_creation_time index is posts_created_at_id_idx.
export default defineSchema({
  posts: defineTable({ authorId: v.id("users"), body: v.string() }).index("by_author", ["authorId"]),
  likes: defineTable({ userId: v.id("users"), postId: v.id("posts") })
    .index("by_post", ["postId"])
    .index("by_user_post", ["userId", "postId"]), // one like per (user, post), like the primary key
});
