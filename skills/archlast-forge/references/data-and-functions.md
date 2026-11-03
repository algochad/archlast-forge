# Data and functions: schema, `ctx.db`, functions, errors, migrations

Read this when you write or change `forge/schema.ts`, any query, mutation or action, anything that calls `ctx.db`, or a data migration.
Checked against archlast-forge 0.16.0. `forge/` is the backend; `app/` (full-stack) or `src/` (backend + own frontend) is the frontend.
Auth setup, scheduling and crons, HTTP routes, file storage and client hooks are covered in the other references.

## 1. Layout and import rules

```
forge/
  schema.ts         default export defineSchema({...}) (required)
  tasks.ts          every export made with query/mutation/action/internal* is a function: "tasks:add"
  admin/users.ts    -> "admin/users:count" -> api.admin.users.count
  _lib/auth.ts      helpers: a file or folder starting with "_" or "." is never a function module
  auth.ts crons.ts http.ts   special files (default export), never function modules
  _generated/       api.ts + dataModel.ts, written by `archlast-forge codegen`, committed, never edited
  package.json      server-only dependencies: bun add --cwd forge <pkg>
```

- Other exports (constants, helpers, types) in a function module are ignored. `*.test.ts`, `*.spec.ts`, `*.d.ts` and `node_modules` are never loaded as modules.
- After you add, rename or remove a function module, run `archlast-forge codegen` (`archlast-forge dev` does it on save; scaffolds have `bun run typecheck` = codegen + tsc). A stale `_generated/api.ts` shows as `Property 'x' does not exist on type ...ModuleRefs...`.
- `forge/` code imports from `@archlast/forge-runtime`, `./_generated/api` (`api`, `internal`) and `./_generated/dataModel` (`Doc`, `Id`, `TableNames`).
- `src/` and `app/` import only from `forge/_generated` (plus client packages such as `@archlast/forge-react`). Codegen fails on any other relative import into `forge/`, and on `forge/_generated/rpc` or `@archlast/forge-runtime/nest/rpc`. `api` is a typed reference object, not the function, so no server code reaches the bundle. `ForgeError` comes from `@archlast/forge-react` or `@archlast/forge-client` in the browser.
- Internal functions are absent from `api` and from the client router: a client calling one gets "No function" (HTTP 404).

## 2. Schema

```ts
// forge/schema.ts
import { defineSchema, defineTable, v } from "@archlast/forge-runtime";

// `users`, `sessions`, `accounts`, `verifications` and `_storage` are built in: do not redefine them.
export default defineSchema({
  projects: defineTable({
    ownerId: v.id("users"),
    name: v.string(),
  }).index("by_owner_name", ["ownerId", "name"]),

  tasks: defineTable({
    projectId: v.id("projects"),
    title: v.string(),
    done: v.boolean(),
    priority: v.optional(v.number()),
    tags: v.optional(v.array(v.string())),
    dueAt: v.optional(v.number()),
  })
    .index("by_project", ["projectId"])
    .index("by_project_done", ["projectId", "done"])
    .index("by_project_priority", ["projectId", "priority"])
    .searchIndex("search_title", {
      searchField: "title",
      filterFields: ["projectId"],
    }),
});
```

- Table and field names match `^[a-zA-Z][a-zA-Z0-9_]*$` (no leading underscore, no dashes). Startup fails with a message naming the table otherwise.
- Every document also has `_id` (`Id<"tasks">`, a string `tasks:<32 hex>`; treat as opaque) and `_creationTime` (ms since epoch, fractional). Never declare them; never pass them to `insert` or `replace`.
- Documents are JSON, at most 1 MiB. No `Date`, `Map`, `bigint`, binary.
- Per-user data goes in your own table with `userId: v.id("users")`, never in `users` (Better Auth owns it). You can read `users` (`ctx.db.get(me.userId)`, index `by_email`) and reference it with `v.id("users")`; do not write to it.

| Validator                                        | Type                                | Notes                                                      |
| ------------------------------------------------ | ----------------------------------- | ---------------------------------------------------------- |
| `v.string()`, `v.boolean()`, `v.null()`          | `string`, `boolean`, `null`         |                                                            |
| `v.number()`                                     | `number`                            | finite only (NaN and Infinity rejected); no integer type   |
| `v.id("tasks")`                                  | `Id<"tasks">`                       | checks the table prefix only, not that the document exists |
| `v.array(x)`, `v.object({...})`, `v.union(a, b)` |                                     | `v.object` is strict at every depth                        |
| `v.optional(x)`                                  | `T \| undefined`, key may be absent | does not accept `null`                                     |

There is no `v.literal`, `v.any`, `v.record`, `v.bytes`, `v.bigint` or `v.date`. Store dates as `number` (ms), enums as `v.string()` and check the allowed values in the handler (`v.union(v.string(), v.string())` restricts nothing), files as `v.id("_storage")`.

Rules that cause most schema errors:

- `v.object` rejects keys it does not declare (`args.o.b is not in the validator`), in args and documents alike.
- `v.optional(v.string())` accepts a missing key or `undefined`, not `null`. For null write `v.union(v.string(), v.null())`.
- `v.optional` wraps only a field of `defineTable`, `v.object` or `args`. `v.array(v.optional(x))` and `v.union(v.optional(x))` do not type-check.
- References (`v.id`) are not enforced: deleting a document leaves the ids that point at it. Cascade by hand (section 6).
- Types: `Doc<"tasks">`, `Id<"tasks">` from `./_generated/dataModel`; `Infer<typeof validator>` from the runtime.

## 3. Indexes and search indexes

- `.index(name, fields)`: a non-empty list of top-level fields. Names `by_id` and `by_creation_time` are reserved: every table already has `by_creation_time`. Indexes are not unique.
- A query uses `eq` on a prefix of the index's fields, then at most one lower and one upper bound on the next field. Results come out ordered by the fields not fixed with `eq`, then `_creationTime`. Put the field you always fix first: `["projectId", "done"]` serves "a project's tasks" and "a project's open tasks".
- A document missing an indexed field is still in the index: `q.eq("priority", undefined)` finds it, range operators (`gt`, `gte`, `lt`, `lte`) leave it out.
- Every write updates every index and publishes a topic per index prefix. Add the indexes your queries use, not more.
- Adding, removing, renaming or reordering an index is applied at the next start (a rename rebuilds it). Nothing to migrate.
- `.searchIndex(name, { searchField, filterFields? })`: `searchField` must be a `v.string()` (or optional string) field; `filterFields` are fields you can narrow by equality. Names are unique across both index kinds. SQLite uses FTS5, Postgres a GIN index; no stemming (`run` does not match `running`).

## 4. Defining functions

|                             | `query`                               | `mutation`                                                 | `action`                                                                            |
| --------------------------- | ------------------------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `ctx` has                   | `db` (read), `auth`, `storage.getUrl` | `db` (read+write), `auth`, `storage`, `scheduler`          | `auth`, `storage`, `scheduler`, `runQuery`, `runMutation`, `runAction`; **no `db`** |
| Runs in                     | one read snapshot                     | one transaction, rolled back on any throw                  | no transaction                                                                      |
| Live (re-runs on change)    | yes                                   | no                                                         | no                                                                                  |
| `fetch` / SDKs / randomness | never                                 | never                                                      | yes                                                                                 |
| Time limit                  | 10 s                                  | 10 s                                                       | 10 min                                                                              |
| Retries                     | n/a                                   | may re-run on a Postgres serialization conflict (up to 10) | never: at most once                                                                 |

`internalQuery`, `internalMutation`, `internalAction` take the same definition but clients cannot call them (only other functions, the scheduler, crons, migrations, the dashboard).

```ts
// forge/_lib/auth.ts
import { ForgeError, type QueryCtx } from "@archlast/forge-runtime";

/** The signed-in user, or a ForgeError the client can show. Takes any ctx. */
export async function requireUser(ctx: Pick<QueryCtx, "auth">) {
  const me = await ctx.auth.getUserIdentity(); // { userId, sessionId, email, name } | null
  if (!me) throw new ForgeError("Sign in first");
  return me;
}
```

```ts
// forge/tasks.ts
import {
  ForgeError,
  mutation,
  query,
  v,
  type MutationCtx,
  type QueryCtx,
} from "@archlast/forge-runtime";
import type { Id } from "./_generated/dataModel";
import { requireUser } from "./_lib/auth";

/** A plain function shared by handlers: queries cannot call queries, mutations cannot call mutations. */
async function ownedProject(
  ctx: QueryCtx | MutationCtx,
  projectId: Id<"projects">,
) {
  const me = await requireUser(ctx);
  const project = await ctx.db.get(projectId);
  if (!project || project.ownerId !== me.userId)
    throw new ForgeError("No such project"); // one answer for "missing" and "not yours"
  return project;
}

export const open = query({
  args: { projectId: v.id("projects") },
  handler: async (ctx, { projectId }) => {
    await ownedProject(ctx, projectId);
    return ctx.db
      .query("tasks")
      .withIndex("by_project_done", (q) =>
        q.eq("projectId", projectId).eq("done", false),
      )
      .order("desc")
      .take(100);
  },
});

export const add = mutation({
  args: {
    projectId: v.id("projects"),
    title: v.string(),
    priority: v.optional(v.number()),
  },
  returns: v.id("tasks"),
  handler: async (ctx, { projectId, title, priority }) => {
    await ownedProject(ctx, projectId);
    const clean = title.trim();
    if (!clean || clean.length > 200)
      throw new ForgeError("A title is 1 to 200 characters");
    return ctx.db.insert("tasks", {
      projectId,
      title: clean,
      done: false,
      priority,
    });
  },
});
```

- `args` is an object of validators (omit for none). It is checked before the handler runs; extra keys are rejected; values must be JSON. The handler's `args` type is derived from it.
- `returns` (optional) makes the validator the return type and checks the real value. A mismatch is a server bug: HTTP 500, and a mutation rolls back. `undefined` counts as `null`. Results are limited to 8 MiB.
- `returns: v.object({ title: v.string() })` fails on a returned document, because `_id` and `_creationTime` are undeclared and objects are strict. To describe stored documents reuse the schema:
  ```ts
  import schema from "./schema";
  const taskDoc = v.object({
    _id: v.id("tasks"),
    _creationTime: v.number(),
    ...schema.tables.tasks.fields,
  });
  // returns: v.union(taskDoc, v.null())  /  v.array(taskDoc)
  ```
- Authorization is your code. Public functions are an API: check `ctx.auth` and ownership in each one. Scheduled and cron functions run with no user (`getUserIdentity()` is `null`): pass ids as arguments.
- A query that calls `ctx.auth.getUserIdentity()` is cached once per user. If the identity is only checked, not used to shape the result, declare the check as `access` so one cached result serves everyone who passes:

  ```ts
  export const latest = query({
    args: {},
    access: requireUser, // runs for every caller, every time; a throw refuses the caller
    handler: (ctx) => ctx.db.query("tasks").order("desc").take(20), // reading ctx.auth here throws
  });
  ```

  `access` decides who may see the result, not what it contains. If the data differs by caller, drop `access`.

### Actions: calling the outside world

```ts
// forge/digest.ts
import {
  action,
  ForgeError,
  internalMutation,
  v,
} from "@archlast/forge-runtime";
import { api, internal } from "./_generated/api";

export const markSent = internalMutation({
  args: { projectId: v.id("projects"), status: v.string() },
  handler: async (ctx, { projectId, status }) => {
    await ctx.db.insert("tasks", {
      projectId,
      title: `digest ${status}`,
      done: true,
    });
  },
});

export const send = action({
  args: { projectId: v.id("projects") },
  // Annotate the return type: this handler uses internal.digest.* from its own module, which TypeScript cannot infer.
  handler: async (ctx, { projectId }): Promise<{ sent: boolean }> => {
    const open = await ctx.runQuery(api.tasks.open, { projectId }); // runs as the same user
    await ctx.runMutation(internal.digest.markSent, {
      projectId,
      status: "sending",
    }); // its own transaction, committed now
    try {
      const res = await fetch(
        process.env.DIGEST_URL ?? "https://example.invalid/digest",
        { method: "POST", body: JSON.stringify(open) },
      );
      if (!res.ok) throw new Error(`Digest API answered ${res.status}`);
      await ctx.runMutation(internal.digest.markSent, {
        projectId,
        status: "sent",
      });
      return { sent: true };
    } catch (e) {
      await ctx.runMutation(internal.digest.markSent, {
        projectId,
        status: "failed",
      });
      throw new ForgeError(`Could not send: ${(e as Error).message}`);
    }
  },
});
```

- At most once, no retries, by the server or the client. Record intent with a mutation first, do the I/O, record the outcome with a second mutation. Make external calls idempotent (send an idempotency key).
- Every `ctx.runMutation` is its own transaction: if the second fails, the first stays committed. Need atomic? Do both writes in one mutation.
- Schedule work from a mutation with `ctx.scheduler.runAfter(ms, internal.mod.fn, args)`: the job exists only if the mutation commits. Only mutations and actions can be scheduled. Details: the scheduling reference.
- Annotate the handler's return type (`Promise<...>`) whenever it references `api.<its own module>` or `internal.<its own module>`, or two modules call each other. A `returns` validator alone does not break the cycle.

## 5. Reading: `ctx.db`

Every method is async: `await` it. A promise left running after the function returned fails with `Transaction already finished`.

```ts
const task = await ctx.db.get(id);                  // Doc | null (the id carries its table)
const many = await ctx.db.getMany(ids);             // (Doc | null)[], same order, one round trip
const rows = await ctx.db.query("tasks")...;        // see the chain below
```

A chain is `ctx.db.query(table)` + optional steps + one terminal call.

| Step                                                                                                | Use                                                                                                                                                                                                                                                                     |
| --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `.withIndex(name, q => q.eq(f, v)... )`                                                             | pick the range: `eq` on a prefix of the index fields, then `gt/gte` and `lt/lte` on the next field. Built-in `"by_creation_time"` takes `q.gt("_creationTime", t)`. Order and field mistakes throw (`Index "tasks.by_project_done" field 0 is "projectId", not "done"`) |
| `.withSearchIndex(name, q => q.search(f, text).eq(filterField, v))`                                 | full-text; see section 3                                                                                                                                                                                                                                                |
| `.where(q => q.and(q.eq("done", false), q.or(q.prefix("title", "Fix"), q.in("priority", [1, 2]))))` | conditions in SQL: `eq neq gt gte lt lte between in prefix and or not`; top-level fields only; several `where` calls all apply                                                                                                                                          |
| `.order("desc")`                                                                                    | reverses the whole order (default ascending by index fields, then `_creationTime`)                                                                                                                                                                                      |
| `.orderBy([["priority", "desc"], ["title", "asc"]])`                                                | sorts by these fields instead of the index order                                                                                                                                                                                                                        |
| `.filter(doc => ...)`                                                                               | JavaScript predicate, sees `include()` data; use only for what SQL cannot say (array contents, two fields)                                                                                                                                                              |
| `.select(["title", "priority"])`                                                                    | keeps only these fields (plus `_id`, `_creationTime`): smaller results                                                                                                                                                                                                  |
| `.include({...})`                                                                                   | joins, see below                                                                                                                                                                                                                                                        |
| `.skip(n)`                                                                                          | passes over `n` matches                                                                                                                                                                                                                                                 |

| Terminal                                | Returns                                                                     |
| --------------------------------------- | --------------------------------------------------------------------------- |
| `.collect()`                            | every match (bounded only by the 8 MiB result limit: narrow first)          |
| `.take(n)` / `.first()`                 | at most `n` / the first or `null`                                           |
| `.unique()`                             | the one match, `null` for none, throws if several                           |
| `.paginate(opts)`                       | `{ page, isDone, continueCursor, total? }`                                  |
| `.count()`                              | number (one SQL `COUNT` unless there is a `filter`)                         |
| `.sum(f)` `.avg(f)` `.min(f)` `.max(f)` | number fields; missing values skipped; `avg/min/max` give `null` when empty |

```ts
// eq on the prefix, one range on the next field
ctx.db
  .query("tasks")
  .withIndex("by_project_priority", (q) =>
    q.eq("projectId", projectId).gte("priority", 3),
  );

// index narrows, where/orderBy/select refine in SQL
ctx.db
  .query("tasks")
  .withIndex("by_project", (q) => q.eq("projectId", projectId))
  .where((q) =>
    q.and(
      q.eq("done", false),
      q.or(q.prefix("title", "Fix"), q.in("priority", [1, 2])),
    ),
  )
  .orderBy([
    ["priority", "desc"],
    ["title", "asc"],
  ])
  .select(["title", "priority"])
  .take(20);

// JavaScript filter for what SQL cannot express
ctx.db
  .query("tasks")
  .withIndex("by_project", (q) => q.eq("projectId", projectId))
  .filter((t) => t.tags?.includes("urgent") ?? false)
  .take(50);
```

Limits: a query with `filter()`, and `sum`/`avg`/`min`/`max`, scan at most 100,000 documents (then they throw: narrow with `withIndex`); `skip` at most 100,000; `paginate` `numItems` 1 to 8192; a search returns at most 1,024. In dev, a `where`/`orderBy` that no index serves logs a warning naming the table: add the index.

### Joins

References are `v.id` fields. `include` follows them for all results at once, in a few batched queries, and the query stays reactive to them.

```ts
// forward: follow a field -> Doc | null (an array of ids gives the documents that still exist)
ctx.db
  .query("tasks")
  .withIndex("by_project", (q) => q.eq("projectId", projectId))
  .include({ project: "projectId" })
  .take(20);

// reverse: documents of another table that point back, through an index whose FIRST field is that reference
ctx.db
  .query("projects")
  .withIndex("by_owner_name", (q) => q.eq("ownerId", me.userId))
  .include({
    recent: { table: "tasks", index: "by_project", order: "desc", take: 3 }, // Doc<"tasks">[] (one query per parent when `take` is set)
    taskCount: { table: "tasks", index: "by_project", count: true }, // number
  });

// documents you already have
const full = await ctx.db.include("tasks", await ctx.db.get(id), {
  project: "projectId",
}); // null stays null; arrays work too
```

A key cannot reuse a field name of the document. An array-of-ids field cannot be looked up in reverse. `include` also works on search results and on pages from `paginate`.

## 6. Writing (mutations only)

```ts
const id = await ctx.db.insert("tasks", { projectId, title: "x", done: false }); // Id<"tasks">; no _id or _creationTime
await ctx.db.patch(id, { done: true }); // shallow merge; a nested object you pass replaces the stored one
await ctx.db.patch(id, { priority: undefined }); // removes the field
await ctx.db.replace(id, { ...fields, title }); // whole document, WITHOUT _id and _creationTime
await ctx.db.delete(id); // no error if already gone
const ids = await ctx.db.insertMany("tasks", rows); // Id[]; validates every row first: one bad row writes nothing
const { errors } = await ctx.db.updateMany(
  "tasks",
  ids.map((id) => ({ id, patch: { done: true } })),
  { mode: "partial" },
);
// insertMany(..., { mode: "partial" }) -> { ids: (Id | null)[], errors: { index, message }[] }
```

- Every write validates the whole resulting document against the schema (stray key, wrong type, wrong-table id all throw `ValidationError` naming `tasks.field`), even if the patch did not touch the bad field. `patch`/`replace` of a missing document throws `Document tasks:... not found`.
- `replace` with the document you read fails (`tasks._id is not in the validator`): destructure `{ _id, _creationTime, ...fields }` first.
- Reads inside a mutation see its own earlier writes. Topics publish only after commit; a thrown mutation notifies nobody and writes nothing.
- Uniqueness: indexes are not unique, so check then insert inside one mutation (serializable, no race):
  ```ts
  const taken = await ctx.db
    .query("projects")
    .withIndex("by_owner_name", (q) =>
      q.eq("ownerId", me.userId).eq("name", clean),
    )
    .first();
  if (taken) throw new ForgeError({ code: "NAME_TAKEN", name: clean });
  ```
- Cascades: nothing deletes children. Delete them in the same mutation, in batches (`take(500)`) so it stays inside 10 s; for more, schedule the next batch.
- Keep mutations to database work. Anything else in the handler (fetch, module-level counters, files) is repeated if the mutation re-runs; do it in an action.

## 7. Pagination

```ts
import { paginationOptsValidator, query, v } from "@archlast/forge-runtime";

export const page = query({
  args: {
    projectId: v.id("projects"),
    paginationOpts: paginationOptsValidator,
  },
  handler: (ctx, { projectId, paginationOpts }) =>
    ctx.db
      .query("tasks")
      .withIndex("by_project", (q) => q.eq("projectId", projectId))
      .order("desc")
      .paginate(paginationOpts),
});
```

- The client hooks (`usePaginatedQuery`, `useNumberedPage`) need exactly this shape: an arg named `paginationOpts` and a return of `PaginationResult`. To transform rows, spread the result and replace `page`.
- First page `{ numItems, cursor: null }`, next `{ numItems, cursor: continueCursor }`; stop when `isDone`. Cursors are keyset-based (stable under inserts) and opaque; one from another query shape throws `Invalid pagination cursor`.
- Numbered pages: `paginationOpts` also takes `offset` and `withTotal: true` (adds `total`). Inside a function use `skip`: `all().skip((page - 1) * size).take(size)` plus `all().count()` for the total.
- Search queries cannot paginate: `take` them.

## 8. Reactivity and caching: rules that change how you write code

- Each query records what it read as topics: the table (no `eq` prefix), `table:index:[values]` (the `eq` prefix of `withIndex`), `table:by_id:[id]` (`get`, `getMany`, forward `include`). A committed write publishes every topic it touched, old and new values; subscribed queries re-run (50 ms debounce) and the client gets the result only if it changed.
- Only `withIndex` equality narrows what wakes a query. `where`, `filter`, range bounds and `take` do not. A query without an `eq` prefix re-runs on every write to the table; a search re-runs on any write to its table.
- So: query by an indexed owner/parent field with `eq`; keep results small (each change re-sends the whole result); do not put noise (`Date.now()`, random order, counters nobody shows) in a result, or every re-run counts as a change.
- Queries are cached by function and arguments (60 s `CACHE_TTL_MS`, in dev too), evicted when a write touches a topic they read. A query using `ctx.auth` is cached per user; one with `access` is cached once for everyone; mutations and actions never.
- Therefore a query must be a pure function of its arguments, the caller and the database. `Date.now()`, `Math.random()`, `fetch` and `process.env` are not tracked: a query returning `Date.now()` serves the same value for up to a minute. Take time as an argument, rounded: `{ now: v.number() }` and the client passes `Math.floor(Date.now() / 60_000) * 60_000`; or store a flag from a scheduled function.
- External data: fetch it in an action, store it in a table, let a query read the table.
- Two separate queries do not share a snapshot; one query always sees a consistent one.
- Writes from outside the engine (another DB client) publish nothing. Use mutations, the dashboard or the CLI.

## 9. Errors

```ts
if (!me) throw new ForgeError("Sign in first"); // message = the string, data = the string
if (n >= max) throw new ForgeError({ code: "LIMIT", max }); // data = the object, message = its JSON text
```

- `ForgeError` is the only error whose message and `data` reach the caller (always HTTP 400 `BAD_REQUEST`; there is no custom status). Put a machine code in `data` (`{ code: "LIMIT" }`) and branch on it in the client; never put secrets or other users' ids in it.
- Argument and document validation errors also reach the caller (`args.title must be a string, got 5`, `args.listId is required`, `args.extra is not in the validator`).
- Any other thrown error becomes `Server error (request <id>)` outside dev (real message and stack in the server log under that id). Timeouts are `TIMEOUT` (408).
- A thrown error rolls the whole mutation back, including jobs it scheduled.
- From an action, a `runMutation` that throws arrives as the original `ForgeError`: catch it and read `e.data`.
- Server-side checks use `isForgeError(e)` (by name), not `instanceof`, where the class may come from another copy (page loaders on the server). In the browser `e instanceof ForgeError` works.
- Do not catch errors in a query just to return a fallback if the failure is a bug: you hide it. Catch what you can handle.

## 10. Changing the schema and migrating data

Documents are JSON, so a schema change never alters the database; tables and indexes sync at every start.

| Change                                                         | What to do                                                                                                                         |
| -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| Add a table, add an optional field, add/change/remove an index | nothing                                                                                                                            |
| Remove a table                                                 | its data stays in the database, unreachable from functions                                                                         |
| Add a **required** field                                       | 3 deploys: add `v.optional(...)` and write it in new code; deploy and run a migration to fill old documents; then make it required |
| Remove or retype a field                                       | add the new field, migrate, switch code, then drop the old one; a retype in place invalidates every stored document at once        |

Outside dev the server refuses to start when stored documents no longer match the schema (`SCHEMA_CHECK=off` skips it; do not leave it off). `archlast-forge migrate` syncs structure and lists the mismatching documents.

```ts
// forge/migrations.ts: an internal mutation, run in batches of 100 (batchSize), one transaction per batch, resumable
import { migration } from "@archlast/forge-runtime";

export const backfillPriority = migration({
  table: "tasks",
  migrateOne: (_ctx, task) =>
    task.priority === undefined ? { priority: 0 } : undefined, // return a patch or nothing; make it idempotent
});
```

```bash
archlast-forge migrate                              # sync tables/indexes, list documents that do not match
archlast-forge migrate --status                     # each migration: pending/running/done/failed
archlast-forge migrate --run-migrations             # run every unfinished one (or name them: migrations:backfillPriority)
archlast-forge export data.jsonl                    # JSON Lines, every document, ids preserved
archlast-forge import data.jsonl [--replace]        # validated against the schema; --replace clears the tables in the file first
```

- A patch field set to `undefined` removes it (`{ dueAt: undefined }` drops the old field). Keep both shapes in the schema (optional) until the migration has run, and make functions tolerate both meanwhile.
- A failing batch rolls back and stops; fix the cause and run again: it resumes. `migrateOne` gets a mutation ctx (`db`, `scheduler`, `storage`) and can do more than return a patch.
- Back up first on production data (`archlast-forge backup app.db` on SQLite). Test migrations with `createTestBackend` (see the testing reference): `t.mutation(internal.migrations.backfillPriority, { cursor: null })` returns `{ cursor, isDone, processed }`.

## 11. Patterns

- **Own your data**: derive the owner from `ctx.auth`, never from an argument; put `ownerId` first in the index; answer "missing" and "not yours" identically.
- **Index first, filter last**: `withIndex` equality for the selective part, `where` for the rest, `filter` only for JavaScript-only conditions.
- **No N+1**: use `include`, `getMany`, or one indexed query per distinct parent, not `Promise.all(rows.map(get))`.
- **Bound everything**: `take(n)`, `paginate`, `count()`; `collect()` only on ranges you know are small. Do not grow an unbounded array inside one document (1 MiB cap): make it a table with an index on the parent.
- **Counters**: read-modify-write inside one mutation is race-free; "how many X" is cheaper as `.withIndex(...).count()` than a stored counter. One hot row limits write rate.
- **Soft delete**: use a `done`/`deleted` boolean that is part of the index (`["ownerId", "deleted"]`) and make every query state which it wants.
- **Status fields** are `v.string()` checked in the handler (there is no literal validator); move a record through steps with a compare-and-set mutation (`if (row.status !== from) return false`) so a repeated step does nothing.
- **Share code with plain functions** that take `ctx` (`QueryCtx`, `MutationCtx`, `ActionCtx`; a `MutationCtx` works where a `QueryCtx` is expected), kept in `forge/_lib/`.
- **Public vs internal**: anything a client must not trigger (cron targets, scheduled steps, migrations, admin chores) is `internal*`.

## Common mistakes

1. Importing from `forge/` (other than `forge/_generated`) in `app/` or `src/`: codegen fails. Import `api` and types only.
2. Forgetting `archlast-forge codegen` after adding a function module: `api.x.y` does not exist on the type.
3. Calling `fetch`, `Date.now()` or `Math.random()` inside a query and expecting fresh values: results are cached up to 60 s. Use an action, or pass time as a rounded argument.
4. Doing I/O in a mutation: it may re-run on conflicts. Use an action.
5. Expecting an action to retry, or two `runMutation` calls to be atomic.
6. `.collect()` on a big table, or `filter` where an `eq` index exists (scans, fails at 100,000 documents, wakes on every write).
7. Index fields in the wrong order, or `eq` on a field that is not the next one: it throws. Declare the index with the always-fixed field first.
8. `v.optional(...)` expected to accept `null`, or placed inside `v.array`/`v.union`.
9. Returning a document with `returns: v.object({...})` that omits `_id`/`_creationTime`, or passing the read document (with those fields) to `replace`.
10. Missing `await` on a `ctx.db` call: the write may be lost or fail after the transaction ended.
11. Throwing a plain `Error` for a user-facing message: callers only see `Server error (request ...)` outside dev. Use `ForgeError`.
12. Trusting an id from the client: check ownership; ids are validated by table prefix only.
13. Handler references its own module's `api.*`/`internal.*` without an explicit `Promise<...>` return type: inference cycle.
14. Adding a required field in one step: stored documents no longer match and production refuses to start. Add it optional, migrate, then require it.
15. Reading `ctx.auth` in the handler of a query that declares `access`: it throws. Read the caller in `access` only.
16. Hand-editing `forge/_generated`, or defining `users`/`sessions`/`accounts`/`verifications`/`_storage` tables: both are rejected or overwritten.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                            | Read it for                                                                      |
| --------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [schema](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/schema.mdx)         | tables, validators, indexes, search indexes, relations                           |
| [functions](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/functions.mdx)   | queries, mutations, actions, internal functions, `ctx`, limits                   |
| [queries](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/queries.mdx)       | everything on `ctx.db`: indexes, ranges, pagination, search, joins, writes       |
| [reactivity](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/reactivity.mdx) | how live queries re-run                                                          |
| [caching](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/caching.mdx)       | the query cache and the read cache                                               |
| [errors](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/errors.mdx)         | `ForgeError` and the four ways a call fails                                      |
| [migrations](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/migrations.mdx) | schema changes and data migrations                                               |
| [recipes](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/recipes.mdx)       | complete answers: per-user data, soft delete, counters, unique values, workflows |
| [reference](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/reference.mdx)   | exact signatures                                                                 |
| [tutorial](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/tutorial.mdx)     | an end-to-end example                                                            |
