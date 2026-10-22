import { action, anyApi, mutation, query, v } from "../../src/index";

const api = anyApi;

export const createList = mutation({
  args: { name: v.string() },
  handler: (ctx, { name }) => ctx.db.insert("lists", { name }),
});

export const listByList = query({
  args: { listId: v.id("lists") },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

export const openCount = query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) =>
    (await ctx.db.query("todos").withIndex("by_list_done", (q) => q.eq("listId", listId).eq("done", false)).collect()).length,
});

export const get = query({ args: { id: v.id("todos") }, handler: (ctx, { id }) => ctx.db.get(id) });

export const add = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  handler: (ctx, args) => ctx.db.insert("todos", { ...args, done: false }),
});

export const toggle = mutation({
  args: { id: v.id("todos") },
  handler: async (ctx, { id }) => {
    const todo = await ctx.db.get(id);
    if (!todo) throw new Error("not found");
    await ctx.db.patch(id, { done: !todo.done });
  },
});

export const failAfterInsert = mutation({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    await ctx.db.insert("todos", { listId, title: "ghost", done: false });
    throw new Error("boom");
  },
});

export const whoami = query({ handler: (ctx) => ctx.auth.getUserIdentity() });

export const logEvent = mutation({
  args: { kind: v.string() },
  handler: (ctx, { kind }) => ctx.db.insert("events", { kind, at: Date.now() }),
});

export const events = query({ handler: (ctx) => ctx.db.query("events").collect() });

export const scheduleEvent = mutation({
  args: { kind: v.string(), delayMs: v.number() },
  handler: (ctx, { kind, delayMs }) => ctx.scheduler.runAfter(delayMs, api.todos.logEvent, { kind }),
});

export const addViaAction = action({
  args: { listId: v.id("lists"), title: v.string() },
  handler: async (ctx, args) => {
    console.log("adding", args.title);
    const id = await ctx.runMutation(api.todos.add, args);
    return ctx.runQuery(api.todos.get, { id });
  },
});

export const actionTouchesDb = action({
  handler: async (ctx) => (ctx as any).db === undefined,
});

export const getChecked = query({
  args: { id: v.id("todos") },
  returns: v.union(v.object({ _id: v.id("todos"), _creationTime: v.number(), listId: v.id("lists"), title: v.string(), done: v.boolean(), tags: v.optional(v.array(v.string())) }), v.null()),
  handler: (ctx, { id }) => ctx.db.get(id) as any, // fixture has no registered schema
});

export const wrongQueryReturn = query({
  returns: v.string(),
  handler: async () => 5 as unknown as string,
});

export const wrongMutationReturn = mutation({
  args: { listId: v.id("lists") },
  returns: v.id("lists"),
  handler: (ctx, { listId }) => ctx.db.insert("todos", { listId, title: "should roll back", done: false }) as any,
});

export const voidAction = action({ returns: v.null(), handler: async () => {} });
