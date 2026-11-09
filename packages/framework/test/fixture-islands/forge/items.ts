import { mutation, paginationOptsValidator, query, v } from "@archlast/forge-runtime";

/** One query for both kinds of paging: numbered pages (useNumberedPage) and a growing list (usePaginatedQuery). */
export const page = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: (ctx, { paginationOpts }) => ctx.db.query("items").withIndex("by_n").paginate(paginationOpts),
});

export const add = mutation({
  args: { from: v.number(), count: v.number() },
  handler: async (ctx, { from, count }) => {
    for (let n = from; n < from + count; n++) await ctx.db.insert("items", { n });
  },
});

export const total = query({ handler: async (ctx) => (await ctx.db.query("items").collect()).length });
