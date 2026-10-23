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

## Relationships

A `v.id("lists")` field is a reference to the `lists` table, and `v.array(v.id("todos"))` a list of references. Nothing else is needed: the dashboard draws them (Data, then Relationships), makes them links between documents, and [`include`](queries.html#joins) follows them in queries. Give the field an index (`.index("by_list", ["listId"])`) to look documents up by it, from either direction:

```ts
todos: defineTable({ listId: v.id("lists"), blockedBy: v.optional(v.array(v.id("todos"))), … })
  .index("by_list", ["listId"]),
```

Only top-level `v.id` fields and arrays of them count; ids inside nested objects and unions work as data but aren't followed. References aren't checked on write beyond the id belonging to the right table, and deleting a document leaves the ids that pointed at it (see [Joins](queries.html#joins)).

## Built-in tables

`users`, `sessions`, `accounts` and `verifications` belong to Better Auth, and `_storage` holds file metadata. You can reference them (`v.id("users")`, `v.id("_storage")`) but can't redefine them. Store extra user data in your own table keyed by `userId`.
