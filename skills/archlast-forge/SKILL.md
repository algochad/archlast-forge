---
name: archlast-forge
description: Build applications with archlast-forge, a self-hosted reactive TypeScript backend on Bun (live queries, Better Auth, NestJS, Forge RPC). Use whenever you create, change or review code in a project with archlast-forge.json, a forge/ folder with schema.ts, or @archlast/forge-* dependencies, or when asked to create a full-stack app, backend, monorepo or microservices with archlast-forge. Its conventions are mandatory, not suggestions - every feature uses the blueprint (a Nest module, services and controller in forge/_modules/<feature>/, thin function files, registration in _modules/index.ts and http.ts) and the built-in systems (pagination, live queries, auth, uploads, validation, errors, scheduling, webhooks, API docs, security headers, the WAF) and Better Auth's plugins (OAuth provider, organizations) instead of custom code or wrappers. Commands: `/archlast-forge feature|page|service|auth|webhooks|api-docs|review|adopt|test|deploy|upgrade|doctor`, or the same asked in words ("review my code", "deploy this").
---

# archlast-forge

archlast-forge is a Convex-style backend you self-host: you declare a schema and functions in `forge/`, clients call them with end-to-end types, and live queries push new results when the data they read changes. NestJS runs inside the engine for services, controllers, gateways and GraphQL. It runs on Bun with SQLite, Postgres or MongoDB.

## 0. Read this first: how to use this skill

- **These are the project's standards, not options.** When the user says "follow the archlast-forge patterns", they mean section 1 of this file and [feature-blueprint.md](references/feature-blueprint.md). Do not trade them for less code, do not stop at "it works", and do not drop them because a feature is small.
- **Before writing a feature, read [feature-blueprint.md](references/feature-blueprint.md)** and copy its shape. Then read the reference for the task (section 5) for exact APIs.
- **Use what the framework already has.** Before you write a helper, a hook, a wrapper or a mechanism, look it up in section 2. If it is there, call it directly.
- **Existing code:** follow the project's own `_modules/` conventions (naming, shared modules). Do not copy code that breaks the blueprint (the scaffold's starter `forge/messages.ts` is a demo written as plain functions, not the pattern): new features use the blueprint whatever the old ones do. Tell the user when old code does not follow it and offer to move it.
- **The user's explicit instructions win** over this file. When this file does not cover a case, ask, or follow the closest documented pattern; never invent a structure.
- If a reference and the project's code or the library disagree, trust the code and tell the user.

## 0b. Commands

Twelve workflows the user can name. In Claude Code they are `/archlast-forge <command> [arguments]` (the words after the skill's name); in any agent, a request that matches one ("review my forge code", "set up 2FA", "why won't it start") runs it too. **When a request names or matches a command, read its file and follow it step by step**, through its checks to its report. A command orders the work; the house rules below still apply to every line it writes. With no command, or one not listed, show this table and ask which.

| Command                                    | Does                                                                                                | File                                                   |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `feature <name> [what]`                    | a whole feature by the blueprint: table, `_modules/<name>/`, thin functions, registration, a test    | [feature.md](references/commands/feature.md)           |
| `page <route> [what]`                      | a full-stack page: loader, live data, forms and errors, hydration-safe                              | [page.md](references/commands/page.md)                 |
| `service <name> [what it owns]`           | a monorepo microservice with its data, its Forge RPC router and the main app's typed caller          | [service.md](references/commands/service.md)           |
| `auth <plugin>`                            | a Better Auth plugin end to end: 2FA, passkeys, organizations, OAuth provider or client, social     | [auth.md](references/commands/auth.md)                 |
| `webhooks <send\|receive\|both>`           | webhooks on the engine's module: signed, retried, logged out; verified, once-only in                | [webhooks.md](references/commands/webhooks.md)         |
| `api-docs [public]`                        | a documented public REST reference: `http.docs()`, route docs, validator constraints, guides         | [api-docs.md](references/commands/api-docs.md)         |
| `review [path\|changed\|all]`              | an audit against the house rules: findings as file:line with the rule and the fix; changes nothing  | [review.md](references/commands/review.md)             |
| `adopt <file\|feature>`                    | old code moved into the blueprint with the API unchanged, behavior pinned by tests first             | [adopt.md](references/commands/adopt.md)               |
| `test <feature>`                           | `createTestBackend` tests: main path, who may, validation, errors, pagination, side effects         | [test.md](references/commands/test.md)                 |
| `deploy [check]`                           | a production preflight, a backup, the deploy (after a yes) and live checks                           | [deploy.md](references/commands/deploy.md)             |
| `upgrade [version]`                        | `archlast-forge upgrade` with the release notes in between applied, then every check               | [upgrade.md](references/commands/upgrade.md)           |
| `doctor [symptom]`                         | a diagnosis in order (tools, versions, dependencies, codegen, types, the engine), stopping at the cause | [doctor.md](references/commands/doctor.md)         |

## 1. House rules (every one, every time)

1. **Every feature follows the blueprint.** One folder `forge/_modules/<feature>/` with `<feature>.module.ts` and `<feature>.service.ts` (a `Reader` on `ForgeService<QueryCtx>`, a `Writer` on `ForgeService<MutationCtx>`, an `ActionCtx` service for I/O), plus `<feature>.controller.ts` (and `.gateway.ts`, `.resolver.ts`, `.guard.ts`, `.dto.ts`) when needed. The module is listed in `forge/_modules/index.ts`; `forge/http.ts` mounts `nest(http, { imports: appModules })`.
2. **Function files are thin.** `forge/<feature>.ts` declares `query`/`mutation`/`action` (and `internal*`) with `v` validators; each handler is `(await inject(ctx, Service)).method(args)`. Logic, checks and database calls go in the services.
3. **Each kind of file has one place:**

| File                                                          | Goes in                                     | Never in                                                          |
| ------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------------- |
| module, service, controller, gateway, resolver, guard, DTO    | `forge/_modules/<feature>/<feature>.<kind>.ts` | `forge/` top level, `controllers/`, `services/`, `src/`, `lib/`, another feature's folder |
| functions (`api.<feature>.*`)                                 | `forge/<feature>.ts` (folders namespace: `forge/admin/users.ts`) | `_modules/` (codegen skips `_` paths, so they would not exist)    |
| Forge RPC routers                                             | `forge/<service>.router.ts`, top level        | `_modules/` (no `rpc.ts` types would be generated)                |
| providers two features share                                  | `forge/_modules/shared/`                    | a deep import into another feature's folder                        |
| plain helpers with no Nest and no ctx                          | `forge/_lib/`                               | function files                                                    |
| tables, Better Auth, crons, routes                            | `schema.ts`, `auth.ts`, `crons.ts`, `http.ts` | anywhere else                                                     |
| pages (full-stack)                                            | `app/routes/`                               | -                                                                 |

4. **Use the built-in system, never a homemade one** (section 2). Pagination is `.paginate(paginationOpts)` on the server and `usePaginatedQuery`/`useNumberedPage` on the client; live data is `useQuery`; and so on.
5. **No extra layers.** Call the built-ins directly. Do not wrap them in your own hooks (`useTasks`, `usePaginatedTasks`), clients (`apiClient`, `fetchTasks`), base classes (`BaseService`, `Repository`), result envelopes (`{ success, data }`), mappers that copy documents into DTOs, or "utils" that rename a framework call. A wrapper is only right when it adds behavior two places need, and then it lives in `_lib/` or a shared provider.
6. **Writes go through mutations.** A controller, gateway or action gets an `ActionCtx` with no `db`: it calls `ctx.runQuery` / `ctx.runMutation`.
7. **Queries and mutations do no I/O** (no `fetch`, RPC or storage writes) and use nothing untracked: `Date.now()`, `Math.random()` and `process.env` make a cached, reactive query wrong; pass time as a rounded argument. I/O goes in actions, through an `ActionCtx` service.
8. **Services:** `ForgeService<QueryCtx | MutationCtx | ActionCtx>` (always call `super()`), fetched with `inject(ctx, Service)`; ctx-free helpers are singleton `@Injectable()` classes. Import service classes as values, never `import type`. Register every provider in its feature module.
9. **Nest comes only from `@archlast/forge-runtime/nest`** (and `/nest/websockets|graphql|microservices|rpc`). Never install or import `@nestjs/*`, `express` or `rxjs` directly. `nest()` is called once, in `forge/http.ts`.
10. **Frontend code** (`app/` in a full-stack app, `src/` in a separate frontend) imports only from `forge/_generated` and the client packages. It calls functions through `api`, never the app's own controllers.
11. **Auth:** Better Auth through `forge/auth.ts`; check the caller (`ctx.auth.getUserIdentity()`) in every function that is not public, in the service. Clients must not call `internal*` functions.
12. **Errors:** throw `ForgeError` for what a caller should see; everything else becomes "Server error (request id)" outside dev.
13. **After changing functions, schema, routers or `_modules`:** `bun run codegen`, `bun run typecheck`, the tests, `bun run format`. Never edit `_generated`, `_services.ts`, `packages/api`, `packages/contracts` or `.env` secrets; prefer the CLI for structure (`archlast-forge add service|app|mobile|desktop`, `remove`, `workspace sync`).
14. Never commit `.env`; never log or return secrets, the admin key or `FORGE_RPC_TOKEN`. Forge RPC is backend to backend only.

## 1b. What a request means here

| The user says                                                                                     | Do                                                                                                       | Read                                                    |
| ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| "add a feature / an endpoint / a page", "follow the archlast-forge patterns"                       | the blueprint, every file of it                                                                          | [feature-blueprint.md](references/feature-blueprint.md) |
| "we want to be an OAuth provider", "Sign in with <our app>", "let other apps use our API for a user", OIDC | Better Auth's **OAuth Provider plugin** (`@better-auth/oauth-provider` + `jwt`), a consent page, an `OAuthGuard` on the partner API | [auth-plugins.md](references/auth-plugins.md) §2 |
| "multi-tenant SaaS", workspaces, teams, organizations, "invite members", per-customer data          | Better Auth's **organization plugin**, a `TenantContext` service, `organizationId` on every tenant table  | [auth-plugins.md](references/auth-plugins.md) §3         |
| "connect to another forge app that is an OAuth provider", "Sign in with <their app>", "call their API for our users" | Better Auth's **`genericOAuth`** plugin (discovery, PKCE, `resource`), an `ActionCtx` service that uses and refreshes the stored token, a `client_credentials` singleton for calls as the app | [auth-plugins.md](references/auth-plugins.md) §4 |
| any other auth feature (2FA, passkeys, admin roles, bearer tokens, mobile sign-in)                 | the Better Auth plugin for it, from `@archlast/forge-runtime/auth` (its tables are the engine's)                                                          | [auth-plugins.md](references/auth-plugins.md)           |
| "send webhooks", "receive webhooks from Stripe/GitHub", "a webhook engine, inbound and outbound"    | the engine's **`@archlast/forge-runtime/nest/webhooks`** module, on the app's own database                | [webhooks.md](references/webhooks.md)                   |
| "call our other service", microservices                                                            | Forge RPC                                                                                                | [forge-rpc.md](references/forge-rpc.md)                 |
| "NestJS best practices"                                                                            | the forge rules for Nest: modules per feature, guards at the edge, `@Contract`, no `@nestjs/*` installs   | [nest-services.md](references/nest-services.md)         |
| "API docs", "a developer portal", "Swagger / OpenAPI for partners", "document our REST API"         | the engine's API docs: `http.docs({...})` once in `forge/http.ts`, validators with constraints, `@Contract`/route docs fields | [server-features.md](references/server-features.md) "API docs and OpenAPI" |
| "add Helmet / CSP / security headers", "my script, iframe or image is blocked", "allow Stripe.js"   | nothing to install: the engine's presets; change them with `http.helmet()`, inline scripts take `useNonce()` | [server-features.md](references/server-features.md) "Security headers" |
| "a WAF", "block SQL injection / attacks", "OWASP rules"                                            | the built-in firewall: `WAF=on`, `WAF_MODE=detect` first, tuned on the dashboard's Firewall page           | [server-features.md](references/server-features.md) "Web application firewall" |
| "too many clients already", Postgres connections, pool sizes                                       | leave the pool sizes unset (sized from `max_connections`); read the `Postgres connections:` start line   | [operations.md](references/operations.md) "Postgres connections" |

## 1c. New since 0.18.0 (use these; older answers you remember do not know them)

- **Validators check and document more.** `v.string({ minLength, maxLength, pattern, format })`, `v.number({ int, min, max })`, `v.array(x, { minItems, maxItems, unique })`, `v.literal("x")`, `v.enum("a", "b")`, `v.nullable(x)`, and documentation on any validator (`description`, `example`, `name`, ...; `v.describe(validator, meta)`). Put bounds and allowed values in the validator, not in the handler: they are enforced, and they appear in the API docs. [data-and-functions.md](references/data-and-functions.md)
- **The API docs are a public REST reference, configured in code.** `http.docs({ path, production, include, functions, info, securitySchemes, security, errors, parameters, tags, webhooks, page })` once in `forge/http.ts`; per route `summary`, `tags`, `security`, `errors`, `parameters`, `hidden` on `http.route()` or `@Contract()`; `@ApiSecurity(scheme, scopes)` and `@ApiHidden()` on Nest classes. One page with Try it on every operation, guides from `forge/docs/*.mdx`. Off in production unless `production: true` (or `API_DOCS=on`). [server-features.md](references/server-features.md)
- **Security headers are on by default** (Helmet, run by the engine) with a preset each for a Nest app's REST API, a full-stack app's pages (a CSP with a per-request nonce) and the dashboard. Change them with `http.helmet({ api, app, dashboard })` or `nest(http, { helmet })`; an inline `<script>` in a page needs `nonce={useNonce()}`; owners change them live on the dashboard's **Security** page (`HELMET`, `HELMET_CONFIG`), which also lists what the policy blocked (`/_csp` reports). [server-features.md](references/server-features.md), [fullstack.md](references/fullstack.md)
- **An opt-in web application firewall**: `WAF=on` runs every request through the OWASP Core Rule Set (Coraza) and answers `403 FORBIDDEN` to attacks; `WAF_MODE=detect` watches without blocking. The dashboard's **Firewall** page shows what it stopped, tries a request against the rules, and changes its settings live. [server-features.md](references/server-features.md)
- **Postgres pools size themselves** from `max_connections` (60% of what Postgres allows, shared by `REPLICAS` and `RUNTIME_WORKERS`; 4 + 8 in dev), so a many-core server no longer fills a default Postgres. Leave `DATABASE_POOL_SIZE`/`DATABASE_WRITE_POOL_SIZE` unset unless other apps share the database. [operations.md](references/operations.md)

## 2. Built-ins: use them, do not rebuild them

| You need                         | Use                                                                                                    | Do not write                                                                     | Read                                     |
| -------------------------------- | ------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------- | ---------------------------------------- |
| A list that loads more           | server: `args: { paginationOpts: paginationOptsValidator }` + `.paginate(paginationOpts)`; client: `usePaginatedQuery(api.x.list, args, { initialNumItems })` | offset/limit math, your own cursors, `collect()` then `slice`, a `hasMore` flag, load-more state | [data-and-functions.md](references/data-and-functions.md) §7 |
| Numbered pages                   | the same query; `useNumberedPage(api.x.list, args, { page, pageSize })`, `pageArgs()` in a loader       | a count query plus a skip query, page math in a service                          | [fullstack.md](references/fullstack.md)  |
| REST at `/api/v1` (no `/http`)   | `httpRouter({ root: true })` + `nest(http, { prefix: "/api/v1/", imports: appModules })` in `forge/http.ts` | a reverse-proxy rewrite, a second server, routes under `/api/auth` | [nest-services.md](references/nest-services.md) |
| Paging over REST                 | the controller passes `{ numItems, cursor }` to the same query and returns its result                  | `page`/`offset` parameters, a second "REST" query                               | [feature-blueprint.md](references/feature-blueprint.md) |
| Live data on screen              | `useQuery(api.x.y, args)` (or the Vue/Svelte binding)                                                  | polling, `setInterval` refetches, a socket for data sync, manual invalidation    | [clients.md](references/clients.md)      |
| Instant UI on a write            | `useMutation(ref).withOptimisticUpdate(...)`                                                           | copying server data into local state and patching it                             | [clients.md](references/clients.md)      |
| Data on the first render         | a route `loader` calling `ctx.query` with the hook's exact args                                        | `useEffect` fetches, a separate API route for the page                          | [fullstack.md](references/fullstack.md)  |
| Sign-in, sessions, who is calling | Better Auth (`forge/auth.ts`), `ctx.auth.getUserIdentity()`, `useSession`/`useAuth`/`useViewer`      | session tables, JWT code, password hashing                                       | [server-features.md](references/server-features.md) |
| Argument and body validation     | `v` in `args`; `@Contract` on controllers (also writes OpenAPI)                                        | zod/class-validator schemas, hand checks of types, hand-written Swagger           | [data-and-functions.md](references/data-and-functions.md) |
| Lengths, ranges, allowed values  | `v.string({ maxLength })`, `v.number({ int: true, min, max })`, `v.enum("a", "b")`, `v.literal`, `v.nullable` | `if (x.length > 200) throw`, an allowed-values array checked in the service, `v.string()` for an enum | [data-and-functions.md](references/data-and-functions.md) |
| API docs for a REST API          | `http.docs({...})` in `forge/http.ts`; `summary`/`errors`/`security` on routes and `@Contract`; `@ApiSecurity`, `@ApiHidden` | `@nestjs/swagger`, a hand-written `openapi.json`, Swagger UI or Redoc served by hand | [server-features.md](references/server-features.md) |
| Security headers, CSP            | nothing (on by default); `http.helmet({...})`, `nest(http, { helmet })`, `useNonce()` for inline scripts | the `helmet` package, `app.use(helmet())`, a `<meta>` CSP, headers added at the proxy | [server-features.md](references/server-features.md) |
| Blocking attacks (SQLi, XSS)     | `WAF=on` (`WAF_MODE=detect` first), the Firewall page                                                 | regex filters in middleware or guards, another WAF in front "just in case"       | [server-features.md](references/server-features.md) |
| Postgres connection pool sizes   | nothing: sized from `max_connections` at start                                                         | big `DATABASE_POOL_SIZE` values "for performance"                               | [operations.md](references/operations.md) |
| Errors a caller handles          | `throw new ForgeError(...)`                                                                            | `{ ok: false, error }` return values, custom error classes for callers          | [data-and-functions.md](references/data-and-functions.md) |
| Files and uploads                | `ctx.storage.generateUploadUrl()`, `useUploadFile`, `getUrl`                                           | base64 in documents, an upload controller, your own file folder                 | [server-features.md](references/server-features.md) |
| Later or recurring work          | `ctx.scheduler.runAfter/runAt`, `forge/crons.ts`                                                       | `setTimeout`/`setInterval` in server code, a jobs table                          | [server-features.md](references/server-features.md) |
| Text search                      | `.searchIndex(...)` in the schema, `.withSearchIndex(...)`                                             | `filter(d => d.title.includes(q))` over a table                                 | [data-and-functions.md](references/data-and-functions.md) |
| Related documents                | `.include({...})`, `ctx.db.getMany(ids)`                                                               | a loop of `get` calls per row                                                    | [data-and-functions.md](references/data-and-functions.md) |
| Counts and totals                | `.count()`, `.sum()/.avg()/.min()/.max()`, `withTotal`                                                 | `collect().length`, summing in JavaScript                                        | [data-and-functions.md](references/data-and-functions.md) |
| Caching                          | nothing: query results are cached and invalidated by the engine                                       | a cache map, Redis caching of query results                                      | [operations.md](references/operations.md) |
| Ids and timestamps               | `_id` (`v.id("table")`), `_creationTime`                                                               | your own `id` or `createdAt` fields                                              | [data-and-functions.md](references/data-and-functions.md) |
| Calling another forge backend    | Forge RPC (`@Router`, `ForgeRpcClient`) through one service class                                      | `fetch` to its URLs                                                              | [forge-rpc.md](references/forge-rpc.md)  |
| Signing in with / calling another OAuth app | `genericOAuth` + `signIn.social`; the `accounts` row's tokens, refreshed in an `ActionCtx` service | a hand-written OAuth client, tokens sent to the browser           | [auth-plugins.md](references/auth-plugins.md) |
| Client halves of auth plugins    | `export const authPlugins = [...]` in `app/root.tsx`; `useAuth<typeof authPlugins>()`                   | `fetch` calls to `/api/auth/...` written by hand                                  | [fullstack.md](references/fullstack.md)  |
| Being an OAuth / OIDC provider   | `oauthProvider()` + `jwt()` from `@archlast/forge-runtime/auth`; `verifyAccessTokenRequest` in a guard                   | an OAuth server, client/token tables, JWT signing                                | [auth-plugins.md](references/auth-plugins.md) |
| Tenants, members, invitations    | `organization()` from `@archlast/forge-runtime/auth`; one `TenantContext` service                                         | `tenants`/`memberships`/`invitations` tables, an `organizationId` argument       | [auth-plugins.md](references/auth-plugins.md) |
| Webhooks out and in              | `@archlast/forge-runtime/nest/webhooks`: `dispatch()` in the mutation, `@VerifyWebhook`, `inbox.once()` | `@nestjs/webhooks`, a queue, a `fetch` loop, your own signing, retries or dedupe  | [webhooks.md](references/webhooks.md)    |
| Better Auth plugin tables        | the engine's, from `plugins` (codegen types them: `_generated/authTables.ts`)                        | declaring them in `schema.ts`, hand-written or generated                         | [auth-plugins.md](references/auth-plugins.md) |
| Spans and metrics                | `trace`/`metrics`; Nest classes are timed already                                                      | console timing, your own metrics endpoint                                        | [dashboard-and-observability.md](references/dashboard-and-observability.md) |

## 3. Mistakes agents have made here (do not repeat them)

- Writing every feature as plain functions in `forge/<feature>.ts` with the logic inside the handlers, and no Nest classes: use the blueprint.
- Creating Nest classes but putting controllers in `forge/controllers/`, `forge/<feature>.controller.ts` or `src/`: controllers live in `forge/_modules/<feature>/`.
- Building custom pagination (offset/limit arguments, `collect()` then slice, a `hasMore` field) instead of `.paginate()` + `usePaginatedQuery`/`useNumberedPage`.
- After being told to use the built-in pagination, wrapping it: a `usePaginatedTasks` hook that only forwards arguments, a service that reshapes `PaginationResult` into `{ items, nextPage }`, a generic `paginate()` helper. Return `.paginate()`'s result as it is and call the hook directly in the component.
- Copying the starter `messages.ts` style because "the project does it that way".
- Writing to the database from a controller, injecting a `MutationCtx` service into one, or calling `fetch` in a mutation.
- Forgetting to register a provider or module, or calling `nest()` twice.
- Giving `@Contract` a `v.object(...)` for `params` or `query` (they take a record of validators; the route fails with a 500).
- Building an OAuth server or tenant tables by hand instead of Better Auth's OAuth Provider and organization plugins; taking `organizationId` from the client.
- Installing `@nestjs/webhooks` (or a queue) for webhooks, or `fetch`ing webhook URLs from a mutation, instead of the engine's webhooks module.
- Installing `@nestjs/config`, `class-validator` or any `@nestjs/*` package: configuration is `process.env`, validation is `@Contract`.
- Installing `@nestjs/swagger` or serving Swagger UI for API docs, or `helmet` / `app.use(helmet())` for headers: the engine does both (`http.docs()`, `http.helmet()`).
- An inline `<script>` in a page without `nonce={useNonce()}`: the page's CSP blocks it. Loosening the policy with `'unsafe-inline'` instead switches the nonce off for every script.
- Checking lengths, ranges or allowed values in a service instead of the validator (`v.string({ maxLength })`, `v.enum(...)`): it runs after the handler starts, and the API docs cannot show it.
- Turning `WAF=on` in block mode on a live app that did not ask for it, or without `WAF_MODE=detect` first; or answering a WAF false positive by turning the WAF off instead of `WAF_DISABLED_RULES`/`WAF_IGNORE_PATHS`.
- Setting `DATABASE_POOL_SIZE` high on a many-core server: every runtime process of every server opens all of its pool at start, and Postgres refuses the rest ("too many clients").

## 4. The model in six lines

- **Functions** are the API: `query` (read, reactive), `mutation` (write, one transaction), `action` (I/O; at-most-once, no retries), plus `internalQuery`/`internalMutation`/`internalAction` that clients can never call. Arguments are validated with `v`.
- **Reactivity:** a query's reads become topics; a committed mutation publishes topics; subscribed queries re-run. Reads go through `ctx.db` in queries (through a `Reader` service), writes through mutations only.
- **Codegen** (`archlast-forge codegen`, run by `dev`, `typecheck`, `build`) writes `forge/_generated` (`api`, `internal`, `dataModel`, and `rpc` for Forge RPC routers). Commit it. Never edit it. Any `forge/` path segment starting with `_` is skipped by the function scanner, codegen and the client router, which is why Nest code lives in `_modules/`.
- **Mutations are serializable transactions** on every database ([data-and-functions.md](references/data-and-functions.md)): check-then-insert in one mutation is safe.
- **Errors:** only `ForgeError` and argument-validation errors reach callers.
- **Storage:** documents are JSON with `_id` and `_creationTime`; schema changes need no table migration (data changes use `archlast-forge migrate`). `users` and Better Auth tables are built in.

Orienting in a project: the mode is in `archlast-forge.json` (`"framework"` = full-stack with `app/`, `"backend"`, none = a backend with no services); `archlast-forge.workspace.json` at a root with `apps/` and `packages/` is a monorepo. Read `forge/schema.ts`, `forge/http.ts`, `forge/_modules/`, `archlast-forge.json`'s `services` and `.env.example` before writing. Use the project's scripts (`bun run dev`, `codegen`, `typecheck`, `format`); Bun only. Starting from nothing: `bun create archlast-forge my-app` (full-stack), `--mode backend`, `--monorepo`, `--microservices orders,billing`, `--yes`; see [project modes](references/project-modes.md).

## 5. Task routing: read before you write

| Task                                                                                                                                                   | Read                                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| **Any feature, endpoint, page or service** (always first)                                                                                              | [feature-blueprint.md](references/feature-blueprint.md)                     |
| Create a project; choose full-stack vs backend vs monorepo vs microservices; add/remove an app or service; workspace files                             | [project-modes.md](references/project-modes.md)                             |
| Which files `init` writes and what each is for (`compose.yaml`, `Dockerfile`, `.env`, stack services, shadcn, mobile, desktop); adding a stack service | [scaffolding.md](references/scaffolding.md)                                 |
| Any `archlast-forge` command: flags, defaults, what it writes, data commands (migrate, export, import, backup, restore, env, admin), upgrade           | [cli.md](references/cli.md)                                                 |
| Service classes, Nest modules, controllers, guards, gateways, GraphQL, folder layout of `forge/`                                                       | [nest-services.md](references/nest-services.md)                             |
| One backend calling another; microservice mesh; `@Router`; `packages/contracts`                                                                        | [forge-rpc.md](references/forge-rpc.md)                                     |
| Tables, validators, indexes, queries, mutations, actions, pagination, errors, migrations                                                               | [data-and-functions.md](references/data-and-functions.md)                   |
| Better Auth plugins: OAuth / OIDC provider, organizations and multi-tenancy, 2FA, passkeys, admin, generating plugin tables                         | [auth-plugins.md](references/auth-plugins.md)                               |
| Webhooks: sending, receiving, both; endpoints per tenant; delivery log                                                                                  | [webhooks.md](references/webhooks.md)                                       |
| Sign-in, roles, files and uploads, scheduler and crons, HTTP routes, API docs (`http.docs`), security headers (`http.helmet`, `useNonce`), the WAF, limits | [server-features.md](references/server-features.md)                         |
| Pages, routes, loaders, live data in components, hydration, styling (full-stack app)                                                                   | [fullstack.md](references/fullstack.md)                                     |
| Calling the backend from a separate frontend, React/Vue/Svelte bindings, mobile, desktop                                                               | [clients.md](references/clients.md)                                         |
| Writing tests for functions and services                                                                                                               | [testing.md](references/testing.md)                                         |
| Environment variables and settings, Docker, deployment, Postgres connections, scaling, backups, upgrades, troubleshooting                              | [operations.md](references/operations.md)                                   |
| The admin dashboard (Firewall and Security pages too), accounts and roles, traces, issues, SLOs, alerts, custom spans and metrics, debugging            | [dashboard-and-observability.md](references/dashboard-and-observability.md) |

For anything not covered, the documentation site is the full reference: its `/llms.txt` lists every page and `/<page>.md` is each page as Markdown (the pages are also in `apps/docs/content` of the archlast-forge repository).

## Going deeper: the documentation

The references are the short version. The documentation is the full one, and each reference ends with a **Full documentation** table of the pages for its subject. Read the page instead of guessing when an option, flag or signature is not in the reference, when behavior surprises you, or when you need the cause of an error message.

Where to read a page (`<page>` is its name, such as `nest`):

1. **The docs site**, when the user or the project gives its address: `<site>/<page>.md` is the page as Markdown. `<site>/llms.txt` indexes every page with a line about each and a start-here list by task; `<site>/llms-full.txt` is everything, `<site>/llms-<section>.txt` one section; asking a page's own address with `Accept: text/markdown` also returns Markdown. Each Markdown page links to the previous and next page, so you can walk from one to the next.
2. **The repository**, always: `https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/<page>.mdx` (or `apps/docs/content/<page>.mdx` in a checkout of archlast-forge).

Page names: introduction, concepts, getting-started, tutorial, framework, backend, monorepo, schema, functions, transactions, queries, reactivity, caching, errors, migrations, auth, storage, scheduling, http, webhooks, nest, forge-rpc, api-docs, security-headers, clients, mobile, desktop, testing, recipes, agent-skill, cli, deployment, configuration, dashboard, backups, observability, limits, convex, reference, troubleshooting, release-notes.

For an exact signature read `reference`; for a message or symptom read `troubleshooting`; for the engine's variables read `configuration`; for a command read `cli`.

## 6. Workflows

**New feature in any app:** follow [feature-blueprint.md](references/feature-blueprint.md) step by step: table and indexes, `_modules/<feature>/` (service, module, controller when it has an HTTP surface), `_modules/index.ts`, `forge/http.ts`, the thin `forge/<feature>.ts`, codegen, the page or client using the built-in hooks directly, a `createTestBackend` test, format, then its self-checks.

**New microservice in a monorepo:** `archlast-forge add service billing` (it writes the service app, the main app's `billing.service.ts`, controller and action, the contracts and the token). Then in `apps/billing/forge/`: tables, internal functions that own the data, procedures in `billing.router.ts` with `input`/`output` schemas, `ctx.runMutation(internal.…)` inside them. Codegen in both apps, `bun run typecheck` at the root. Add domain methods to the main app's `BillingService`. See [forge-rpc.md](references/forge-rpc.md).

**Turn an app into a monorepo:** `archlast-forge monorepo --microservices orders --yes` (in place; `--dry-run` first).

**Add a service-to-service call (mesh):** hand-wire a client class in the calling service as described in [forge-rpc.md](references/forge-rpc.md); keep the call graph acyclic and each service's data private.

## CLI cheat sheet (full reference: [cli.md](references/cli.md))

| Goal                          | Command                                                                                                                                                         |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| New project (non-interactive) | `bun create archlast-forge <dir> [--mode framework\|backend] [--services …\|none] [--monorepo] [--microservices a,b] [--mobile] [--desktop full\|client] --yes` |
| Run in development            | `bun run dev` (`archlast-forge dev`; add `-- --no-docker` to run the engine in-process)                                                                         |
| Regenerate types              | `bun run codegen` (also run by `dev`, `typecheck`, `build`)                                                                                                     |
| Production stack              | `bun run up` / `down` / `logs` (Docker Compose)                                                                                                                 |
| Production without Docker     | `archlast-forge build --no-docker` then `start --no-docker`                                                                                                     |
| Add / remove stack services   | `archlast-forge stack add\|remove postgres,redis,s3,caddy`                                                                                                      |
| Monorepo changes              | `archlast-forge monorepo`, `add service\|app\|mobile\|desktop`, `remove <name>`, `workspace [sync]`                                                             |
| Data                          | `migrate`, `export`, `import`, `backup`, `restore`, `env`, `admin` (run inside the running server through `/_cli`, or open the database when no server runs)    |
| Move to a new release         | `archlast-forge upgrade [version]`                                                                                                                              |

Ask the user before destructive commands: `remove`, `restore`, `import` over existing data, `down --volumes`, `migrate --run`, `env set`, and anything that publishes or deploys.

## 7. Before you say it is done

- [ ] Every feature you touched has `forge/_modules/<feature>/` with its module and services (and controller when it has an HTTP surface), registered in `_modules/index.ts`, mounted by `forge/http.ts`. Nothing Nest outside `_modules/`.
- [ ] Function handlers are `inject` + one call; logic, auth checks and database access are in services.
- [ ] Lists use `.paginate(paginationOpts)` and `usePaginatedQuery`/`useNumberedPage` directly; no custom pagination, no wrapper hooks, helpers or reshaped results.
- [ ] No homemade version of anything in section 2.
- [ ] The self-checks at the end of [feature-blueprint.md](references/feature-blueprint.md) print nothing.
- [ ] `bun run codegen` and `bun run typecheck` pass (at the root for a monorepo); tests for new functions and services pass.
- [ ] No server-only import in `app/` or `src/`; no `_generated`, `_services.ts` or `.env` edits.
- [ ] Public functions check auth where they must; `internal*` for what clients must not call.
- [ ] Bounds and allowed values are in the validators (`maxLength`, `min`/`max`, `v.enum`); public REST routes have a `summary` (and `errors`, `security` when the app has API docs).
- [ ] Every inline `<script>` in a page has `nonce={useNonce()}`; third-party sources are in `http.helmet()`, not in a `<meta>` tag or the proxy.
- [ ] Anything new that is configurable is in `.env.example` and, for deployment, in `compose.yaml`.
- [ ] You told the user what you could not verify (behavior that needs Docker, Postgres or a browser) and which existing code does not follow the blueprint.
