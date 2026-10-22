import { action, ForgeError, internalMutation, mutation, query, v, type MutationCtx } from "@archlast-forge/runtime";
import { formatDistanceToNow } from "date-fns"; // a server-only dependency from convex/package.json
import { api, internal } from "./_generated/api";

async function requireUser(ctx: Pick<MutationCtx, "auth">) {
  const identity = await ctx.auth.getUserIdentity();
  if (!identity) throw new ForgeError("unauthenticated");
  return identity;
}

export const listByList = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    const todos = await ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect();
    return Promise.all(
      todos.map(async (t) => ({ ...t, attachmentUrl: t.attachmentId ? await ctx.storage.getUrl(t.attachmentId) : null })),
    );
  },
});

export const search = query({
  args: { listId: v.id("lists"), text: v.string() },
  handler: (ctx, { listId, text }) =>
    ctx.db.query("todos").withSearchIndex("search_title", (q) => q.search("title", text).eq("listId", listId)).take(20),
});

export const get = query({
  args: { todoId: v.id("todos") },
  handler: (ctx, { todoId }) => ctx.db.get(todoId),
});

export const add = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  handler: async (ctx, args) => {
    const identity = await requireUser(ctx);
    return ctx.db.insert("todos", { ...args, done: false, ownerId: identity.userId });
  },
});

export const toggle = mutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, { todoId }) => {
    await requireUser(ctx);
    const todo = await ctx.db.get(todoId);
    if (!todo) throw new ForgeError("todo not found");
    await ctx.db.patch(todoId, { done: !todo.done });
  },
});

export const remove = mutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, { todoId }) => {
    await requireUser(ctx);
    const todo = await ctx.db.get(todoId);
    if (todo?.attachmentId) await ctx.storage.delete(todo.attachmentId);
    await ctx.db.delete(todoId);
  },
});

export const generateUploadUrl = mutation({
  args: { contentType: v.optional(v.string()) },
  handler: async (ctx, args) => {
    await requireUser(ctx);
    return ctx.storage.generateUploadUrl(args);
  },
});

export const attach = mutation({
  args: { todoId: v.id("todos"), storageId: v.id("_storage") },
  handler: async (ctx, { todoId, storageId }) => {
    await requireUser(ctx);
    const todo = await ctx.db.get(todoId);
    if (todo?.attachmentId) await ctx.storage.delete(todo.attachmentId);
    await ctx.db.patch(todoId, { attachmentId: storageId });
  },
});

/** Internal: only sendReminder calls it, so clients can't mark todos reminded. */
export const markReminded = internalMutation({
  args: { todoId: v.id("todos") },
  handler: (ctx, { todoId }) => ctx.db.patch(todoId, { remindedAt: Date.now() }),
});

/** External I/O lives in actions: POSTs to REMINDER_WEBHOOK_URL when set, otherwise logs. */
export const sendReminder = action({
  args: { todoId: v.id("todos") },
  returns: v.string(),
  // Annotated because it calls api.todos.* from this same module, which TypeScript can't infer in a cycle.
  handler: async (ctx, { todoId }): Promise<string> => {
    const todo = await ctx.runQuery(api.todos.get, { todoId });
    if (!todo) throw new ForgeError("todo not found");
    const text = `Reminder: "${todo.title}", added ${formatDistanceToNow(todo._creationTime, { addSuffix: true })}`;
    const webhook = process.env.REMINDER_WEBHOOK_URL;
    if (webhook) await fetch(webhook, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) });
    else console.log(text);
    await ctx.runMutation(internal.todos.markReminded, { todoId });
    return text;
  },
});

/** Run hourly by crons.ts; internal, so clients can't trigger it. */
export const purgeDone = internalMutation({
  handler: async (ctx) => {
    const dayAgo = Date.now() - 24 * 3600_000;
    for (const t of await ctx.db.query("todos").collect()) if (t.done && t._creationTime < dayAgo) await ctx.db.delete(t._id);
  },
});
