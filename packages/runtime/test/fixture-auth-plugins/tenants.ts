import { query, type Id } from "@archlast/forge-runtime";

/** The plugin's own tables, read from a function like any other, and typed by codegen (forge/_generated/authTables.ts). */
export const memberships = query({
  args: {},
  handler: async (ctx) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) return [];
    const members = await ctx.db
      .query("members")
      .withIndex("by_userId", (q) => q.eq("userId", me.userId))
      .collect();
    // Better Auth keeps references as plain strings (they are the engine's ids).
    return Promise.all(members.map(async (m) => ({ role: m.role satisfies string, organization: (await ctx.db.get(m.organizationId as Id<"organizations">))?.name })));
  },
});
