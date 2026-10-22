import { mutation, query, v } from "@archlast-forge/runtime";

export const all = query({
  handler: (ctx) => ctx.db.query("lists").collect(),
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    if (!(await ctx.auth.getUserIdentity())) throw new Error("unauthenticated");
    return ctx.db.insert("lists", { name });
  },
});
