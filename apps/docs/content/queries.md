# Reading data

## Indexes

```ts
ctx.db.query("todos").withIndex("by_list_done", (q) => q.eq("listId", listId).eq("done", false)).collect();
```

Compare a prefix of the index's fields with `eq`. Then the next field can take a range:

```ts
ctx.db.query("events").withIndex("by_time", (q) => q.gte("at", start).lt("at", end)).collect();
ctx.db.query("todos").withIndex("by_creation_time", (q) => q.gt("_creationTime", since)).take(10);
```

`withIndex` only accepts an index's fields, in order. To filter on anything else, use [`filter`](#filtering). Results are ordered by the remaining index fields, then `_creationTime`. Use `.order("desc")` to reverse.

`collect()`, `take(n)`, `first()` and `unique()` end a query (`unique()` is the one match, `null` for none, and an error if there are several). Without `withIndex`, a query scans the table in creation order.

## Filtering

```ts
ctx.db
  .query("todos")
  .withIndex("by_list", (q) => q.eq("listId", listId))
  .filter((todo) => !todo.done && todo.title.startsWith("Fix"))
  .take(10);
```

`filter` takes a plain function, so any condition works. It runs while scanning the index range, looking past the documents it skips until it has what you asked for, so `take(10)` still returns up to ten matches. Narrow the range with `withIndex` first: a query scans at most 100,000 documents and fails beyond that. Several `filter` calls all apply.

A query that uses `filter` is still reactive to changes anywhere in the index range it scanned, including documents the filter skipped.

## Counting and aggregates

```ts
await ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).count();
await ctx.db.query("orders").withIndex("by_user", (q) => q.eq("userId", userId)).sum("total");
await ctx.db.query("comments").avg("score"); // also min("score") and max("score")
```

`count()` is a single database `COUNT` unless there is a `filter`. `sum`, `avg`, `min` and `max` take a number field (the types only allow those) and scan the matching range, skipping documents that don't have the field. `sum` of nothing is `0`; `avg`, `min` and `max` of nothing are `null`.

## Joins

References between tables are the `v.id("…")` fields in your schema. `include` follows them for every result at once, in a few batched queries rather than one query per document, and gives you the related documents under names you choose:

```ts
// Follow a field to the document it points at.
const todos = await ctx.db
  .query("todos")
  .withIndex("by_list", (q) => q.eq("listId", listId))
  .include({ list: "listId", assignee: "assigneeId" })
  .collect();
todos[0].list.name; // Doc<"lists"> | null, null if the reference is missing or its document was deleted

// Look the other way: the documents that point back, through an index that starts with that reference.
const lists = await ctx.db
  .query("lists")
  .include({
    todos: { table: "todos", index: "by_list", order: "desc", take: 5 }, // Doc<"todos">[]
    todoCount: { table: "todos", index: "by_list", count: true }, // number
  })
  .take(10);
```

| Rule | Gives | Notes |
|---|---|---|
| `"field"` | the document, or `null` | the field is `v.id(…)`, optional or not. For `v.array(v.id(…))` it gives the documents that still exist, as an array |
| `{ table, index }` | the documents of `table` whose first index field is this document's id | `order` (`"asc"` default, `"desc"`) and `take` apply to each parent |
| `{ table, index, count: true }` | how many there are | |
| `{ …, include: { … } }` | nests: the related documents get their own includes | |

Everything is typed: only fields that hold ids are accepted, the `index` must belong to the `table` you name, and the result type includes the joined documents.

- **Without `take`**, a reverse include fetches the children of many parents in one query. With `take` or `count` it runs one indexed query per parent, so keep the parent list small.
- **Reverse includes need an index** that starts with the reference (`.index("by_list", ["listId"])`). It is what makes them fast, and it is how the dashboard finds them too.
- **Filters see includes.** `.include({ list: "listId" }).filter((t) => t.list?.name === "build")` filters on the related data. A filter sees only what was included before it, and includes written after the last filter run only on the results that are left.
- **Reactive:** the query re-runs when a document it joined changes, or when documents appear or disappear in an index range it joined through.
- **Names** can't be the name of one of the document's own fields.

`include` works on `withSearchIndex` results and pages from `paginate` too. For documents you already have, `ctx.db.include("todos", doc, { list: "listId" })` takes one document, `null`, or an array. And `ctx.db.getMany(ids)` loads many documents by id in one round trip, in the order you gave, with `null` for any that don't exist.

References are not enforced: deleting a document does not delete or change the documents that point at it, so a joined field can come back `null`. Delete or update those yourself in the same mutation.

## Pagination

```ts
import { paginationOptsValidator, query } from "@archlast-forge/runtime";

export const page = query({
  args: { listId: v.id("lists"), paginationOpts: paginationOptsValidator },
  handler: (ctx, { listId, paginationOpts }) =>
    ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).order("desc").paginate(paginationOpts),
});
```

`paginate` returns `{ page, isDone, continueCursor }`. Cursors are keyset-based, so inserting before a cursor doesn't shift later pages. In React, `usePaginatedQuery(api.todos.page, { listId }, { initialNumItems: 20 })` keeps every loaded item live (see [Clients](clients.html)).

## Full-text search

```ts
ctx.db.query("todos").withSearchIndex("search_title", (q) => q.search("title", "oat mil").eq("listId", listId)).take(10);
```

Every term must match, and the last one matches as a prefix ("mil" finds "milk"). Results come back by relevance. SQLite uses FTS5 and Postgres uses `tsvector` with a GIN index. Both stay in sync with writes automatically.
