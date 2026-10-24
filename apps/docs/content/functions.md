# Functions

Every export made with these helpers is a function. Its name is `<file path>:<export>`, for example `todos:add`.

| Kind | Reads | Writes | Live | External I/O | Runs in |
|---|---|---|---|---|---|
| `query` | yes | no | yes | no | one read snapshot |
| `mutation` | yes | yes | no | no | one serializable transaction |
| `action` | via `ctx.runQuery` | via `ctx.runMutation` | no | yes | no transaction |

```ts
import { action, mutation, query, v } from "@archlast/forge-runtime";
import { api, internal } from "./_generated/api";

export const listByList = query({
  args: { listId: v.id("lists") },
  handler: (ctx, { listId }) => ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect(),
});

export const add = mutation({
  args: { listId: v.id("lists"), title: v.string() },
  returns: v.id("todos"),
  handler: (ctx, args) => ctx.db.insert("todos", { ...args, done: false }),
});

export const remind = action({
  args: { todoId: v.id("todos") },
  handler: async (ctx, { todoId }): Promise<void> => {
    const todo = await ctx.runQuery(api.todos.get, { todoId });
    await fetch("https://hooks.example.com", { method: "POST", body: JSON.stringify(todo) });
    await ctx.runMutation(internal.todos.markReminded, { todoId });
  },
});
```

- **`ctx.db`** is available in queries (read-only) and mutations. It has `get`, `query`, `insert`, `patch` (shallow merge; setting a field to `undefined` removes it), `replace` and `delete`. Actions have no `ctx.db`, and the compiler rejects it.
- **Arguments** are validated on every call. **`returns`** is optional: when given, it becomes the function's return type and is checked at runtime. A mutation with a wrong return value rolls back.
- **`ctx.auth.getUserIdentity()`** returns `{ userId, email, name, sessionId }` or `null`.
- **`ctx.storage`** and **`ctx.scheduler`** are covered in [File storage](storage.html) and [Scheduling](scheduling.html).

## Internal functions

`internalQuery`, `internalMutation` and `internalAction` can only be called from other functions (`ctx.runQuery(internal.x.y)`), the scheduler, crons, migrations and the dashboard. Clients can't reach them: codegen leaves them out of `api` and puts them in `internal`, and the server returns "Unknown function" for them.

## Mutations retry

On Postgres, mutations run SERIALIZABLE and retry automatically on conflicts. Keep them deterministic: put randomness and network calls in actions.

## A note on self-references

A handler that calls `api.<its own module>.*` needs an explicit return type annotation (`async (ctx, args): Promise<string> => …`). Without it, TypeScript can't infer the module's types in a cycle.
