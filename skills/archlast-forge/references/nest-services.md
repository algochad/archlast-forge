# Services, modules and controllers (NestJS in forge/)

Read this when you write a service class, a Nest module, a controller, a gateway or a GraphQL resolver in a `forge/` folder, in any project mode. For calls between backends, also read [forge-rpc.md](forge-rpc.md).

NestJS runs inside the engine. The engine owns the server; Nest never calls `listen()`. Every import comes from `@archlast/forge-runtime/nest` (and `/nest/websockets`, `/nest/graphql`, `/nest/microservices`, `/nest/rpc`). Never add or import `@nestjs/*`, `rxjs` (use `rxjs` exported from the nest entry) or `express`.

**Building a feature?** [feature-blueprint.md](feature-blueprint.md) is the complete, tested example of the structure this file explains; follow it. This file has the details and the rarer cases.

## Decide where logic goes

Every feature has both layers: the functions are its entry points, the services are where its code is. There is no "simple enough to skip the service" case.

| You need                                                                                    | Entry point                                                    | Where the code goes                                                       |
| ------------------------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Data reads the frontend calls, live queries                                                 | `query` in `forge/<feature>.ts` (thin)                          | a `Reader` (`ForgeService<QueryCtx>`) in `_modules/<feature>/`            |
| Writes                                                                                      | `mutation` in `forge/<feature>.ts` (thin)                       | a `Writer` (`ForgeService<MutationCtx>`) in `_modules/<feature>/`         |
| I/O: `fetch`, storage, email, payment, another backend                                      | `action` in `forge/<feature>.ts` (thin)                         | a `ForgeService<ActionCtx>` (or a singleton client) in `_modules/<feature>/` |
| A REST endpoint for outside callers (webhooks, partner APIs, mobile clients that want REST) | a controller in `_modules/<feature>/<feature>.controller.ts`    | the feature's functions, called with `ctx.runQuery`/`ctx.runMutation`     |
| Calling another forge backend                                                               | a service class holding a Forge RPC client                      | `_modules/<feature>/` (monorepo main apps: the CLI's `<service>.service.ts`) |
| Sockets, GraphQL, message-queue handlers                                                    | gateway, resolver, `@MessagePattern` controller                 | `_modules/<feature>/`                                                      |

A plain `http.route()` in `forge/http.ts` is only for a one-off route with no feature behind it (a health ping, a provider's webhook that only schedules work); anything belonging to a feature is a controller in its folder.

Rules that hold everywhere:

1. **Writes happen in mutations.** A controller, gateway or resolver gets an `ActionCtx` (no `db`). It calls `ctx.runQuery(api.x.y)` / `ctx.runMutation(api.x.z)`, so every write is one transaction and live queries see it.
2. **Services do the work, functions and controllers stay thin.** A function's handler is `inject` + one method call. A controller method is validation + one service/function call.
3. **Queries and mutations never do I/O** (no `fetch`, no RPC). Do I/O in actions, controllers, or services called from them.
4. **Every `forge/` file whose path has no segment starting with `_` is a function module** (the scanner loads it and `api.<file>` is built from it). Nest classes are not functions, so they go under `_`-prefixed paths, which the scanner, codegen and the client router ignore. See the layout below.

## Folder layout of a clean `forge/`

```
forge/
  schema.ts  auth.ts  crons.ts  http.ts      special modules: tables, Better Auth, crons, mounts nest() and routes
  notes.ts                                   public + internal functions: api.notes.* / internal.notes.* (thin: inject + one call)
  admin/users.ts                             a folder namespaces functions: api.admin.users.*
  orders.router.ts                           Forge RPC routers: top level, NOT under _ (codegen only reads non-_ files)
  _modules/                                  all Nest code, one folder per feature
    index.ts                                 export const appModules = [NotesModule, BillingModule]   (what http.ts imports)
    notes/
      notes.module.ts                        @Module wiring the feature
      notes.service.ts                       NotesReader / NotesWriter / singletons
      notes.controller.ts                    REST surface (+ notes.gateway.ts, notes.resolver.ts when needed)
      notes.guard.ts, notes.dto.ts           feature-local helpers
    shared/                                  cross-feature providers (clock, config, remote clients) in a shared module
  _lib/                                      plain helpers with no Nest and no ctx
  _services.ts                               monorepo main app only: written by `archlast-forge add service` / `remove`. Never edit
  _generated/                                codegen output, committed, never edit
  orders.service.ts, orders.controller.ts, orders.ts    monorepo main app only: scaffolded per remote service. Leave them where they are
  package.json  tsconfig.json
```

- **Why the underscore:** a function module's file name is its API name. `_modules/…` keeps `notes.service` and `notes.controller` out of the API and out of the client, and lets the folder hold as many classes as a feature needs.
- **The barrel is `_modules/index.ts`**, not `_modules.ts`: `http.ts` does `import { appModules } from "./_modules"`. Do not create a `_services/` folder: `_services.ts` is the CLI's generated list and a same-named folder would shadow-confuse imports.
- **Functions stay at the top level** (`forge/notes.ts`) so `api.notes.*` reads naturally; they import services from `./_modules/notes/notes.service`. A service never imports a function file; it receives a `ctx` and uses `ctx.runQuery(api…)` / `ctx.db`.
- **Routers stay out of `_modules`.** Codegen writes `_generated/rpc.ts` only from non-underscore files, so a `@Router` under `_modules/` produces no types for callers. Put `<service>.router.ts` at the top of `forge/`.
- **Scaffold-owned files stay put.** `archlast-forge remove`/`workspace sync` find `<svc>.service.ts`, `<svc>.controller.ts`, `<svc>.ts` and `_services.ts` by path. Your own classes go in `_modules/`.
- A feature module's `providers` list its services; `exports` only what other modules inject. Cross-feature dependency goes through `imports: [OtherModule]`, never a deep relative import of another feature's internals.
- Small project (one or two features): `_modules/notes/` is still the right place; skip `shared/` until two features need the same provider.

## Set up (check once)

`forge/tsconfig.json` needs `"experimentalDecorators": true` and `"emitDecoratorMetadata": true`; scaffolds since 0.4.0 have them. A full-stack app (or any frontend that imports `forge/_generated`) also needs `"experimentalDecorators": true` in its own `tsconfig.json`. The engine compiles decorator files itself; do not add Babel or SWC.

## Services

```ts
// forge/_modules/notes/notes.service.ts
import {
  ForgeService,
  Injectable,
  type MutationCtx,
  type QueryCtx,
} from "@archlast/forge-runtime/nest";

@Injectable()
export class Clock {
  // no ctx: a singleton for the whole app
  now() {
    return Date.now();
  }
}

@Injectable()
export class NotesReader extends ForgeService<QueryCtx> {
  // request-scoped: one per call
  recent() {
    return this.ctx.db.query("notes").order("desc").take(20);
  }
}

@Injectable()
export class NotesWriter extends ForgeService<MutationCtx> {
  constructor(private readonly clock: Clock) {
    super();
  } // always call super()
  add(text: string) {
    return this.ctx.db.insert("notes", { text, at: this.clock.now() });
  }
}
```

```ts
// forge/notes.ts
import { mutation, query, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { NotesReader, NotesWriter } from "./_modules/notes/notes.service";

export const recent = query({
  args: {},
  handler: async (ctx) => (await inject(ctx, NotesReader)).recent(),
});
export const add = mutation({
  args: { text: v.string() },
  handler: async (ctx, { text }) => (await inject(ctx, NotesWriter)).add(text),
});
```

- `ForgeService<C>`: `this.ctx` is the ctx of the call being served. Pick the narrowest ctx: `QueryCtx` reads (usable from queries and mutations), `MutationCtx` writes (mutations only), `ActionCtx` for auth, storage, scheduler, `runQuery`/`runMutation`/`runAction`. `inject()` is a type error when the ctx is too weak (a query cannot inject a `ForgeService<MutationCtx>`).
- Without the base class: `constructor(@InjectCtx() private readonly ctx: QueryCtx)`.
- **Scope rules:** a class extending `ForgeService` (or injecting `CTX`) is request-scoped; anything that injects a request-scoped class becomes request-scoped too. A plain `@Injectable()` with no ctx is a singleton. Keep ctx-free logic (clocks, formatters, clients, config, caches) in singletons; request-scoped classes are built on every call.
- Two `inject()` calls with the same ctx share instances.
- **Import service classes as values**, never `import type`: Nest reads constructor parameter types at runtime, and a type-only import loses the metadata (the service injects as `undefined`).
- Reader/writer split (`NotesReader`, `NotesWriter`) is the convention: readers are usable from queries (and so reactive); writers need a mutation.
- Queries stay reactive through a service because it reads through `this.ctx.db`.
- Throw `ForgeError` (from `@archlast/forge-runtime`) for errors the caller should see; anything else becomes "Server error (request id)" outside dev.

## Modules

Modules work as in Nest. Use them to group a feature's controller and services; mount them through `nest()`.

```ts
// forge/_modules/notes/notes.module.ts
import { Module } from "@archlast/forge-runtime/nest";
import { NotesController } from "./notes.controller";
import { Clock, NotesReader, NotesWriter } from "./notes.service";

@Module({
  controllers: [NotesController],
  providers: [Clock, NotesReader, NotesWriter],
  exports: [NotesReader],
})
export class NotesModule {}
```

```ts
// forge/_modules/index.ts: the feature modules, the way forge/_services.ts lists remote services
import { NotesModule } from "./notes/notes.module";
export const appModules = [NotesModule];
```

```ts
// forge/http.ts: the only place nest() is called, and it is called once
import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { appModules } from "./_modules";

const http = httpRouter();
nest(http, { imports: appModules }); // or nest(http, AppModule) when you have a root module
export default http;
```

- `nest(http, { controllers, providers, imports, prefix, cors, helmet, microservices, websockets, setup, logger })`. `helmet` is Helmet's options over the REST API's security headers preset (`false` for none; never `app.use(helmet())`). A module class as the second argument is the same as `{ imports: [Module] }`. Calling `nest()` twice throws.
- **`inject(ctx, Service)` resolves a provider from any module** (it looks across the whole app), so a function can inject a service that only a feature module registers. Every service a function injects must be registered in some module or in `providers`.
- The ctx provider (`CTX`) is global, so `ForgeService` subclasses work in any feature module without importing anything.
- Module-level `exports`/`imports` matter for constructor injection between classes (as in Nest): a service in module A that a controller in module B injects must be exported by A and A imported by B.
- Global guards, pipes, interceptors and filters: `{ provide: APP_GUARD, useClass: AuthGuard }` in a module's `providers` (`APP_GUARD`, `APP_PIPE`, `APP_INTERCEPTOR`, `APP_FILTER` come from the nest entry). A global guard/interceptor also runs for gateways and resolvers: check `context.getType()`.
- Middleware: implement `NestModule.configure(consumer)` on the module.
- Dynamic modules (`GraphQLModule.forRoot(...)`, `ClientsModule.register(...)`) go in `imports`.
- One module per feature, all listed in `_modules/index.ts` and mounted with `nest(http, { imports: appModules })` (layout above).
- `forge/_services.ts` (monorepo main apps) is written by `archlast-forge add service` / `remove`: **do not edit it**. Add your own feature modules beside it: `nest(http, { imports: appModules, controllers: serviceControllers, providers: serviceProviders })`.

## Controllers

```ts
// forge/_modules/notes/notes.controller.ts
import {
  Body,
  Contract,
  Controller,
  Ctx,
  Get,
  Post,
  type ActionCtx,
} from "@archlast/forge-runtime/nest";
import { v } from "@archlast/forge-runtime";
import { api } from "../../_generated/api";

@Controller("notes") // answers at /http/notes (and at /api/v1/notes with a root router and prefix "/api/v1/")
export class NotesController {
  @Get()
  list(@Ctx() ctx: ActionCtx) {
    return ctx.runQuery(api.notes.recent);
  }

  @Post()
  @Contract({
    body: v.object({ text: v.string() }),
    returns: v.object({ id: v.string() }),
    summary: "Add a note",
  })
  async add(@Ctx() ctx: ActionCtx, @Body() body: { text: string }) {
    return { id: await ctx.runMutation(api.notes.add, { text: body.text }) };
  }
}
```

- `@Ctx()` gives the request's `ActionCtx` (auth, storage, scheduler, `runQuery`, `runMutation`). `api` comes from `./_generated/api`.
- `@Contract({ params, query, body, returns, summary, description, tags })` (plus, for the API docs only: `security`, `errors`, `parameters`, `responseHeaders`, `status`, `codeSamples`, `hidden`; see server-features.md "API docs and OpenAPI"): **`params` and `query` are a record of validators** (`{ id: v.id("tasks") }`), **`body` and `returns` are one validator** (`v.object({...})`). TypeScript accepts a `v.object` for `params`/`query`, and every request to the route then fails with a 500. It checks the request with the engine's `v` validators before the handler (400 with the reason) and puts the route in the OpenAPI document. Use it on every public route. Params/query arrive as text, are converted for `v.number()`/`v.boolean()`/literals, checked, and handed to the handler converted (`@Query() q: { limit?: number }` gets a number); fields the contract doesn't name stay text.
- A controller may inject a ctx-free singleton or a `ForgeService<ActionCtx>`. Do **not** inject a `ForgeService<QueryCtx|MutationCtx>` into a controller: a request's ctx has no `db`.
- Return values: object/array → JSON, string → text, `StreamableFile` streams, a Web `Response` is sent as is. Status codes follow Nest (201 for `@Post()`, `@HttpCode()` to change).
- `@Req()` is `NestRequest` (Express API: `headers`, `query`, `params`, `body`, `cookies`, `rawBody`, `raw`); `@Res()` is `NestResponse` (Express API; once written to it streams). Use `@Res({ passthrough: true })` to set headers and still return a value.
- `prefix` in `nest()` (default `"/"`, must start and end with `/`) moves every controller below `/http<prefix>`. Routes added with `http.route()` take priority over Nest.
- **Serving at the root** (a public API at `/api/v1/...`, a provider that wants `/webhooks/stripe`): `const http = httpRouter({ root: true })`, then `nest(http, { prefix: "/api/v1/", imports: appModules })`. `@Controller("tasks")` answers at `/api/v1/tasks` and still at `/http/api/v1/tasks`; the OpenAPI document lists the root paths. The engine's paths win (`/rpc`, `/api/auth`, `/_admin`, `/_dashboard`, `/_storage`, `/_app`, `/health`, ...), and a route inside one fails at load: never `/api/auth/...`. In a full-stack app the pages get the other paths, so always give Nest a prefix there (a `"/"` prefix stays under `/http`, with a warning).
- API docs: `@Contract` fills them; `@ApiSecurity("oauth", ["tasks:write"])` on a controller or handler names how it is called (a scope guard's decorator can apply it), `@ApiHidden()` leaves one out (an inbound webhook) while it is still served. `http.docs({...})` in `forge/http.ts` sets the rest ([server-features.md](server-features.md)).
- CORS: `nest(http, { cors: { origin: "https://app.example.com", credentials: true } })`; `setup: (app) => app.useGlobalPipes(...)` for versioning (URI only), global prefix, etc.
- Errors: `HttpException` subclasses answer as in Nest; `ForgeError` answers 400 with its data; anything else 500 `Server error (request <id>)`.
- Auth in a controller: `await ctx.auth.getUserIdentity()` (see server-features.md), or a guard that reads it from `ExecutionContext`'s `@Ctx()`.
- Unavailable: `listen()`, static assets, view engines. Serve files from `public/` (full-stack) or storage.

## Gateways, GraphQL, microservices (when asked for)

- **WebSocket gateway** (`/nest/websockets`): `@WebSocketGateway({ path: "/chat" })` answers at `ws://host/http/chat`; list the class in `providers`. Messages are JSON `{ event, data }`. `@Ctx()` is the socket's `ActionCtx` (caller from the upgrade request). `websockets: "socket.io"` in `nest()` makes every gateway Socket.IO (client path `/http/socket.io`). Origin must be in `TRUSTED_ORIGINS`. Gateway sockets live in the first runtime process and one server: broadcast to every client through the database (mutation + live query) when several servers run.
- **GraphQL** (`/nest/graphql`): `GraphQLModule.forRoot<ForgeGraphQLOptions>({ driver: ForgeGraphQLDriver, autoSchemaFile: true })` in `imports`, resolvers in `providers`; served at `/http/graphql`; subscriptions via `createPubSub` (`graphql-transport-ws` on the same path). Resolvers use `@Ctx()` like controllers. Defaults: CORS only for `TRUSTED_ORIGINS` and `BETTER_AUTH_URL` (or `nest()`'s `cors`), operations only as `application/json` (`jsonOnly: false` for multipart uploads), GraphiQL and introspection in dev only (`yoga: { graphiql: true }`, `introspection: true`).
- **Microservice transports** (`/nest/microservices`): `microservices: [{ transport: Transport.TCP, options: { host: "0.0.0.0", port: 4000 } }]` plus `@MessagePattern`/`@EventPattern` in controllers. Listen in the first runtime process only. Between forge backends prefer Forge RPC.
- `onSocket(path, handler)` for raw sockets.

## By project mode

- **Full-stack app:** same `forge/` rules. Pages never call controllers; they call `api.*` functions (types from `forge/_generated`). `/http` is reserved by the engine: no route file may use it. Set `experimentalDecorators` in the root `tsconfig.json`.
- **Backend only:** controllers and gateways serve non-TypeScript or cross-origin clients; the app's own frontend still uses functions. Set `cors` and `TRUSTED_ORIGINS` for browsers on other origins. Publish a transport port in `compose.yaml` only if something outside the stack connects (Caddy proxies HTTP only).
- **Monorepo main app:** one service class + controller + action per service, listed in `forge/_services.ts` (see [project-modes.md](project-modes.md)). **Monorepo service:** a backend whose `http.ts` serves a Forge RPC router.
- **Several servers (`REPLICAS`) or `RUNTIME_WORKERS > 1`:** gateway sockets, `createPubSub` events and transports are per server (sockets and transports on the first runtime process). Use the database for anything every client must see.

## Testing

`createTestBackend` (from `@archlast/forge-runtime/testing`) runs functions that `inject()` services the way the server does, with the providers mounted in `forge/http.ts`. Controllers, gateways, GraphQL and transports need a running server (call `/http/...`). See [testing.md](testing.md).

## NestJS best practices in archlast-forge

Nest's own advice holds, adjusted to an engine that owns the server, the database and the processes:

- **One module per feature**, in `_modules/<feature>/`. `providers` list its classes, `exports` only what another module injects, and cross-feature use goes through `imports: [OtherModule]`. Never deep-import another feature's file to `new` its class.
- **Shared, cross-cutting providers** (the tenant of a call, clients for outside APIs, configuration) live in their own module (`_modules/tenancy/`, `_modules/shared/`) that exports them; features import it. Reserve `global: true` for infrastructure modules (the engine's `WebhooksModule` is one); your feature modules are not global.
- **Scopes:** ctx-free classes are singletons; classes that need the call are `ForgeService<…>` (request-scoped). A singleton must not inject a request-scoped class (Nest would make it request-scoped too, built on every call). Keep clients, caches and configuration in singletons.
- **Authentication at the edge, authorization in services.** Guards check who an HTTP caller is (a session via `@Ctx()`, an OAuth access token, a webhook signature) and fail with `401`/`403`. Rules about roles, ownership and tenants live in services, so functions, controllers and gateways share them.
- **Custom decorators** compose Nest's: `applyDecorators(SetMetadata(KEY, value), UseGuards(Guard))` for a route rule (`@RequireScopes("tasks:read")`, `@VerifyWebhook("payments")`), `createParamDecorator(...)` for what the guard verified (`@OAuthToken()`, `@IncomingWebhook()`). Read the metadata with `Reflect.getMetadata(KEY, context.getHandler())` (or Nest's `Reflector`). See [auth-plugins.md](auth-plugins.md) for a full guard.
- **Validation is `@Contract`**, with the engine's `v` validators (it also writes the OpenAPI document). `class-validator`, `class-transformer` and `ValidationPipe` DTOs are not installed and not the pattern; a DTO type is a plain TypeScript type or `Infer<typeof validator>`.
- **Errors:** controllers and guards throw `HttpException`s (`NotFoundException`, `ForbiddenException`, …) for HTTP semantics; services throw `ForgeError`, which reaches function callers typed and HTTP callers as `400`. Do not catch and re-wrap errors to change their shape.
- **Configuration** is `process.env`, read where it is used (or in a `useFactory` provider), and listed in `.env.example` and `compose.yaml`. There is no `@nestjs/config`.
- **Lifecycle hooks** (`onModuleInit`, `onApplicationBootstrap`) run in every runtime process (`RUNTIME_WORKERS`) and again on every dev reload: no timers, background loops or one-time jobs there. Use `forge/crons.ts` and `ctx.scheduler`.
- **A service that calls `internal.<its own feature>.*`** (an `ActionCtx` service using its feature's internal queries) closes a type cycle: the feature's function file imports the service, and `internal`'s types come from that file. Write the service methods' return types out (`async get(path: string): Promise<unknown>`), or TypeScript drops the function from `internal` (`Property 'tokens' does not exist on type ModuleRefs<…>`).
- **No circular dependencies** between providers or modules; `forwardRef` is a sign two features should share a third module.
- **Interceptors** are for cross-cutting HTTP concerns. Do not add one for timing or logging: Nest classes are already traced on the dashboard.
- **Controllers stay thin and declared:** `@Contract` on every public route, `@HttpCode(200)` where a sender expects it (webhooks), `@Res()` only to stream.
- **Ready-made modules from the engine come first:** webhooks ([webhooks.md](webhooks.md)), Forge RPC ([forge-rpc.md](forge-rpc.md)), gateways and GraphQL (above). They are imported from `@archlast/forge-runtime/nest/*`, never from `@nestjs/*`.

## Common mistakes

- Skipping the service layer: logic, `ctx.db` calls or auth checks written inside function handlers or controller methods.
- Putting a controller, service or module anywhere but `forge/_modules/<feature>/` (a `forge/controllers/` folder, the top of `forge/`, `src/`).
- `@Contract({ query: v.object({...}) })` or `params: v.object(...)`: they take a record of validators.
- Calling `nest()` more than once, or in a file other than `forge/http.ts`.
- Forgetting to register a service in `providers` or in a module when only a function injects it ("no provider" at the first call).
- `import type { OrdersService }` in a constructor: use a value import.
- Forgetting `super()` in a `ForgeService` constructor, or reading `this.ctx` in the constructor (it is set after construction; use it in methods).
- Making everything request-scoped: a service that does not need the ctx must not extend `ForgeService`.
- Controller writing to the database directly or injecting `ForgeService<MutationCtx>`: call a mutation.
- Doing `fetch`/RPC inside a query or mutation (they run in a transaction and may re-run).
- Importing `@nestjs/*` or `express` directly; they are not installed in your project.
- Editing `forge/_services.ts` or `forge/_generated/*` by hand.
- Putting a `@Router` class under `_modules/` (no `rpc.ts` types are generated for it) or Nest classes at the top level of `forge/` (they become function modules and clutter the API namespace).
- Putting a route file under `/http` in a full-stack app, or expecting `listen()`/static assets in Nest.
- Putting two feature classes under the same `@Controller` path or the same `@Router` alias.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                                  | Read it for                                                                                       |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)                   | the full NestJS API: services, controllers, `@Contract`, gateways, GraphQL, microservices, limits |
| [backend](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/backend.mdx)             | Nest in a backend: the worked example and what is particular to backends                          |
| [framework](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/framework.mdx)         | Nest in a full-stack app                                                                          |
| [http](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/http.mdx)                   | plain `forge/http.ts` routes beside Nest, validators, CORS                                        |
| [testing](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/testing.mdx)             | `createTestBackend` with services, testing a running app                                          |
| [errors](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/errors.mdx)               | how errors reach callers                                                                          |
| [observability](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/observability.mdx) | class spans and the Services page                                                                 |
