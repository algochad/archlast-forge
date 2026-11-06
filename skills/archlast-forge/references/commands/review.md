# Command: `review [path | changed | all]`

Audits code against the house rules in [SKILL.md](../../SKILL.md) and reports each problem with its file, line, the rule it breaks and the fix. It changes nothing unless asked. Examples: `/archlast-forge review` (what changed on this branch), `/archlast-forge review forge/_modules/invoices`, `/archlast-forge review all`.

## 1. Scope

- No argument or `changed`: the files changed on this branch, committed or not, new ones included, without generated files:

  ```bash
  base=$(git merge-base HEAD origin/HEAD 2>/dev/null || git merge-base HEAD origin/main 2>/dev/null || git merge-base HEAD origin/master 2>/dev/null)
  { [ -n "$base" ] && git diff --name-only "$base"...HEAD; git status --short -uall | cut -c4-; } | sort -u | grep -vE "(^|/)(_generated|node_modules)/"
  ```

  Nothing printed (a fresh repository, a clean default branch): review `all`, and say so. In a monorepo, every app those files are in.
- A path: that folder or file. `all`: the app's `forge/`, `app/` (full-stack) or `src/` (separate frontend), and `test/`.
- Read [feature-blueprint.md](../feature-blueprint.md) and SKILL.md sections 1 to 3 before judging: they are the rules.

## 2. The checks

Run the mechanical ones first (each prints only problems; run them from the app's root), then read the code for the rest.

```bash
# Blueprint: Nest classes outside _modules, and function files (any depth, not under _ folders) that don't inject a service
find forge -path forge/node_modules -prune -o -path forge/_modules -prune -o \( -name "*.module.ts" -o -name "*.service.ts" -o -name "*.controller.ts" -o -name "*.gateway.ts" -o -name "*.resolver.ts" \) -print
find forge -path forge/node_modules -prune -o -name "*.ts" -not -path "*/_*" -print | grep -vE "^forge/(schema|auth|crons|http|webhooks)\.ts$|\.router\.ts$" | xargs -r grep -L "inject("
# Nest, Express or rxjs imported directly, or a second nest() call
grep -rnE "from \"(@nestjs/|express|rxjs)" forge app src --include=*.ts --include=*.tsx --exclude-dir=node_modules --exclude-dir=_generated 2>/dev/null
grep -rn "^nest(" forge --include=*.ts | sed -n '2,$p'
# Hand-made pagination, and whole-table reads
grep -rnE "\.skip\(|\.slice\(|offset|\.collect\(\)\.(length|filter|slice)" forge/_modules --include=*.ts
# Untracked values and I/O in reads and writes (Reader / Writer services, queries, mutations)
grep -rnE "Date\.now\(|Math\.random\(|new Date\(\)|process\.env|fetch\(" forge/_modules --include=*.service.ts
# Frontend importing server code
grep -rnP 'from "[^"]*\bforge/(?!_generated)' app src --include=*.ts --include=*.tsx --exclude-dir=node_modules 2>/dev/null
# Secrets
git ls-files | grep -E "(^|/)\.env$"
```

For a `Date.now()` or `fetch(` hit, check which class it is in: it is allowed in an `ActionCtx` service, wrong in a `QueryCtx`/`MutationCtx` one.

Then read each file in scope for what grep can't see:

| Rule                                                                                       | Look for                                                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| Functions are thin (rule 2)                                                                | `if`s, `ctx.db`, loops or rules in `forge/<feature>.ts` handlers                                 |
| Auth (rule 11)                                                                             | a public function whose service never calls `getUserIdentity()` (or the tenant check) and returns or changes someone's data; a row read by id without checking its owner; an `organizationId` or `userId` taken from the arguments |
| Internal stays internal                                                                    | helpers clients should not call declared as `query`/`mutation` instead of `internal*`             |
| Writes go through mutations (rule 6)                                                       | a controller, gateway or action with a `MutationCtx` service or `ctx.db`                          |
| Validators carry the rules                                                                 | length, range or allowed-value checks in services; `v.string()` for an enum; unbounded strings stored from users |
| Indexes                                                                                    | `.filter(...)` or `where` on a field with no index (dev logs "scan" warnings for `where`/`orderBy`) |
| Registration (rule 8)                                                                      | an `@Injectable()` or controller not listed in its module; a module not in `_modules/index.ts`; `import type` of a service class |
| No extra layers (rule 5)                                                                   | hooks that only forward to `useQuery`/`usePaginatedQuery`, API client wrappers, base repositories, `{ ok, data }` envelopes, DTO mappers that copy documents |
| Errors (rule 12)                                                                           | `throw new Error(...)` for something a caller should see (use `ForgeError`), errors swallowed     |
| Built-ins (section 2)                                                                      | homemade uploads, crons with `setInterval`, a cache map, `fetch` to another forge app (Forge RPC), `helmet`, Swagger |
| `@Contract`                                                                                | `params`/`query` given a `v.object(...)` (they take a record of validators); a handler that uses a `query`/`params` value as a number without converting it (it arrives as text) |
| Route docs                                                                                 | a controller route or `http.route()` with no `summary`; with no `errors`/`security` when the app has `http.docs()` |
| Pages                                                                                      | `Date.now()`/`new Date()`/`Math.random()` in render, `useEffect` data fetches, an inline `<script>` without `nonce={useNonce()}` |
| Tests                                                                                      | new functions or services with no test; tests that only check the happy path                      |

## 3. Report

Severity: **high** (security or data: auth, tenant leaks, secrets, writes outside mutations), **medium** (breaks a house rule: blueprint, built-ins, I/O in reads), **low** (style the rules name: missing `summary`, unbounded validator, missing test).

```
Review: <scope> (N files read, generated ones left out)
| # | Severity | File:line | Rule | Problem | Fix |
|---|----------|-----------|------|---------|-----|
| 1 | high | forge/_modules/invoices/invoices.service.ts:42 | auth (rule 11) | get(id) returns any invoice | check invoice.ownerId === me() before returning |
...
Clean: blueprint self-checks · no @nestjs imports · …
```

End with the counts by severity, the files that need [adopt.md](adopt.md) (old code outside the blueprint), and one question: fix them now? (If the user said not to ask, end with the fixes you recommend, in order.) Fix only what the user picks; then run `bun run codegen && bun run typecheck && bun test` and re-run the checks.

## 4. Do not

- report style the rules don't name, or matters of taste;
- report the CLI's own files as blueprint problems (a monorepo main app's `<service>.service.ts`, `.controller.ts`, `<service>.ts`, `_services.ts`; the starter `messages.ts` is reported once, as "old code", with `adopt`);
- change code during the review.

## Full documentation

| Page                                                                                                          | Read it for                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)           | what may go in services, controllers and guards                 |
| [functions](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/functions.mdx) | what queries, mutations and actions may do                      |
| [auth](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/auth.mdx)           | checking the caller                                             |
| [caching](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/caching.mdx)     | why untracked values in queries give wrong cached results       |
