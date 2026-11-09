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

/** Fails until a flag exists: a query that is broken now and fine later. */
export const gated = query({
  handler: async (ctx) => {
    if (!(await ctx.db.query("flags").first())) throw new ForgeError("not yet");
    return "ready";
  },
});
export const setFlag = mutation({ handler: (ctx) => ctx.db.insert("flags", { on: true }) });

export const failing = query({ handler: () => { throw new ForgeError({ code: "NOPE" }); } });
export const crashing = query({ handler: () => { throw new Error("database password is hunter2"); } });
