import { ForgeError, mutation, paginationOptsValidator, query, v } from "@archlast-forge/runtime";

/** Newest first; the sidebar loads more as needed. */
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: (ctx, { paginationOpts }) => ctx.db.query("lists").order("desc").paginate(paginationOpts),
});

export const create = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    if (!(await ctx.auth.getUserIdentity())) throw new ForgeError("unauthenticated");
    return ctx.db.insert("lists", { name });
  },
});
