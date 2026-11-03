# Forge RPC: typed calls between forge backends

Read this when one forge backend must call another (microservices in a monorepo, a service mesh), or when you add, change or debug a `@Router` class or a class that calls one. Needs [nest-services.md](nest-services.md) for the service/controller conventions it builds on, and [project-modes.md](project-modes.md) for the monorepo wiring.

Forge RPC is request-response, typed, over HTTP (tRPC v11 inside, Nest `ClientProxy` outside). A service declares **routers** with decorators; `archlast-forge codegen` writes their types; callers get `.query()` / `.mutate()` checked against them. It is **backend to backend only**.

## The one rule: frontends never touch it

```
page / mobile / desktop ──client──▶ main app's forge/ (controller or action ▶ OrdersService) ──Forge RPC──▶ orders' forge/
```

- Pages, mobile and desktop apps call the **main app's** functions (`api.orders.hello`, or `POST /http/orders/hello`). They never import `@<name>/contracts`, never know a service's address, never hold `FORGE_RPC_TOKEN`.
- Codegen fails if `src/` or `app/` imports `@archlast/forge-runtime/nest/rpc` or `forge/_generated/rpc`; `ForgeRpcClient`/`ForgeRpcServer` throw when a `window` exists.
- Everything comes from `@archlast/forge-runtime/nest/rpc`, including `z` (Zod 4). Do not install `zod` or `@trpc/*`. `Ctx` is re-exported there; `TransportCtx` and `RpcException` come from `/nest/microservices`.

## 1. The service side (declare and serve)

```ts
// apps/orders/forge/orders.router.ts   (routers live in their own files, never in http.ts)
import { internal } from "./_generated/api";
import type { ActionCtx } from "@archlast/forge-runtime/nest";
import {
  Ctx,
  Input,
  Mutation,
  Query,
  Router,
  z,
} from "@archlast/forge-runtime/nest/rpc";

const order = z.object({
  id: z.string(),
  status: z.enum(["open", "paid", "shipped"]),
  total: z.number(),
});

@Router({ alias: "orders" }) // procedures are "<alias>.<method>": orders.get
export class OrdersRouter {
  @Query({ input: z.object({ id: z.string() }), output: order })
  get(@Input("id") id: string, @Ctx() ctx: ActionCtx) {
    return ctx.runQuery(internal.orders.byId, { id });
  }

  @Mutation({
    input: z.object({
      userId: z.string(),
      items: z.array(
        z.object({ sku: z.string(), qty: z.number().int().positive() }),
      ),
    }),
    output: order,
  })
  create(
    @Input() input: { userId: string; items: { sku: string; qty: number }[] },
    @Ctx() ctx: ActionCtx,
  ) {
    return ctx.runMutation(internal.orders.create, input);
  }
}
```

```ts
// apps/orders/forge/http.ts
import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { ForgeRpcServer } from "@archlast/forge-runtime/nest/rpc";
import { OrdersRouter } from "./orders.router";

const http = httpRouter();
nest(http, {
  controllers: [OrdersRouter],
  microservices: [
    {
      strategy: new ForgeRpcServer({
        port: Number(process.env.ORDERS_RPC_PORT ?? 4001),
      }),
    },
  ],
});
export default http;
```

- `@Router({ alias })`: alias defaults to the class name without `Router`, first letter lowercased; must be an identifier; unique per app. The class is also a Nest controller (DI, guards, pipes, interceptors work).
- `@Query` / `@Mutation` take `input` and `output` (Zod or any Standard Schema). Without `input` the procedure takes none (`z.object({})` for an empty object). **Always give `output`**: without it callers get `unknown`.
- `@Input()` = whole checked input, `@Input("id")` = one field. `@Ctx()` = an **anonymous** `ActionCtx` (a service-to-service call has no signed-in user): to act for a user, pass the user id in `input` and authorize in the caller.
- Do the real work in internal functions through `ctx.runQuery(internal.…)` / `ctx.runMutation(internal.…)` so the service's own data keeps transactions and reactivity. Internal functions never reach clients.
- The server listens on its own port in the first runtime process, `host` default `0.0.0.0`. A server without a token refuses to start; a port already taken logs `[forge-rpc] the server didn't start: …`.
- Keep `@Query` for reads and `@Mutation` for writes; kind decides what callers see (`.query` vs `.mutate`).

## 2. Types: forge/_generated/rpc.ts

`archlast-forge codegen` (run by `dev`, `build`, `typecheck`) imports files containing `@Router(` and writes `forge/_generated/rpc.ts` (`export interface Rpc { orders: { get: { kind; input; output } … } }`). Commit it like the rest of `_generated`.

- Input types are what the schema accepts, output types what it returns. A `Date` or a transform becomes `unknown`; answers are JSON (a `Date` arrives as a string). Use `z.number()` timestamps and `z.string()` ids.
- Two routers with the same alias fail codegen.
- In a monorepo `packages/contracts/index.ts` re-exports each service's types: `export type { Rpc as OrdersRpc } from "../../apps/orders/forge/_generated/rpc";`. Only `rpc.ts` is shared, never a service's `api`/`dataModel` (two backends' generated types in one TypeScript project collide on the global `Register`).

## 3. The caller side: a service class holding the client

Default pattern (what `archlast-forge add service` generates in the main app):

```ts
// apps/web/forge/orders.service.ts
import { Injectable } from "@archlast/forge-runtime/nest";
import { createForgeRpcClient } from "@archlast/forge-runtime/nest/rpc";
import type { OrdersRpc } from "@acme/contracts";

@Injectable() // singleton: one client for the whole app
export class OrdersService {
  private readonly orders = createForgeRpcClient<OrdersRpc>({
    url: process.env.ORDERS_RPC_URL ?? "http://127.0.0.1:4001",
  });

  checkout(userId: string, items: { sku: string; qty: number }[]) {
    return this.orders.orders.create.mutate({ userId, items }); // client.<alias>.<procedure>.mutate|query
  }
  status(id: string) {
    return this.orders.orders.get.query({ id });
  }
}
```

```ts
// apps/web/forge/orders.controller.ts: for HTTP clients (POST /http/orders/...)
@Controller("orders")
export class OrdersController {
  constructor(private readonly orders: OrdersService) {} // value import of OrdersService
  @Post() checkout(
    @Body() body: { userId: string; items: { sku: string; qty: number }[] },
  ) {
    return this.orders.checkout(body.userId, body.items);
  }
}
```

```ts
// apps/web/forge/orders.ts: for pages and other functions (api.orders.checkout)
export const checkout = action({
  args: {
    userId: v.string(),
    items: v.array(v.object({ sku: v.string(), qty: v.number() })),
  },
  handler: async (ctx, { userId, items }) =>
    (await inject(ctx, OrdersService)).checkout(userId, items),
});
```

`forge/http.ts` of the caller: `nest(http, { controllers: [OrdersController], providers: [OrdersService] })` (in a monorepo main app, `forge/_services.ts` does this for scaffolded services; do not edit it).

- `createForgeRpcClient<Rpc>({ url, token?, timeoutMs? })`: `token` defaults to `FORGE_RPC_TOKEN`; `timeoutMs` defaults to 5000. The token is read at the first call.
- Call from controllers, actions (or crons / scheduled actions) and services they use. **Never from queries or mutations** (transaction, may re-run, no I/O).
- Calls in the same tick are batched into one HTTP request (up to 32), over keep-alive connections.
- Callee already validates input and output; do not validate again in the caller.
- Alternative: `ClientsModule.register([{ name: "ORDERS", customClass: ForgeRpcClient, options: { url } }])` and `createForgeRpcClient<OrdersRpc>(clientProxy)` in a module (`Inject("ORDERS")`). Use it when you want Nest to own the client's lifecycle.
- A wrapper service should expose **domain methods** (`checkout`, `status`), not the raw client, so callers do not depend on the wire shape and tests can replace one class.

## 4. A mesh: services calling services

The scaffold wires main app → each service. A service that must call another service (billing → orders) uses the same pattern, set up by hand:

1. In the **calling** service add a service class like `OrdersService` above in `forge/_modules/orders/orders.client.ts` (hand-written client classes belong in `_modules/`; the scaffolded `forge/orders.service.ts` of a main app stays where the CLI put it), register it in a module listed in `_modules/index.ts` (or the `nest()` call), and use it from its router methods, controllers or actions (an action invoked from the router via `ctx.runAction`, or inject it into the router class's constructor: routers are Nest controllers).
2. Add `"@<scope>/contracts": "workspace:*"` to the calling app's `package.json` (the main app has it as a devDependency), run `bun install`, then codegen in every app and the root `bun run typecheck`.
3. Add `<CALLEE>_RPC_URL` to the caller's `.env`/`.env.example` and compose environment. The same `FORGE_RPC_TOKEN` must be in every app of the mesh (the scaffold writes it to each `.env`).
4. Each callee must serve its `ForgeRpcServer` on its own `<NAME>_RPC_PORT` and every caller must reach it (same Docker network or host).

Mesh design rules:

- **Each service owns its data.** Other services get it only through its routers, never by connecting to its database.
- **Keep the call graph acyclic** (a → b → c). With a 5 s default timeout a cycle or a long chain times out. Chain depth costs latency: prefer the main app fanning out to services in parallel (`Promise.all`) over services chaining.
- **Timeouts and mutations:** a `TIMEOUT` on a mutation means the outcome is unknown. Make mutations idempotent (accept a client-generated key and ignore repeats) before retrying. Actions are at-most-once with no retries; never wrap RPC calls in your own retry unless the procedure is idempotent.
- **Authorize in the edge (main app)**, then pass the resolved `userId` in the input. Routers see an anonymous ctx.
- Do not call a service from inside another service's query or mutation; do it in an action or controller.
- Hot paths exchanging tiny messages are slower than raw TCP (~4–5k calls/s vs ~18k); measure before choosing Forge RPC there. Typed, validated calls and preserved errors are the reason to use it.

## 5. Errors

A failed call answers in the engine's envelope `{ message, code, data?, requestId? }`:

| In the service                             | Caller gets                                                                              |
| ------------------------------------------ | ---------------------------------------------------------------------------------------- |
| method threw `ForgeError`                  | a `ForgeError` with the same `data` (reaches this app's own caller as the service meant) |
| `RpcException`, or input failed its schema | a `ForgeError` (`BAD_REQUEST`) with the message / schema issues                          |
| anything else, or output failed its schema | `ForgeRpcError` `INTERNAL_SERVER_ERROR` "Server error (request …)"                       |
| wrong/missing token                        | `ForgeRpcError` `UNAUTHORIZED`                                                           |
| unknown procedure                          | `ForgeRpcError` `NOT_FOUND`                                                              |
| no answer in `timeoutMs`                   | `ForgeRpcError` `TIMEOUT`                                                                |
| unreachable                                | `ForgeRpcError` `SERVICE_UNAVAILABLE`                                                    |

Stack traces, SQL and unexpected messages never leave the service; look for `[forge-rpc] orders.get failed (request …)` in its log. Throw `ForgeError` for business errors the caller should handle; catch `ForgeRpcError` (import it from `/nest/rpc`) for infrastructure errors and map it to a friendly `ForgeError` at the edge.

## 6. Environment and deployment

| Variable             | Where                          | Meaning                                                           |
| -------------------- | ------------------------------ | ----------------------------------------------------------------- |
| `FORGE_RPC_TOKEN`    | every app that serves or calls | shared secret, ≥ 16 chars, never in a frontend or a client bundle |
| `<SERVICE>_RPC_PORT` | the service                    | listen port (4001, 4002, … in the scaffold)                       |
| `<SERVICE>_RPC_URL`  | each caller                    | `http://<host>:<port>` of the service                             |

- `bun run dev` at the monorepo root runs every app with `--no-docker`, so `http://127.0.0.1:4001` works. In production each app is its own stack: put stacks on one Docker network and set `ORDERS_RPC_URL=http://orders-app:4001`; publish the port only if something outside the stack connects. Rotate the token in all apps together.
- Services send telemetry to the main app's dashboard (`DASHBOARD_URL`, `DASHBOARD_TOKEN`, `MICROSERVICES`): a call to the main app and its calls to services are one trace (`traceparent` is forwarded).

## 7. Moving from Nest TCP

Replace `@Controller()` with `@Router({ alias })` and `@MessagePattern("orders.get")` with `@Query({ input, output })` on a method `get`; read input with `@Input()`; add `{ strategy: new ForgeRpcServer({ port }) }` to `microservices` (TCP may keep listening); in the caller replace the `ClientProxyFactory` client with `createForgeRpcClient<OrdersRpc>({ url })`; share the token.

## Common mistakes

- Importing `@<scope>/contracts` or any `nest/rpc` symbol in `app/` or `src/` (codegen fails). Frontends call the main app.
- Omitting `output`: callers get `unknown`. Omitting `input`: the procedure silently accepts none.
- Putting a `@Router` class in `forge/http.ts` (codegen reads routers from their own files).
- Missing or mismatched `FORGE_RPC_TOKEN` (calls fail `UNAUTHORIZED`; a server with no token will not start) or a token shorter than 16 characters.
- Calling a service from a query/mutation, or retrying a non-idempotent mutation after `TIMEOUT`.
- `import type` for the service class in a constructor (Nest loses the injection metadata).
- Forgetting to run codegen after changing a router: the caller's types are stale (`bun run typecheck` runs it).
- Reusing an alias in two routers; naming an alias that is not an identifier.
- Returning `Date`/`bigint` through a schema and expecting the same type on the caller.
- Importing a service's `api` or `dataModel` types into another backend (global `Register` collision `TS2717`); share only `rpc.ts` through contracts.
- Using the service's `127.0.0.1` URL in production instead of its container host name.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                                  | Read it for                                                                                 |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [forge-rpc](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/forge-rpc.mdx)         | the full Forge RPC reference: routers, types, clients, errors, performance, moving from TCP |
| [monorepo](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/monorepo.mdx)           | services calling services, transports, the workspace                                        |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)                   | microservice transports and `ClientsModule`                                                 |
| [errors](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/errors.mdx)               | the error envelope                                                                          |
| [observability](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/observability.mdx) | `rpc` requests and traces across services                                                   |
| [deployment](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/deployment.mdx)       | networks and ports for several stacks                                                       |
