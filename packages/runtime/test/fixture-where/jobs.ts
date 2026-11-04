import { mutation, paginationOptsValidator, query, v } from "@archlast/forge-runtime";

/** where() + paginate(): the query shape that left later reads stale. */
export const page = query({
  args: { app: v.string(), status: v.string(), paginationOpts: paginationOptsValidator },
  handler: (ctx, { app, status, paginationOpts }) =>
    ctx.db.query("jobs").where((q) => q.and(q.eq("app", app), q.eq("status", status))).order("desc").paginate(paginationOpts),
});
export const count = query({ args: { app: v.string() }, handler: async (ctx, { app }) => (await ctx.db.query("jobs").withIndex("by_app", (q) => q.eq("app", app)).collect()).length });
export const all = query({ handler: async (ctx) => (await ctx.db.query("jobs").collect()).length });
export const add = mutation({ args: { app: v.string(), status: v.string() }, handler: (ctx, a) => ctx.db.insert("jobs", { ...a, n: Date.now() }) });
