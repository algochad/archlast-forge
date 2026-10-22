# Migrations and data

## Schema changes

Tables and indexes follow `schema.ts` automatically on startup:

- New tables and indexes are created. Indexes are built `CONCURRENTLY` on Postgres, so writes aren't blocked.
- Changed indexes are rebuilt, and removed indexes are dropped.
- Removed tables keep their data.

Documents are JSON, so adding or changing a field needs no database migration. But stored documents must still match the schema. In production, startup refuses to serve when they don't (`SCHEMA_CHECK=off` skips that check). `archlast-forge migrate` lists every document that doesn't match.

## Data migrations

```ts
// convex/migrations.ts
import { migration } from "@archlast-forge/runtime";

export const addPriority = migration({
  table: "todos",
  migrateOne: (ctx, todo) => (todo.priority === undefined ? { priority: 0 } : undefined),
});
```

```bash
archlast-forge migrate --run-migrations           # run every pending migration
archlast-forge migrate --status                   # done / running / failed, with counts
```

Migrations run in batches, one transaction each, and record their progress, so a failed migration resumes where it stopped once you fix it. The typical way to add a required field:

1. Add it as optional.
2. Deploy and run a migration that fills it.
3. Make it required.

## Export, import and backup

```bash
archlast-forge export data.jsonl                  # every document, ids preserved
archlast-forge import data.jsonl [--replace]      # into empty tables, or clear them first
archlast-forge backup app.db                      # SQLite: a consistent copy (use pg_dump for Postgres)
```
