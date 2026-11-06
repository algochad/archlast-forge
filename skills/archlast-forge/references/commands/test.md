# Command: `test <feature | file>`

Writes the tests a feature needs with `createTestBackend` (the real engine on an in-memory SQLite database: validation, transactions, auth and the scheduler all run), and runs them. Example: `/archlast-forge test invoices`.

## 1. Before you write

1. Read [testing.md](../testing.md) sections 2 to 7 (the test backend, a test file, what to test, auth, scheduled functions, what to mock).
2. Read the feature: `forge/<feature>.ts` (every function and its arguments), its services (every rule, check and `ForgeError`), and existing tests in `test/` (reuse their setup helpers and naming).
3. List the cases before writing any: one line each, from the code's branches, not from guesses.

## 2. What every feature's tests cover

| Case                     | Example                                                                                              |
| ------------------------ | ---------------------------------------------------------------------------------------------------- |
| The main path            | create, then the list or get returns it with the right fields                                        |
| Who may                  | an anonymous caller is refused (`t.query`/`t.mutation` without identity); another user can't read or change the owner's rows; another tenant sees nothing (`withIdentity({ email, session: { activeOrganizationId } })`) |
| Validation               | out-of-bounds arguments are refused by the validator (too long, below `min`, not in the enum)        |
| The errors callers see   | each `ForgeError` the services throw: its message and `data`                                         |
| Lists                    | pagination: `numItems`, `continueCursor`, `isDone` across two pages; the order                        |
| Side effects             | scheduled work runs (`t.finishScheduledFunctions()`), and what it wrote (`t.run(ctx => ctx.db…)`)    |
| Actions with I/O         | the outside call mocked as testing.md §7 shows; the mutation it calls ran                             |
| Internal functions       | called through `internal.<feature>.*`, which clients can't                                           |

## 3. Steps

1. `test/<feature>.test.ts` at the app's root (create `test/` if there is none; `bun test` from the root finds it, no script needed), with `beforeEach` creating the backend from the app's `forge` folder and `afterEach` closing it, as in testing.md §3.
2. A small setup helper for the signed-in users and records the cases share; no shared state between tests.
3. One `test(...)` per case, named for the behavior ("another user can't read an invoice").
4. `bun test test/<feature>.test.ts`, then the whole suite `bun test`.

## 4. Verify

Every case passes, and each "refused" case fails if you remove the check it tests (try one: comment out the owner check, the test must fail; put it back). Projects are 4-space (Prettier): match the indentation when you edit by string. Say which ones you tried. `bun test` doesn't type-check, and `bun run typecheck` doesn't cover `test/`.

## 5. Report

```
Tests: test/<feature>.test.ts — N tests, all pass (bun test: M total pass)
  covers: main path · anonymous refused · other user refused · validation (…) · errors (…) · pagination · scheduled …
  checked to fail without their check: …
Not covered: … (needs a browser / Postgres / a real provider)
```

## 6. Stop and ask when

- a test exposes a bug (report it; fix only if asked: the test should describe the right behavior);
- covering a case needs real credentials or a service that can't be mocked.

## Full documentation

| Page                                                                                                      | Read it for                                                        |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| [testing](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/testing.mdx) | `createTestBackend`, identities, the scheduler, testing a running app |
| [errors](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/errors.mdx)   | what a `ForgeError` carries to the caller                          |
