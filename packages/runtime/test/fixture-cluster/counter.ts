import { mutation, query, v } from "../../src/index";

/** Cached by the server per function and arguments: another server's write must evict it. */
export const get = query({
  args: { name: v.string() },
  handler: async (ctx, { name }) => (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).first())?.n ?? 0,
});

export const inc = mutation({
  args: { name: v.string() },
  handler: async (ctx, { name }) => {
    const row = (await ctx.db.query("counters").withIndex("by_name", (q) => q.eq("name", name)).first()) as { _id: string; n: number } | null;
    if (!row) return ctx.db.insert("counters", { name, n: 1 });
    await ctx.db.patch(row._id as never, { n: row.n + 1 });
    return row._id;
  },
});
