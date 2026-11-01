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

/** Lists with how many todos each has: the read set covers every list's todos. */
export const listCounts = query({
  handler: (ctx) => ctx.db.query("lists").include({ total: { table: "todos", index: "by_list", count: true } }).collect(),
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

/** Who may see a list is checked per caller; the list itself is the same for everyone who passes, so it is run and cached once. */
export const sharedList = query({
  args: { listId: v.id("lists") },
  access: async (ctx) => {
    const me = await ctx.auth.getUserIdentity();
    const user = me ? ((await ctx.db.get(me.userId)) as { banned?: boolean } | null) : null;
    if (!user) throw new ForgeError("Sign in to continue");
    if (user.banned) throw new ForgeError("This account is deactivated");
  },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

/** A mistake the engine refuses to run: a shared result that asks who is calling. */
export const sharedPeek = query({ access: () => {}, handler: (ctx) => ctx.auth.getUserIdentity() });

export const deactivate = mutation({
  args: { userId: v.id("users") },
  handler: (ctx, { userId }) => ctx.db.patch(userId, { banned: true } as never),
});

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

// ---- for safety and query-feature tests ----
import { ForgeError, internalQuery, metrics, paginationOptsValidator, trace } from "../../src/index";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const secretCount = internalQuery({ handler: async (ctx) => (await ctx.db.query("lists").collect()).length });

export const callsInternal = action({ handler: async (ctx) => (await ctx.runQuery((anyApi as any).todos.secretCount)) as number });

export const slowAction = action({ args: { ms: v.number() }, handler: async (_ctx, { ms }) => (await sleep(ms), "done") });
export const slowQuery = query({ args: { ms: v.number() }, handler: async (_ctx, { ms }) => (await sleep(ms), 1) });

/** Blocks the event loop: only killing the process stops it. */
export const spin = query({
  args: { ms: v.number() },
  handler: (_ctx, { ms }) => {
    const end = Date.now() + ms;
    while (Date.now() < end);
    return 1;
  },
});

export const slowWrite = mutation({
  args: { listId: v.id("lists"), ms: v.number() },
  handler: async (ctx, { listId, ms }) => {
    await sleep(ms);
    await ctx.db.insert("todos", { listId, title: "late write", done: false });
  },
});

export const bigResult = query({ args: { bytes: v.number() }, handler: async (_ctx, { bytes }) => "x".repeat(bytes) });

export const forgeFail = mutation({ handler: () => { throw new ForgeError({ code: "LIMIT", max: 3 }); } });

/** Custom telemetry: a span of the app's own, an attribute on it, and a counter and a gauge. */
export const exportRows = action({
  handler: async () => {
    metrics.counter("todos.exported").add(3, { format: "csv" });
    metrics.gauge("queue.depth").set(7);
    return trace.span("export.render", async () => {
      trace.annotate({ rows: 3 });
      await sleep(5);
      return "ok";
    });
  },
});

export const crash = query({ handler: () => { throw new Error("secret internal detail"); } });

export const todosPage = query({
  args: { listId: v.id("lists"), paginationOpts: paginationOptsValidator },
  handler: (ctx, { listId, paginationOpts }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).paginate(paginationOpts),
});

export const addNote = mutation({
  args: { body: v.string(), tag: v.string(), n: v.number() },
  handler: (ctx, note) => ctx.db.insert("notes", note),
});

export const searchNotes = query({
  args: { text: v.string(), tag: v.optional(v.string()) },
  handler: (ctx, { text, tag }) =>
    ctx.db.query("notes").withSearchIndex("search_body", (q) => (tag === undefined ? q.search("body", text) : q.search("body", text).eq("tag", tag))).take(10),
});

/** A large answer after some work, to see what a busy runtime process does with results the pipe to the server must carry. */
export const bigAnswer = query({
  args: { rows: v.number(), ms: v.number(), seed: v.number() },
  handler: (_ctx, { rows, ms, seed }) => {
    const end = Date.now() + ms;
    while (Date.now() < end);
    return Array.from({ length: rows }, (_, i) => ({ id: `row:${seed}:${i}`, name: "Santos, Maria", pad: "x".repeat(300), n: i, when: 1_700_000_000_000 + i, ok: i % 2 === 0, none: null }));
  },
});
