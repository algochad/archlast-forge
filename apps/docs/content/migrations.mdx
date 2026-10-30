# Migrations and data

Two kinds of change need attention when your app evolves:

- **Structure**: tables and indexes. The engine syncs them with `forge/schema.ts` by itself.
- **Data**: documents that no longer fit the schema. You write a small migration, and the engine runs it in batches.

Documents are stored as JSON, so there are no columns to alter: adding or removing a field never touches the database structure. What changes is whether the stored documents still *match* the schema, which the engine checks.

## How tables and indexes sync

Every start (and `archlast-forge migrate`) compares `schema.ts` with the database:

- **New tables** are created. A table is three columns, `(_id, _creationTime, doc)`; `doc` holds the fields as JSON (JSONB on Postgres).
- **New indexes** are built. Each one is a database index on the JSON fields, plus `_creationTime` and `_id`. Every table also gets `by_creation_time`.
- **Changed indexes** are replaced. An index's database name is a hash of its table, name and fields, so changing the fields of `by_list` creates a new index and drops the old one. Until the new one is built, queries on it still return correct results but are slow.
- **Removed indexes** are dropped.
- **Removed tables keep their data.** Take a table out of the schema and its rows stay where they are, unused; put it back and they return. To delete one for good, drop it with SQL.
- **Search indexes** follow the same rules: on SQLite a search index is an FTS5 table that is created and filled from the existing documents; on Postgres it is a GIN index.

How it is done depends on the engine:

| | SQLite | Postgres |
|---|---|---|
| Tables, indexes | one write transaction at startup | tables under an advisory lock; each index built with `CREATE INDEX CONCURRENTLY`, outside a transaction, so writes aren't blocked |
| Several servers starting together | not applicable (one server) | a session advisory lock makes them take turns, so replicas can start at once |
| A failed or interrupted index build | the transaction rolls back | the invalid leftover is detected on the next start, dropped and rebuilt |

On a large table, building an index takes time proportional to its size, and the server answers requests only after the sync has finished. Add indexes before a table grows, or plan a deploy window.

## The schema check

Outside dev, startup also reads every document of every table you defined and validates it against the schema. If any don't match, the server **refuses to start**:

```
✗ Stored documents don't match the schema (fix them with a migration, or set SCHEMA_CHECK=off):
  todos:679e0951b69b4517be445c4421f64153: todos.priority is required
  todos:dc1af802fdb44a49bbe19b485cfd6b80: todos.priority is required
```

It reports the first ten and stops. A broken deploy then fails at start instead of corrupting data or throwing on the first read of a bad document.

- `SCHEMA_CHECK=off` skips it (it is on by default outside dev; `1`, `true`, `on` and `yes` turn it on, and any other value turns it off). In dev it is off.
- The check reads the whole database at startup, so on a very large database it adds to the start time.
- The built-in `users`, `sessions`, `accounts` and `verifications` tables are not checked, since Better Auth plugins add fields to them.
- What counts as a mismatch is the same as for any write: a missing required field, a value of the wrong type, and **a field the schema doesn't declare** (`todos.dueAt is not in the validator`). Validators are strict.

To see the list without starting the server, run `archlast-forge migrate`:

```
✓ migrated 8 tables
  ✗ todos:679e…: todos.priority is required
  ✗ todos:dc1a…: todos.priority is required
✗ 4 documents don't match the schema; write a migration and run `archlast-forge migrate --run-migrations`
```

It syncs the structure, then lists the documents that don't match (it collects up to 1,000 and prints the first 50) and exits with an error if there are any.

## Data migrations

A migration is declared with `migration({ table, migrateOne })`. Put it in any module under `forge/`:

```ts
// forge/migrations.ts
import { migration } from "@archlast/forge-runtime";

export const addPriority = migration({
  table: "todos",
  migrateOne: (_ctx, todo) => (todo.priority === undefined ? { priority: 0 } : undefined),
});
```

`migrateOne(ctx, doc)` is called for every document of the table. It gets a mutation context (`ctx.db`, `ctx.scheduler`, `ctx.storage`) and the document. Return:

- an object, to patch the document with it. A field set to `undefined` is **removed** from the document;
- nothing, to leave the document alone.

A migration is registered as an *internal mutation* named after its module and export (`migrations:addPriority`). Clients can't call it; the CLI, the dashboard and other functions can. `batchSize` (default 100) sets how many documents each transaction handles.

### Running

```bash
archlast-forge migrate --status                          # every migration with its state and counts
archlast-forge migrate --run-migrations                  # run every migration that isn't done
archlast-forge migrate --run-migrations migrations:addPriority   # run the named ones
```

```
pending  migrations:addPriority  (todos, 0 processed)
✓ ran migrations:addPriority
done     migrations:addPriority  (todos, 4 processed)
```

The CLI sends the command to the running server, so the writes reach live queries and subscribers. When no server is running it opens the database itself. The run is recorded in the audit log.

How it behaves:

- **One transaction per batch.** Each batch pages through the table in creation order. If `migrateOne` throws, that batch rolls back, the migration stops, and the batches before it stay done. Nothing is half-applied inside a batch.
- **Progress is saved.** `_migrations` records the state (`pending`, `running`, `done`, `failed`), a cursor and the number of documents processed. After a failure the state is `failed` with the error. Fix the cause and run it again: it **resumes** from the batch that failed.

  ```
  ✗ Migration migrations:shout failed after 2 documents: t3 is cursed. Fix it and run again; it resumes.
  failed   migrations:shout  (todos, 2 processed)  ✗ t3 is cursed
  ```

- **Naming a finished migration runs it again from the start.** Running without names skips finished ones.
- **Order.** Migrations run in the order your modules load, not the order you type the names. If one depends on another, run them in separate commands.
- **Live traffic continues.** The app can read and write between batches. New documents get a later creation time, so the run reaches them if it hasn't finished. Deploy code that already writes the new shape first, so the migration doesn't race documents written in the old shape.
- **Live queries re-run** for every batch that patches documents (see [Reactivity](reactivity.html)). A migration over a big table makes subscribers refetch a lot of data in a short time; run it at a quiet hour.
- **Make `migrateOne` safe to repeat.** The example checks `todo.priority === undefined`, so a second run changes nothing.

## Worked examples

### Add a required field

Adding a required field in one step breaks startup: the old documents don't have it. Do it in three deploys.

1. Add the field as optional, and make new code write it.

   ```ts
   todos: defineTable({ …, priority: v.optional(v.number()) })
   ```

2. Deploy, then run the migration that fills the old documents.

   ```bash
   archlast-forge migrate --run-migrations
   ```

3. Make the field required in the schema, and deploy again.

   ```ts
   todos: defineTable({ …, priority: v.number() })
   ```

If you jump to step 3 first, the schema check refuses to start the server. You can still run the migration without a server: `archlast-forge migrate --run-migrations` opens the database directly and doesn't do the schema check; then start the server. In a Docker stack whose container can't start, set `SCHEMA_CHECK=off` for one start, run the migration, and set it back. Taking a [backup](#export-import-and-backup) first is cheap insurance.

### Rename a field and change its type

`dueAt` (a number of milliseconds) becomes `due` (an ISO string). Keep both in the schema while you move.

```ts
// 1. schema: both fields, both optional
dueAt: v.optional(v.number()),
due: v.optional(v.string()),
```

```ts
// 2. forge/migrations.ts
export const moveDue = migration({
  table: "todos",
  migrateOne: (_ctx, todo) =>
    todo.dueAt === undefined ? undefined : { due: new Date(todo.dueAt).toISOString(), dueAt: undefined },
});
```

```bash
archlast-forge migrate --run-migrations
archlast-forge migrate --status        # done  migrations:moveDue  (todos, 4 processed)
```

```ts
// 3. schema: drop dueAt
due: v.optional(v.string()),
```

`dueAt: undefined` in the patch deletes the old field, so the documents match the new schema. If you remove `dueAt` from the schema *before* the migration has run, `archlast-forge migrate` lists every document that still has it: `todos.dueAt is not in the validator`.

Between steps 1 and 3 your functions have to cope with both shapes (read `due`, falling back to `dueAt`). Once the field is gone from the schema, `todo.dueAt` no longer type-checks in the migration file; delete the migration once every environment has run it, or cast (`(todo as any).dueAt`).

### Change a type in place

Same recipe: add a new field of the new type, copy and convert in a migration, switch the code to the new field, then drop the old. Changing a field's type in place makes every stored document invalid at once, so there is no safe single step.

### Test a migration

[`createTestBackend`](testing.html) runs a migration in memory. Keep the old field in the schema while you test:

```ts
const result = await t.mutation(internal.migrations.moveDue, { cursor: null });
expect(result).toMatchObject({ isDone: true, processed: 2 });
```

`result` is one batch: `{ cursor, isDone, processed }`. Pass `cursor` back in to continue when `isDone` is false.

## Export, import and backup

```bash
archlast-forge export data.jsonl             # every document, ids preserved
archlast-forge import data.jsonl             # into empty tables
archlast-forge import data.jsonl --replace   # clear the tables in the file first
archlast-forge backup app.db                 # SQLite: a consistent copy
```

### The format

JSON Lines: one document per line, tables in schema order.

```json
{"table":"todos","_id":"todos:679e0951b69b4517be445c4421f64153","_creationTime":1792850187983.3203,"doc":{"listId":"lists:f11a…","title":"T1","done":false,"priority":0}}
```

`_id` and `_creationTime` are kept, so references between documents (`v.id` fields) stay valid and ordering by creation time is preserved. The export has every table in your schema, including `users`, `sessions`, `accounts`, `verifications` and the metadata of stored files (`_storage`). It does not have the file contents (those are in S3), scheduled jobs, logs, dashboard accounts, or variables set with `env set`.

### Import

- Every document is validated against the schema as it is written. A document that doesn't fit fails the import.
- **Without `--replace`**, a table that already has documents is an error: `Table "lists" already has 3 documents; pass --replace to clear it first`. Nothing is imported.
- **With `--replace`**, the tables that appear in the file are emptied first. A table that has documents in the database but none in the file is left alone.
- The file is read into memory, then written 500 documents per transaction. The import as a whole is **not atomic**: a failure leaves the earlier batches in place. Fix the problem and run it again with `--replace`.
- Through a running server, subscribers see the imported documents like any write.
- An export of a live database is not a single snapshot (it reads in pages). For a consistent copy, export while writes are quiet, or use `backup` on SQLite.

### Backup

On SQLite, `backup` makes a consistent copy of the database while the engine runs (`VACUUM INTO`). The result is an ordinary database file: to restore it, stop the engine and put the file at `DATA_DIR/app.db`. On Postgres, use `pg_dump`; `backup` says so and does nothing. For a Docker stack, see [Backends](backend.html#backups-and-restores).

### Moving from SQLite to Postgres

1. On the SQLite deployment, `archlast-forge export data.jsonl`.
2. Start the same code with `DATABASE_URL=postgres://…`. Tables and indexes are created, and the new database is empty.
3. `archlast-forge import data.jsonl`.
4. Set the environment variables again (`env set`; they aren't in the export), create dashboard accounts with `admin add`, and check the counts on the dashboard's **Data** page.
5. Switch traffic, and keep the SQLite file until you are sure.

Scheduled jobs that were pending aren't carried over, so reschedule them, or let the next cron run recreate them. Test your key queries against the Postgres copy before the cutover, in particular anything that sorts or compares across mixed types.

## Practical advice

- Add fields as optional. Required fields mean a migration.
- Keep a migration idempotent, and keep the old and new shapes both readable for one deploy.
- Back up before running one on production data.
- Run `archlast-forge migrate` in CI against a copy of production data (or an export of it) to catch mismatches before the deploy.
- Prefer many small migrations over one that does several things: the failure state is clearer.
- Watch the **Logs** page and the **Metrics** page while a big migration runs; each batch is a normal mutation.
