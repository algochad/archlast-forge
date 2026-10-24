import { ForgeError, mutation, paginationOptsValidator, query, v } from "@archlast/forge-runtime";

/** Newest first, paginated: the client loads more as you scroll. */
export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: (ctx, { paginationOpts }) => ctx.db.query("messages").order("desc").paginate(paginationOpts),
});

export const search = query({
  args: { text: v.string() },
  handler: (ctx, { text }) => ctx.db.query("messages").withSearchIndex("search_body", (q) => q.search("body", text)).take(20),
});

export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in to post");
    if (!body.trim() || body.length > 2000) throw new ForgeError("Messages are 1 to 2000 characters");
    return ctx.db.insert("messages", { body: body.trim(), authorId: me.userId, authorName: me.name });
  },
});
