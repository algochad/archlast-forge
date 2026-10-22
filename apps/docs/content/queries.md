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

Filtering on a field without an index doesn't compile. Results are ordered by the remaining index fields, then `_creationTime`. Use `.order("desc")` to reverse.

`collect()`, `take(n)` and `first()` end a query. Without `withIndex`, a query scans the table in creation order.

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
