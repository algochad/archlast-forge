import type { ModuleRefs } from "../src/index";
import { action, anyApi, mutation, query, v } from "../src/index";
import type * as self from "./functions";
import "./register";

export const api: { functions: ModuleRefs<typeof self> } = anyApi;

export const listByList = query({
  args: { listId: v.id("lists") },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

export const add = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  handler: (ctx, args) => ctx.db.insert("todos", { ...args, done: false }),
});

export const remind = action({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }): Promise<void> => {
    await ctx.runMutation(api.functions.add, { listId: "lists:x" as any, title: String(id) });
  },
});
