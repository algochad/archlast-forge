# Schema and validators

```ts
// convex/schema.ts
import { defineSchema, defineTable, v } from "@archlast-forge/runtime";

export default defineSchema({
  lists: defineTable({ name: v.string() }),
  todos: defineTable({
    listId: v.id("lists"),
    title: v.string(),
    done: v.boolean(),
    tags: v.optional(v.array(v.string())),
  })
    .index("by_list", ["listId"])
    .index("by_list_done", ["listId", "done"])
    .searchIndex("search_title", { searchField: "title", filterFields: ["listId"] }),
});
```

Every document gets `_id` (an `Id<"todos">`, a string like `todos:3f…`) and `_creationTime` (milliseconds). Documents are stored as JSON and validated against the schema on every write. Changing a field never requires a database migration, but existing documents must still match the schema (see [Migrations](migrations.html)).

## Validators

| Validator | TypeScript type |
|---|---|
| `v.string()`, `v.number()`, `v.boolean()`, `v.null()` | `string`, `number`, `boolean`, `null` |
| `v.id("lists")` | `Id<"lists">`, which rejects ids from other tables |
| `v.array(v.string())` | `string[]` |
| `v.object({ a: v.number() })` | `{ a: number }` (extra keys are rejected) |
| `v.union(v.string(), v.null())` | `string \| null` |
| `v.optional(v.string())` | an optional field |

`Infer<typeof validator>` gives you the type. Validation runs through Zod, and errors name the exact path: `args.todos[2].title must be a string`.

## Built-in tables

`users`, `sessions`, `accounts` and `verifications` belong to Better Auth, and `_storage` holds file metadata. You can reference them (`v.id("users")`, `v.id("_storage")`) but can't redefine them. Store extra user data in your own table keyed by `userId`.
