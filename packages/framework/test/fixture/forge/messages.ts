import { ForgeError, mutation, query, v } from "@archlast/forge-runtime";

export const list = query({ handler: (ctx) => ctx.db.query("messages").order("desc").take(20) });

export const count = query({ handler: async (ctx) => (await ctx.db.query("messages").collect()).length });

export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("sign in first");
    return ctx.db.insert("messages", { body, authorName: me.name });
  },
});

export const failing = query({ handler: () => { throw new ForgeError({ code: "NOPE" }); } });
export const crashing = query({ handler: () => { throw new Error("database password is hunter2"); } });
