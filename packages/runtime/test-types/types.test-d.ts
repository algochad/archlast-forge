// Compile-time tests: `bun check -p test-types`. Each @ts-expect-error must stay an error.
import { expectTypeOf } from "expect-type";
import type { Doc, FunctionArgs, FunctionReturn, Id } from "../src/index";
import { action, mutation, query, v } from "../src/index";
import { api } from "./functions";
import "./register";

// Validators infer TypeScript types.
const todoValidator = v.object({ title: v.string(), done: v.boolean(), note: v.optional(v.string()) });
expectTypeOf<import("../src/index").Infer<typeof todoValidator>>().toEqualTypeOf<{ title: string; done: boolean; note?: string | undefined }>();

// Docs come from the registered schema, with system fields.
expectTypeOf<Doc<"todos">["listId"]>().toEqualTypeOf<Id<"lists">>();
expectTypeOf<Doc<"todos">["_id"]>().toEqualTypeOf<Id<"todos">>();

// References carry args and return types from the handler.
expectTypeOf<FunctionArgs<typeof api.functions.listByList>>().toEqualTypeOf<{ listId: Id<"lists"> }>();
expectTypeOf<FunctionReturn<typeof api.functions.listByList>>().toEqualTypeOf<Doc<"todos">[]>();
expectTypeOf<FunctionReturn<typeof api.functions.add>>().toEqualTypeOf<Id<"todos">>();

// Ids from different tables don't mix.
declare const listId: Id<"lists">;
// @ts-expect-error a list id is not a todo id
const wrongId: Id<"todos"> = listId;

query({
  args: { listId: v.id("lists") },
  handler: async (ctx, args) => {
    // @ts-expect-error filter on a field that isn't indexed
    await ctx.db.query("todos").withIndex("by_list", (q) => q.eq("title", "x"));
    // @ts-expect-error unknown index
    await ctx.db.query("todos").withIndex("by_title");
    // @ts-expect-error unknown table
    await ctx.db.query("nope");
    // @ts-expect-error wrong value type for the indexed field
    await ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", "plain string"));
    // @ts-expect-error queries can't write
    await ctx.db.insert("lists", { name: "x" });
    // @ts-expect-error args are typed
    args.listId.toFixed();
  },
});

mutation({
  handler: async (ctx) => {
    // @ts-expect-error inserted documents are checked against the table
    await ctx.db.insert("todos", { title: 1 });
    // @ts-expect-error missing required field
    await ctx.db.insert("lists", {});
  },
});

action({
  handler: async (ctx) => {
    // @ts-expect-error actions have no ctx.db
    ctx.db;
    // @ts-expect-error wrong argument types for runQuery
    await ctx.runQuery(api.functions.listByList, { listId: 1 });
    // @ts-expect-error a mutation reference isn't a query
    await ctx.runQuery(api.functions.add, { listId, title: "x" });
  },
});

// Output validators must match what the handler returns.
query({ returns: v.array(v.string()), handler: async () => ["a"] });
query({ returns: v.union(v.string(), v.null()), handler: async () => (Math.random() ? "a" : null) });
mutation({ returns: v.null(), handler: async () => {} });
// @ts-expect-error returns validator disagrees with the handler
query({ returns: v.string(), handler: async () => 1 });
// @ts-expect-error handler may return null but the validator doesn't allow it
query({ returns: v.string(), handler: async () => (Math.random() ? "a" : null) });

// With `returns`, the validator is the function's return type.
const typedQuery = query({ returns: v.union(v.string(), v.null()), handler: async () => (Math.random() ? "a" : null) });
expectTypeOf<FunctionReturn<import("../src/index").ModuleRefs<{ q: typeof typedQuery }>["q"]>>().toEqualTypeOf<string | null>();

// A document validator matches the registered schema's Doc.
query({
  args: { id: v.id("todos") },
  returns: v.union(
    v.object({ _id: v.id("todos"), _creationTime: v.number(), listId: v.id("lists"), title: v.string(), done: v.boolean(), note: v.optional(v.string()) }),
    v.null(),
  ),
  handler: (ctx, { id }) => ctx.db.get(id),
});
query({
  args: { id: v.id("todos") },
  returns: v.object({ _id: v.id("todos") }),
  // @ts-expect-error the handler can return null, which this validator doesn't allow
  handler: (ctx, { id }) => ctx.db.get(id),
});

// ---- relationships ----

// Following a field gives the document it points at: one for an id, all of them for an array, null when there may be none.
type TodoJoined = FunctionReturn<typeof api.functions.todosWithLists>[number];
expectTypeOf<TodoJoined["list"]>().toEqualTypeOf<Doc<"lists"> | null>();
expectTypeOf<TodoJoined["blockers"]>().toEqualTypeOf<Doc<"todos">[]>();
expectTypeOf<TodoJoined["assignee"]>().toEqualTypeOf<Doc<"users"> | null>();
expectTypeOf<TodoJoined["title"]>().toEqualTypeOf<string>(); // the document's own fields are still there

// Looking the other way gives arrays of the other table's documents, with their own includes; count gives a number.
type ListJoined = FunctionReturn<typeof api.functions.listsWithTodos>[number];
expectTypeOf<ListJoined["open"]>().toEqualTypeOf<number>();
expectTypeOf<ListJoined["todos"][number]["title"]>().toEqualTypeOf<string>();
expectTypeOf<ListJoined["todos"][number]["comments"][number]>().toEqualTypeOf<Doc<"comments">>();
expectTypeOf<ListJoined["todos"][number]["list"]>().toEqualTypeOf<Doc<"lists"> | null>();

// Only id fields can be followed, only real indexes can be used, and the index must belong to the table named.
query({
  handler: (ctx) => {
    // @ts-expect-error title isn't a reference
    ctx.db.query("todos").include({ x: "title" });
    // @ts-expect-error no such field
    ctx.db.query("todos").include({ x: "nope" });
    // @ts-expect-error no such index on comments
    ctx.db.query("lists").include({ x: { table: "comments", index: "by_list" } });
    // @ts-expect-error no such table
    ctx.db.query("lists").include({ x: { table: "nothing", index: "by_list" } });
    return null;
  },
});

// A filter sees what was included before it.
query({
  handler: (ctx) =>
    ctx.db
      .query("todos")
      .include({ list: "listId" })
      .filter((t) => t.list?.name === "build")
      .collect(),
});

// Aggregates take number fields only; results are numbers (or null when nothing matched).
query({
  handler: async (ctx) => {
    const todos = ctx.db.query("todos");
    expectTypeOf(await todos.count()).toEqualTypeOf<number>();
    expectTypeOf(await todos.sum("points")).toEqualTypeOf<number>();
    expectTypeOf(await todos.avg("points")).toEqualTypeOf<number | null>();
    expectTypeOf(await todos.max("_creationTime")).toEqualTypeOf<number | null>();
    // @ts-expect-error title isn't a number
    await todos.sum("title");
    expectTypeOf(await todos.unique()).toEqualTypeOf<Doc<"todos"> | null>();
    return null;
  },
});

// getMany and include on documents you already have.
query({
  handler: async (ctx) => {
    const many = await ctx.db.getMany(["todos:a" as Id<"todos">]);
    expectTypeOf(many).toEqualTypeOf<(Doc<"todos"> | null)[]>();
    const one = await ctx.db.get("todos:a" as Id<"todos">);
    const joined = await ctx.db.include("todos", one, { list: "listId" });
    expectTypeOf(joined).toBeNullable(); // a null document stays null
    expectTypeOf(joined!.list).toEqualTypeOf<Doc<"lists"> | null>();
    expectTypeOf(joined!.title).toEqualTypeOf<string>();
    return null;
  },
});
