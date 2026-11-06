# Command: `adopt <file | feature>`

Moves existing code that does not follow the blueprint (logic in function handlers, Nest classes outside `_modules/`, the starter `forge/messages.ts`) into it, **without changing the API**: every `api.<feature>.*` keeps its name, arguments and result, so clients and pages keep working. Example: `/archlast-forge adopt forge/messages.ts`.

## 1. Before you change anything

1. Read [feature-blueprint.md](../feature-blueprint.md); the target is its section 1.
2. Read the file and everything that uses it: `grep -rn "api.<feature>\.\|internal.<feature>\." forge app src test` (and other apps in a monorepo through `packages/api`). Write down each function: kind, arguments, result shape, errors, who calls it.
3. The tree must be clean (`git status`), or the user agrees to mix this with their changes.

## 2. Steps

1. **Pin the behavior first.** If the feature has no tests, write them now against the old code ([test.md](test.md)): each function's result, its errors (`ForgeError` messages and data), its auth refusals, pagination. Run them: they pass on the old code.
2. **Services**: move the logic into `forge/_modules/<feature>/<feature>.service.ts` (reads into the `Reader`, writes into the `Writer`, I/O into an `ActionCtx` service). Same checks, same error messages, same result shapes: a refactor, not a redesign.
3. **Module** with the providers, added to `_modules/index.ts`; `forge/http.ts` mounts `appModules` (add the `nest()` call if this is the first feature).
4. **Function file**: the same exports, `args` validators unchanged, each handler `(await inject(ctx, Service)).method(args)`.
5. **Classes outside `_modules/`** (a `forge/controllers/x.ts`, a `src/services/x.ts` on the server): move them into the feature's folder, rename to `<feature>.<kind>.ts`, fix the imports, register them. Delete the old files.
6. `bun run codegen`: `forge/_generated/api.d.ts` must not change for this feature (same functions, same argument types). `git diff forge/_generated` shows it.
7. `bun run typecheck && bun test && bun run format`.

## 3. Verify

- The tests from step 1 pass unchanged (do not edit them to pass).
- No change to the feature's entries in `forge/_generated` (`git diff --stat forge/_generated`).
- The blueprint self-checks in [feature-blueprint.md](../feature-blueprint.md) print nothing for this feature.

## 4. Report

```
Adopted <feature>: forge/<feature>.ts → _modules/<feature>/ (Reader, Writer[, …])
  API unchanged: api.<feature>.a, .b, … (generated types identical)
  moved: forge/controllers/x.ts → _modules/<feature>/<feature>.controller.ts …
Checks: N tests (written before, unchanged) pass · typecheck · self-checks clean
Behavior kept as it was, though it breaks a rule: … (offer to fix separately)
```

## 5. Stop and ask when

- keeping the API exactly would mean copying a bug or a security hole (report it; fix it as a separate, agreed change);
- the code is shared by several features (where its provider goes: `_modules/shared/`, only if two features need it);
- the move would touch the CLI's own files (`_services.ts`, a monorepo main app's `<service>.*`): leave those.

## Full documentation

| Page                                                                                                      | Read it for                                       |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------- |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)       | services, modules, `inject`, `ForgeService`       |
| [testing](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/testing.mdx) | pinning behavior with `createTestBackend`         |
