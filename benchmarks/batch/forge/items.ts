import { mutation, v } from "@archlast/forge-runtime";

const item = (n: number) => ({ name: `item ${n}`, n, tags: ["a", "b"] });

/** One document per call: N calls, N transactions. */
export const insertOne = mutation({ args: { n: v.number() }, handler: (ctx, { n }) => ctx.db.insert("items", item(n)) });

/** N inserts in one mutation, one after another. */
export const insertLoop = mutation({
  args: { from: v.number(), count: v.number() },
  handler: async (ctx, { from, count }) => {
    for (let n = from; n < from + count; n++) await ctx.db.insert("items", item(n));
  },
});

/** N documents in one insertMany. */
export const insertBatch = mutation({
  args: { from: v.number(), count: v.number() },
  handler: (ctx, { from, count }) => ctx.db.insertMany("items", Array.from({ length: count }, (_, i) => item(from + i))),
});

/** N documents patched in one updateMany, and the same as N patch() calls. */
export const updateBatch = mutation({
  args: { ids: v.array(v.id("items")) },
  handler: (ctx, { ids }) => ctx.db.updateMany("items", ids.map((id) => ({ id, patch: { name: "changed" } }))),
});
export const updateLoop = mutation({
  args: { ids: v.array(v.id("items")) },
  handler: async (ctx, { ids }) => {
    for (const id of ids) await ctx.db.patch(id, { name: "changed again" });
  },
});
