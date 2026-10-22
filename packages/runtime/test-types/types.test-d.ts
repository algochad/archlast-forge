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
