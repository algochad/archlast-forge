import { anyApi, mutation, query, v } from "../../src/index";

const api = anyApi;

export const add = mutation({
  args: { title: v.string(), body: v.string(), tag: v.string(), imageId: v.optional(v.id("_storage")) },
  handler: (ctx, args) => ctx.db.insert("posts", args),
});

export const remove = mutation({ args: { id: v.id("posts") }, handler: (ctx, { id }) => ctx.db.delete(id) });

export const byTag = query({
  args: { tag: v.string() },
  handler: (ctx, { tag }) =>
    ctx.db
      .query("posts")
      .withIndex("by_tag", (q) => q.eq("tag", tag))
      .collect(),
});

export const search = query({
  args: { text: v.string() },
  handler: (ctx, { text }) =>
    ctx.db
      .query("posts")
      .withSearchIndex("search_body", (q) => q.search("body", text))
      .collect(),
});

export const uploadUrl = mutation({ args: { contentType: v.optional(v.string()) }, handler: (ctx, args) => ctx.storage.generateUploadUrl(args) });

export const fileUrl = query({ args: { id: v.id("_storage") }, handler: (ctx, { id }) => ctx.storage.getUrl(id) });

export const dropFile = mutation({ args: { id: v.id("_storage") }, handler: (ctx, { id }) => ctx.storage.delete(id) });

export const later = mutation({
  args: {},
  handler: (ctx) => ctx.scheduler.runAfter(3_600_000, api.posts.add, { title: "later", body: "scheduled", tag: "job" }),
});
