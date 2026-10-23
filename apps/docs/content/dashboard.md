# Dashboard

`/_dashboard` is on in dev and off in production unless `DASHBOARD=on`.

Sign in with an admin account (`archlast-forge admin add you@example.com --role admin`) or with `ADMIN_KEY`. Roles:

- **viewer:** read everything.
- **admin:** also edit data, run functions, cancel and retry jobs, delete files, revoke sessions and ban users.
- **owner:** everything.

Every change is recorded in the audit log.

| Page | What's there |
|---|---|
| Data | Tables with counts. Filter by index, sort, page through documents; edit (patch or replace), insert and delete with validation. A schema view per table, [relationships you can follow](#relationships), and a place to [run your own code](#running-your-own-code). |
| Functions | An argument form generated from each function's validators. Run as any user, including internal functions; recent runs are kept per function. |
| Logs | Live stream from this server, or history across all servers filtered by function, level, time and request id. |
| Metrics | Calls, errors, p50/p95 latency, subscriptions and connections over 1h, 24h or 7d. |
| Cache | Hit rate, entries and memory, hits and misses over time, and per-function counters with the time saved. Admins can clear the cache. |
| Scheduled | Crons with their next run; jobs with cancel and retry. |
| Files | Uploaded files with type and size; open or delete. |
| Users | Find by email; sessions with revoke; ban and unban. |
| Audit | Who changed what, with which arguments. |
| Settings | Schema, environment variable names, live subscriptions and their topics, runtime reload. |

`Alt+1` through `Alt+9` and `Alt+0` switch between the first ten pages. The theme follows your system, or pick light or dark.

## Relationships

Fields declared with `v.id("…")` are links between tables, and the Data page follows them:

- **In the table,** a reference shows the document it points at by its name (or title, or email) instead of an id. Click it to open that document in its own table. A reference whose document was deleted shows as *missing*.
- **In a document's drawer,** **Relationships** lists what it points at, and what points at it (`todos.listId`, 9). **Browse** opens that table with the lookup already applied, using the index on the field.
- **A trail** at the top (*todos › lists · Forge launch › todos · listId = …*) shows how you got here. **Back**, or any step in it, returns you, with that document open again.
- **Where there is no index** on the referencing field, the count is found by scanning, and Browse is replaced by **Query**, which opens the function runner with a query for it (owners only). Adding an index to the field turns it into a normal lookup.
- **Relationships** in the Tools list draws every table with its references as an entity-relationship diagram, or as a list. Click a table to open it, hover to follow its connections. Your own tables are shown with the built-in ones they connect to.
- A table's **Schema** view has a **Relations** section with both directions.
- The function runner has join examples built from your schema.

## Running your own code

On the Data page, **Run function** opens an editor where you write a query or a mutation and run it against the live data, like a custom test query in Convex. Each table's **Query** button opens it with a starting query for that table, and the **Examples** menu has more: counting, filtering with an index, updating documents, logging.

```ts
export default query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    console.log("looking up", listId);
    return await ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect();
  },
});
```

- **What's in scope:** `query`, `mutation`, `v` and `ForgeError`, so there is nothing to import. TypeScript works. `ctx` is what your own functions get; a bare `export default async (ctx) => …` counts as a query.
- **Arguments** are JSON, checked against the `args` you declare. **Run as user** takes an email or `users:…` id, so `ctx.auth` sees that user.
- **Results** appear as a table when the function returns documents (or as JSON), with the time it took, what it wrote to the console, and a copy button. A syntax error shows its line.
- **Queries are read-only.** A mutation commits when it returns and rolls back if it throws; its writes reach live queries and invalidate the [cache](caching.html) like any other.
- **Cmd or Ctrl and Enter** runs it. The editor keeps your last draft in this browser.

This is arbitrary code running inside the function runtime, with its environment (database URL, secrets) and network access, so it is held to a higher bar than the rest of the dashboard:

- only the **owner** role can use it (an admin cannot);
- it is **off in production** until you set `ALLOW_CUSTOM_FUNCTIONS=on`;
- every run, with its code and arguments, is in the audit log.
