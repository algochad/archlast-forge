import { mutation, query } from "./_generated/server";
import { v } from "convex/values";

export const createList = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.insert("lists", { name }),
});

// A, B, E: the list's todos through the index (20 of them in A and B).
export const listByList = query({
  args: { listId: v.id("lists") },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

// B without Convex's result cache: the same query plus a throwaway argument that differs on every call, so no two calls share a cache entry.
export const listByListNoCache = query({
  args: { listId: v.id("lists"), nonce: v.number() },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

// C
export const add = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  handler: (ctx, args) => ctx.db.insert("todos", { ...args, done: false }),
});

// D
export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }) => {
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("not found");
    await ctx.db.patch(id, { done: !todo.done });
  },
});
