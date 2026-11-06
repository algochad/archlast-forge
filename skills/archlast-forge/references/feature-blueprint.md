# The feature blueprint (required for every feature)

Read this before you write any feature, endpoint, page or service. It is the archlast-forge way of building a feature, and "follow the archlast-forge patterns" means exactly this. Every file below was run end to end in a fresh full-stack scaffold: codegen, `tsc`, the test, every REST route, the OpenAPI document and the server-rendered page.

Do not shorten it because the feature is small. A one-table feature still gets its `_modules/<feature>/` folder with a module and services. The cost is a few files; the payoff is that every feature in the project looks the same.

## 1. What a feature is made of

```
forge/
  schema.ts                       the table and the indexes its queries use
  tasks.ts                        api.tasks.*: validators + inject a service + one call. No logic
  _modules/
    index.ts                      export const appModules = [TasksModule, …]
    tasks/
      tasks.module.ts             @Module: the feature's providers and controllers
      tasks.service.ts            TasksReader (QueryCtx), TasksWriter (MutationCtx), and an ActionCtx service if it does I/O
      tasks.controller.ts         REST surface, when the feature has one (see 4)
      tasks.gateway.ts, tasks.resolver.ts, tasks.guard.ts, tasks.dto.ts   only when needed, always here
  http.ts                         nest(http, { imports: appModules }): the only nest() call
app/routes/tasks.tsx              full-stack app: the page, using the built-in hooks directly
test/tasks.test.ts                createTestBackend
```

Fixed rules for that tree:

- **Everything Nest lives in `forge/_modules/<feature>/`**: module, services, controller, gateway, resolver, guard, DTO. Never in `forge/` itself, never in a `controllers/`, `services/` or `src/` folder, never in another feature's folder. The file names are `<feature>.<kind>.ts`.
- **`forge/<feature>.ts` holds the functions** (`query`, `mutation`, `action` and their `internal*` versions). It is the API: `api.tasks.list`. Each handler validates with `v`, calls `inject(ctx, Service)` and returns one method call. No queries, no `if`s, no business rules in it.
- **Services hold the logic.** Reads in a `Reader` that extends `ForgeService<QueryCtx>` (usable from queries, so reactive), writes in a `Writer` that extends `ForgeService<MutationCtx>`, I/O (`fetch`, storage, other backends) in a service that extends `ForgeService<ActionCtx>` called from an action. Ctx-free helpers are plain `@Injectable()` singletons.
- **The controller calls functions**, never the database: `ctx.runQuery(api.tasks.list, …)`, `ctx.runMutation(api.tasks.create, …)`. That keeps every write one transaction and every live query current.
- **Register it all:** providers and controllers in the feature's module, the module in `_modules/index.ts`, `appModules` in `forge/http.ts`.

## 2. Step by step

**1. The table** in `forge/schema.ts`, with an index for every way the feature reads:

```ts
tasks: defineTable({ ownerId: v.id("users"), title: v.string(), done: v.boolean() }).index("by_owner", ["ownerId"]),
```

**2. The services**, `forge/_modules/tasks/tasks.service.ts`. Ownership and validation live here, once:

```ts
import { ForgeError, type PaginationOptions } from "@archlast/forge-runtime";
import {
  ForgeService,
  Injectable,
  type MutationCtx,
  type QueryCtx,
} from "@archlast/forge-runtime/nest";
import type { Id } from "../../_generated/dataModel";

/** Reads: usable from queries (so reactive) and from mutations. */
@Injectable()
export class TasksReader extends ForgeService<QueryCtx> {
  /** The signed-in caller's id; every task belongs to one. */
  async me() {
    const identity = await this.ctx.auth.getUserIdentity();
    if (!identity) throw new ForgeError("Sign in first");
    return identity.userId;
  }

  async list(paginationOpts: PaginationOptions) {
    const me = await this.me();
    return this.ctx.db
      .query("tasks")
      .withIndex("by_owner", (q) => q.eq("ownerId", me))
      .order("desc")
      .paginate(paginationOpts);
  }

  async get(id: Id<"tasks">) {
    const task = await this.ctx.db.get(id);
    if (!task || task.ownerId !== (await this.me())) throw new ForgeError("No such task");
    return task;
  }
}

/** Writes: mutations only. */
@Injectable()
export class TasksWriter extends ForgeService<MutationCtx> {
  constructor(private readonly tasks: TasksReader) {
    super();
  }

  async create(title: string) {
    const clean = title.trim(); // the length is the validator's (v.string({ maxLength })); what it can't say is checked here
    if (!clean) throw new ForgeError("A title can't be blank");
    return this.ctx.db.insert("tasks", {
      ownerId: await this.tasks.me(),
      title: clean,
      done: false,
    });
  }

  async setDone(id: Id<"tasks">, done: boolean) {
    await this.tasks.get(id); // throws unless the caller owns it
    await this.ctx.db.patch(id, { done });
  }

  async remove(id: Id<"tasks">) {
    await this.tasks.get(id);
    await this.ctx.db.delete(id);
  }
}
```

**3. The functions**, `forge/tasks.ts`. Paginated reads take `paginationOpts: paginationOptsValidator` and return `.paginate()`'s result unchanged: that is what the client hooks and REST callers page through.

```ts
import { mutation, paginationOptsValidator, query, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { TasksReader, TasksWriter } from "./_modules/tasks/tasks.service";

// api.tasks.*: validate the arguments, inject the service, call one method. No logic here.

export const list = query({
  args: { paginationOpts: paginationOptsValidator },
  handler: async (ctx, { paginationOpts }) => (await inject(ctx, TasksReader)).list(paginationOpts),
});

export const get = query({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => (await inject(ctx, TasksReader)).get(id),
});

export const create = mutation({
  args: { title: v.string({ minLength: 1, maxLength: 200, description: "What to do", example: "Buy milk" }) },
  handler: async (ctx, { title }) => (await inject(ctx, TasksWriter)).create(title),
});

export const setDone = mutation({
  args: { id: v.id("tasks"), done: v.boolean() },
  handler: async (ctx, { id, done }) => (await inject(ctx, TasksWriter)).setDone(id, done),
});

export const remove = mutation({
  args: { id: v.id("tasks") },
  handler: async (ctx, { id }) => (await inject(ctx, TasksWriter)).remove(id),
});
```

**4. The controller**, `forge/_modules/tasks/tasks.controller.ts`, when the feature has an HTTP surface: REST for mobile apps, partners, webhooks or anything that does not use the typed client, or because the user asked for one. In a backend-mode project, ask the user once whether its clients want REST if they did not say. The app's own pages never call it; they use the functions.

```ts
import { v } from "@archlast/forge-runtime";
import {
  Body,
  Contract,
  Controller,
  Ctx,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  type ActionCtx,
} from "@archlast/forge-runtime/nest";
import { api } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";

/** REST for clients that do not use the typed client. Answers at /http/tasks. Every handler calls one function. */
@Controller("tasks")
export class TasksController {
  @Get()
  @Contract({
    query: { cursor: v.optional(v.string()), limit: v.optional(v.number({ int: true, min: 1, max: 100 })) }, // a record of validators
    summary: "My tasks, newest first, a page at a time",
  })
  list(@Ctx() ctx: ActionCtx, @Query() q: { cursor?: string; limit?: number }) {
    // The same paginated query the app uses: pass `continueCursor` back as `cursor` for the next page.
    // @Contract converted `limit` to a number when it checked it, and the handler gets it that way.
    return ctx.runQuery(api.tasks.list, {
      paginationOpts: { numItems: q.limit ?? 20, cursor: q.cursor ?? null },
    });
  }

  @Post()
  @Contract({
    body: v.object({ title: v.string({ minLength: 1, maxLength: 200 }) }),
    returns: v.object({ id: v.id("tasks") }),
    summary: "Add a task",
  })
  async create(@Ctx() ctx: ActionCtx, @Body() body: { title: string }) {
    return { id: await ctx.runMutation(api.tasks.create, { title: body.title }) };
  }

  @Patch(":id")
  @Contract({
    params: { id: v.id("tasks") },
    body: v.object({ done: v.boolean() }),
    summary: "Mark a task done or not",
  })
  setDone(@Ctx() ctx: ActionCtx, @Param("id") id: Id<"tasks">, @Body() body: { done: boolean }) {
    return ctx.runMutation(api.tasks.setDone, { id, done: body.done });
  }

  @Delete(":id")
  @Contract({ params: { id: v.id("tasks") }, summary: "Delete a task" })
  remove(@Ctx() ctx: ActionCtx, @Param("id") id: Id<"tasks">) {
    return ctx.runMutation(api.tasks.remove, { id });
  }
}
```

Bounds and allowed values go in the validators (`maxLength`, `int`/`min`/`max`, `v.enum("low", "high")`): they are enforced before the handler runs and appear in the API docs, so a service checks only what a validator can't say (a blank title after trimming, ownership). `@Contract` shapes, which TypeScript does not catch: **`params` and `query` are a record of validators** (`{ id: v.id("tasks") }`); **`body` and `returns` are one validator** (`v.object({ … })`). A `v.object` given to `params` or `query` makes every request to that route fail with a 500. Paginate over REST by passing the query's `continueCursor` back as `cursor`; do not invent `page`/`offset` parameters.

**5. The module, the barrel and the mount:**

```ts
import { Module } from "@archlast/forge-runtime/nest";
import { TasksController } from "./tasks.controller";
import { TasksReader, TasksWriter } from "./tasks.service";

@Module({
  controllers: [TasksController],
  providers: [TasksReader, TasksWriter],
})
export class TasksModule {}
```

```ts
import { TasksModule } from "./tasks/tasks.module";

/** Every feature module. forge/http.ts mounts them. */
export const appModules = [TasksModule];
```

```ts
import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { appModules } from "./_modules";

const http = httpRouter();
nest(http, { imports: appModules }); // the only nest() call in the app
export default http;
```

A full-stack scaffold has no `forge/http.ts`: create this one. A backend scaffold has one with a demo route: keep its routes and add the `nest()` line. A monorepo main app already mounts `serviceControllers`/`serviceProviders` from `_services.ts`: add `imports: appModules` to that same call.

**6. Codegen and types:** `bun run codegen`, then `bun run typecheck`.

**7. The page** (full-stack app), `app/routes/tasks.tsx`: the built-in hook, called directly, and a loader that seeds it with the same arguments so the page renders on the server:

```tsx
import { redirect, type LoaderArgs } from "@archlast/forge-framework";
import { useMutation, usePaginatedQuery } from "@archlast/forge-react";
import { api } from "../../forge/_generated/api";

const PAGE = 20;

export const loader = async ({ ctx }: LoaderArgs) => {
  if (!(await ctx.viewer())) throw redirect("/sign-in");
  await ctx.query(api.tasks.list, { paginationOpts: { numItems: PAGE, cursor: null } }); // same args as the hook below
  return null;
};

export default function Tasks() {
  const { results, status, loadMore } = usePaginatedQuery(
    api.tasks.list,
    {},
    { initialNumItems: PAGE },
  );
  const setDone = useMutation(api.tasks.setDone);
  return (
    <main>
      <ul>
        {results.map((t) => (
          <li key={t._id}>
            <label>
              <input
                type="checkbox"
                checked={t.done}
                onChange={(e) => setDone({ id: t._id, done: e.target.checked })}
              />
              {t.title}
            </label>
          </li>
        ))}
      </ul>
      {status === "CanLoadMore" && <button onClick={() => loadMore(PAGE)}>More</button>}
    </main>
  );
}
```

For numbered pages ("page 3 of 10") use `useNumberedPage(api.tasks.list, {}, { page, pageSize })` and seed with `pageArgs({}, page, pageSize)`; the same query serves both hooks. A separate frontend (Vite, Expo) uses the same hooks from `@archlast/forge-react` ([clients.md](clients.md)).

**8. The test**, `test/tasks.test.ts`:

```ts
import { afterEach, beforeEach, expect, test } from "bun:test";
import { createTestBackend, type TestBackend } from "@archlast/forge-runtime/testing";
import { api } from "../forge/_generated/api";

let t: TestBackend;
beforeEach(async () => {
  t = await createTestBackend("forge");
});
afterEach(() => t.close());

test("tasks page through the built-in pagination, newest first, and stay private", async () => {
  const ada = await t.withIdentity({ email: "ada@example.com" });
  for (let i = 0; i < 25; i++) await ada.mutation(api.tasks.create, { title: `task ${i}` });

  const first = await ada.query(api.tasks.list, { paginationOpts: { numItems: 20, cursor: null } });
  expect(first.page).toHaveLength(20);
  expect(first.page[0]!.title).toBe("task 24");
  expect(first.isDone).toBe(false);
  const second = await ada.query(api.tasks.list, {
    paginationOpts: { numItems: 20, cursor: first.continueCursor },
  });
  expect(second.page).toHaveLength(5);
  expect(second.isDone).toBe(true);

  const bob = await t.withIdentity({ email: "bob@example.com" });
  expect(
    (await bob.query(api.tasks.list, { paginationOpts: { numItems: 20, cursor: null } })).page,
  ).toEqual([]);
  await expect(bob.mutation(api.tasks.remove, { id: first.page[0]!._id })).rejects.toThrow(
    "No such task",
  );
  await expect(t.mutation(api.tasks.create, { title: "anonymous" })).rejects.toThrow(
    "Sign in first",
  );
});
```

**9. Format:** `bun run format`.

## 3. Variations (the blueprint still holds)

- **No HTTP surface:** leave out the controller, keep the module (with its providers) and the services.
- **The feature calls something outside** (an API, a payment provider, another backend): a `TasksSync extends ForgeService<ActionCtx>` in the same `tasks.service.ts` (or `tasks.sync.service.ts` in the folder), an `action` in `forge/tasks.ts` that injects it, and the writes it needs as mutations it calls with `ctx.runMutation`. Never `fetch` from a query or mutation.
- **Clients must not call it:** `internalQuery`/`internalMutation`/`internalAction` in the same `forge/tasks.ts`, called with `internal.tasks.*`.
- **Work later or on a schedule:** `ctx.scheduler.runAfter(ms, internal.tasks.x, args)` from a mutation, or a job in `forge/crons.ts` ([server-features.md](server-features.md)).
- **Sockets or GraphQL:** `tasks.gateway.ts` / `tasks.resolver.ts` in the same folder, listed in the module's `providers` ([nest-services.md](nest-services.md)).
- **Tenant data (multi-tenant SaaS):** inject `TenantContext` (from `_modules/tenancy/`, on Better Auth's organization plugin) into the Reader and Writer, give the table an `organizationId` with an index, and filter every read by it ([auth-plugins.md](auth-plugins.md) §3).
- **The feature sends or receives webhooks:** `webhooks.dispatch()` in the Writer, in the same mutation as the change; a `<feature>.webhook.controller.ts` with `@VerifyWebhook()` in the folder of the feature the webhook changes ([webhooks.md](webhooks.md)).
- **Other apps call it with OAuth access tokens:** a controller behind `@RequireScopes(...)` calling internal functions with the token's subject ([auth-plugins.md](auth-plugins.md) §2).
- **The REST API is public (partners, mobile, other teams):** configure the docs once with `http.docs({ info, securitySchemes, security, errors, tags, production: true })` in `forge/http.ts`, give every route a `summary`, `tags` and the stable error codes it answers (`errors: { 404: "task_not_found" }`), and name shared bodies (`v.object({...}, { name: "Task" })`) so they are one model ([server-features.md](server-features.md) "API docs and OpenAPI").
- **A provider two features need:** `_modules/shared/` with a `SharedModule` that exports it, imported by both modules. Not before two features need it.
- **A monorepo main app:** the CLI writes `<service>.service.ts`, `<service>.controller.ts`, `<service>.ts` and `_services.ts` for each remote service at the top of `forge/`; leave those where they are. Your own features still follow this blueprint.

## 4. Check it before you say it is done

```bash
# 1. Nest classes outside _modules: must print nothing (a monorepo main app: only the CLI's <service>.service.ts / .controller.ts)
find forge -path forge/node_modules -prune -o -path forge/_modules -prune -o \( -name "*.module.ts" -o -name "*.service.ts" -o -name "*.controller.ts" -o -name "*.gateway.ts" -o -name "*.resolver.ts" \) -print
# 2. Function files that do not inject a service: must print nothing (a monorepo main app: the CLI's <service>.ts; a new project: the starter's
#    messages.ts until you move it into _modules/messages)
find forge -path forge/node_modules -prune -o -name "*.ts" -not -path "*/_*" -print | grep -vE "^forge/(schema|auth|crons|http|webhooks)\.ts$|\.router\.ts$" | xargs -r grep -L "inject("
# 3. Hand-made pagination in services: must print nothing
grep -rnE "\.skip\(|\.slice\(|offset" forge/_modules --include=*.service.ts
bun run codegen && bun run typecheck && bun test
# a full-stack app's typecheck covers app/ (and the forge/ files its pages reach): also check all of forge/
npx tsc --noEmit -p forge
```

Then compare with section 1: one folder per feature, every class registered, functions thin, built-in pagination end to end.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                          | Read it for                                                                      |
| ------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)           | services, modules, controllers, `@Contract`, gateways, GraphQL                   |
| [functions](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/functions.mdx) | queries, mutations, actions, internal functions, what each may do                |
| [queries](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/queries.mdx)     | `ctx.db`, indexes, `.paginate()` and numbered pages, `include`, counts           |
| [framework](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/framework.mdx) | pages, loaders, `usePaginatedQuery` and `useNumberedPage` in a full-stack app    |
| [clients](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/clients.mdx)     | the hooks in a separate frontend (React, Vue, Svelte, mobile)                    |
| [testing](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/testing.mdx)     | `createTestBackend` and testing a running app                                    |
