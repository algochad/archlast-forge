# Command: `feature <name> [what it does]`

Builds one complete feature the archlast-forge way: its table, `forge/_modules/<name>/` (module, services, controller when it has an HTTP surface), the thin function file, the registration, and a test. Example: `/archlast-forge feature invoices "customers' invoices, paid or not, listed newest first"`.

`<name>` is the feature: plural and lowercase, one word when you can (`invoices`). It names the folder `forge/_modules/<name>/`, the file `forge/<name>.ts` and so the API (`api.invoices.*`). For two words, look at how the project's existing files are named and check the name codegen gives in `forge/_generated/api` before you use it.

## 1. Before you write

1. Orient: `archlast-forge.json` (mode), `archlast-forge.workspace.json` at a parent (monorepo: which app gets the feature? ask if more than one could), `forge/schema.ts`, `forge/_modules/index.ts`, `forge/http.ts`, and one existing feature folder to copy its naming. A new project has none of these (and its starter `forge/messages.ts` is not a model): use the blueprint's names and files.
2. Read [feature-blueprint.md](../feature-blueprint.md) in full. It is the shape you copy; this command only orders the work.
3. Work out, from the request and the code, and ask only for what you cannot infer:
   - the fields, their bounds and allowed values (they become validators: `v.string({ maxLength })`, `v.enum(...)`);
   - who may read and who may write (the owner? the tenant? anyone signed in? public?);
   - how it is read (by owner, by status, newest first, search) — each becomes an index;
   - whether it needs REST (`controller`), live UI (a page: run [page.md](page.md) after this), I/O (an `ActionCtx` service and an action), scheduled work, webhooks, or tenant scoping ([auth-plugins.md](../auth-plugins.md) §3).
4. If `forge/_modules/<name>/` or `forge/<name>.ts` already exists, stop: extend that feature instead, or ask for another name.

## 2. Steps

1. **Table and indexes** in `forge/schema.ts`: `<name>: defineTable({...})` with bounds in the validators and one `.index(...)` per way of reading (section 1, item 3). A `.searchIndex(...)` for text search.
2. **Services** in `forge/_modules/<name>/<name>.service.ts`: a `Reader extends ForgeService<QueryCtx>` with the reads (and the caller check), a `Writer extends ForgeService<MutationCtx>` with the writes (it may take the `Reader`), and an `ActionCtx` service only for I/O. Ownership and rules live here, once. Lists return `.paginate(paginationOpts)` as it is.
3. **Module** `<name>.module.ts`: every provider (and the controller) listed.
4. **Register**: add the module to `appModules` in `forge/_modules/index.ts` (create the file for the first feature). `forge/http.ts` must mount `nest(http, { imports: appModules })` once: a full-stack scaffold has no `forge/http.ts` (create it as the blueprint shows), a backend's has a demo route (keep it, add the line), a monorepo main app's already calls `nest()` (add `imports: appModules` to that call).
5. **Functions** in `forge/<name>.ts`: `query`/`mutation`/`action` (and `internal*` for what clients must not call), `args` with `v`, each handler `(await inject(ctx, Service)).method(args)`. Nothing else in the handlers.
6. **Controller** (only when it has REST): `<name>.controller.ts` calls the functions with `ctx.runQuery`/`ctx.runMutation` and declares `@Contract({...})` with `summary` and `tags` (and `errors`, the codes it answers, when the app has API docs: `http.docs()` in `forge/http.ts`). Paging goes as `{ numItems, cursor }` to the same query. `@Contract` converts `params` and `query` for their validators and the handler gets them converted (`limit?: number`); values it doesn't name stay text. Without a guard, an anonymous call answers `400` with the service's `ForgeError` message; add a guard only if the API must answer `401`.
7. **Test** `test/<name>.test.ts` with `createTestBackend`: follow [test.md](test.md) for what it must cover.
8. `bun run codegen`, then `bun run typecheck`, `bun test`, and `bunx prettier --write <the files you changed>` (`bun run format` formats the whole project). Projects are 4-space (their `.prettierrc`): match it when you edit by string. `bun test` runs `test/` without type-checking it, and `typecheck` doesn't cover `test/`: keep the test's types right by hand or with your editor.

## 3. Verify

Run the self-checks at the end of [feature-blueprint.md](../feature-blueprint.md) ("Check it before you say it is done"); they must print nothing for your files (a new project's starter `forge/messages.ts` shows in check 2 until it is adopted). Then: `bun run codegen && bun run typecheck && bun test`. In a full-stack app also `npx tsc --noEmit -p forge`.

With REST (or to try a function by hand), run the engine in the background, sign in with a cookie jar, call it, and stop it:

```bash
bun run dev -- --no-docker --port 3411 > /tmp/forge-dev.log 2>&1 &   # --no-docker: SQLite, no service containers; a free port
until curl -sf localhost:3411/ready > /dev/null; do sleep 1; done
B=http://localhost:3411
E="ada-$(date +%s)@example.com"                                                  # a new user each run (the dev database keeps users)
curl -s -c /tmp/jar -X POST $B/api/auth/sign-up/email -H 'content-type: application/json' -H "origin: $B" \
  -d "{\"email\":\"$E\",\"password\":\"correct horse battery\",\"name\":\"Ada\"}"
curl -s -b /tmp/jar "$B/http/<name>?limit=2"                                   # a controller route (under a `prefix`, that path)
curl -s -b /tmp/jar -X POST $B/rpc/<name>:create -H 'content-type: application/json' -H "origin: $B" -d '{...}'  # the bare args; answers {"result": …}
kill %1                                                                         # then check the port is free
```

Check each status and body, the refusals too (no cookie, another user, out-of-range arguments).

## 4. Report

```
Feature <name> (apps/<app> in a monorepo)
  schema.ts          table <name>, indexes by_…
  _modules/<name>/   module, Reader, Writer[, <Name>Sync][, controller]
  <name>.ts          api.<name>.list, .create, … (internal: …)
  test/<name>.test.ts  N tests
Checks: blueprint self-checks clean (except the starter messages.ts) · codegen · typecheck · N tests pass · routes tried: …
  refusal tests checked to fail without their check: …
Not verified: … (anything that needs a browser, Docker or Postgres)
Next: `page <route>` for its UI · old code that does not follow the blueprint: …
```

## 5. Stop and ask when

- the feature would change another feature's table or functions (say which, and why);
- it needs a new package in `forge/package.json`, a Better Auth plugin ([auth.md](auth.md)) or a new stack service;
- the request contradicts a house rule in [SKILL.md](../../SKILL.md) (explain the rule and offer the blueprint way).

## Full documentation

| Page                                                                                                          | Read it for                                                         |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)           | services, modules, controllers, `@Contract`                         |
| [schema](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/schema.mdx)       | tables, validators and their constraints, indexes, search indexes   |
| [functions](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/functions.mdx) | queries, mutations, actions, internal functions                     |
| [queries](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/queries.mdx)     | `.paginate()`, `include`, counts, `where`/`orderBy`                 |
