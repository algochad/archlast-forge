# Webhooks: sending, receiving, or both, with the engine's module

Read this when the user wants webhooks in any direction: "send webhooks to our customers/partners when X happens", "receive webhooks from Stripe/GitHub/a provider", "a webhook engine (inbound and outbound)". The engine has it: **`@archlast/forge-runtime/nest/webhooks`**, built after `@nestjs/webhooks` (same signatures, retry schedule, endpoint rules) on the app's **own database** (document tables, the mutation's transaction as the outbox, the scheduler as the worker). It works on SQLite, Postgres and MongoDB.

**Use it. Do not install `@nestjs/webhooks`, `@nestjs/outbox`, Drizzle or a queue, and do not write your own delivery loop, retry timer, signing code or dedupe table.** `@nestjs/webhooks` needs its own Postgres/MySQL store and transaction, and projects never install `@nestjs/*`.

## 1. Wire it once

```ts
// forge/schema.ts
import { defineSchema, defineTable, v } from "@archlast/forge-runtime";
import { webhookTables } from "@archlast/forge-runtime/nest/webhooks";

export default defineSchema({
  ...webhookTables, // webhookEndpoints, webhookMessages, webhookDeliveries, webhookAttempts, webhookInbox
  orders: defineTable({ tenant: v.string(), item: v.string(), status: v.string() }).index("by_tenant", ["tenant"]),
});
```

```ts
// forge/webhooks.ts: must be this file (or the module named by the `functions` option); the scheduler calls these by name
import { webhookFunctions } from "@archlast/forge-runtime/nest/webhooks";

export const { deliver, claim, settle } = webhookFunctions(); // all internal
```

```ts
// forge/_modules/webhooks/webhooks.module.ts: the app's webhooks feature
import { Module } from "@archlast/forge-runtime/nest";
import { WebhooksModule } from "@archlast/forge-runtime/nest/webhooks";
import { TenancyModule } from "../tenancy/tenancy.module";
import { WebhooksController } from "./webhooks.controller";
import { TenantWebhooks } from "./webhooks.service";

@Module({
  imports: [
    TenancyModule, // when endpoints belong to organizations (auth-plugins.md)
    WebhooksModule.forRoot({
      eventTypes: ["order.shipped", "order.cancelled"],
      receivers: { payments: { secret: () => process.env.PAYMENTS_WEBHOOK_SECRET } },
    }),
  ],
  controllers: [WebhooksController],
  providers: [TenantWebhooks],
})
export class AppWebhooksModule {}
```

`WebhooksModule.forRoot()` is imported **once** (it is global: every module can inject `Webhooks`, `WebhookEndpoints`, `WebhookLog`, `WebhookInbox` and use `@VerifyWebhook()`). List `AppWebhooksModule` in `_modules/index.ts`. Put secrets in `.env` / `.env.example`, read through a function so they are read at request time.

## 2. Send: dispatch in the mutation that makes the change

```ts
// forge/_modules/orders/orders.service.ts
import { ForgeError } from "@archlast/forge-runtime";
import { ForgeService, Injectable, type MutationCtx } from "@archlast/forge-runtime/nest";
import { Webhooks } from "@archlast/forge-runtime/nest/webhooks";
import type { Id } from "../../_generated/dataModel";

@Injectable()
export class OrdersWriter extends ForgeService<MutationCtx> {
  constructor(private readonly webhooks: Webhooks) {
    super();
  }

  async ship(id: Id<"orders">) {
    const order = await this.ctx.db.get(id);
    if (!order) throw new ForgeError("No such order");
    await this.ctx.db.patch(id, { status: "shipped" });
    await this.webhooks.dispatch({ type: "order.shipped", tenant: order.tenant, data: { orderId: id, item: order.item } });
  }
}
```

- `dispatch({ type, data, tenant?, id? })` writes the message and one delivery per enabled endpoint of that tenant subscribed to `type` (or `"*"`), **in this mutation's transaction**: if the mutation throws, nothing is sent. `id` makes it idempotent.
- Delivery is automatic: a `POST` of `{ type, timestamp, data }` signed with Standard Webhooks (`webhook-id`, `webhook-timestamp`, `webhook-signature`), retried with backoff (10 attempts: about 5 s, 20 s, 80 s, …, capped at 1 day), `Retry-After` honored, the endpoint paused on 429/502/503/504, disabled on `410` or after 5 days of failures, every attempt logged. HTTPS only; private, loopback, link-local and metadata addresses refused.
- Never `fetch` a webhook URL yourself, from a mutation (it may re-run) or an action (no retries, no log).

## 3. Endpoints: the customer-facing part, scoped to the tenant

```ts
// forge/_modules/webhooks/webhooks.service.ts
import { ForgeService, Injectable, type MutationCtx, type QueryCtx } from "@archlast/forge-runtime/nest";
import { WebhookEndpoints, WebhookLog } from "@archlast/forge-runtime/nest/webhooks";
import { TenantContext } from "../tenancy/tenant.service";

@Injectable()
export class TenantWebhooks extends ForgeService<MutationCtx> {
  constructor(
    private readonly tenants: TenantContext,
    private readonly endpoints: WebhookEndpoints,
  ) {
    super();
  }
  async add(url: string, eventTypes: string[]) {
    const { organizationId } = await this.tenants.require("owner", "admin");
    return this.endpoints.create({ url, eventTypes, tenant: organizationId }); // { id, secret }: show the secret once
  }
  async rotate(id: string) {
    const { organizationId } = await this.tenants.require("owner", "admin");
    return this.endpoints.rotateSecret(id, { tenant: organizationId });
  }
}

@Injectable()
export class TenantWebhookLog extends ForgeService<QueryCtx> {
  constructor(
    private readonly tenants: TenantContext,
    private readonly log: WebhookLog,
  ) {
    super();
  }
  async deliveries(endpointId: string, paginationOpts: { numItems: number; cursor: string | null }) {
    const { organizationId } = await this.tenants.current();
    return this.log.deliveries(endpointId, paginationOpts, organizationId); // .paginate() result: usePaginatedQuery or a REST cursor
  }
}
```

The other methods: `endpoints.update(id, changes, tenant)`, `endpoints.remove(id, tenant)`, `endpoints.retry(deliveryId, tenant)`, `log.endpoints(tenant)`, `log.endpoint(id, tenant)` (no secrets: `secretCount`), `log.attempts(deliveryId, tenant)`. **Always pass the tenant from `TenantContext`**, never from the request. Expose them as thin functions in `forge/webhooks.ts` beside `webhookFunctions()`, and as REST in `webhooks.controller.ts` if customers manage endpoints over an API (as in [feature-blueprint.md](feature-blueprint.md)). With no tenants, leave `tenant` out everywhere.

## 4. Receive: verify in a guard, apply once in a mutation

```ts
// forge/_modules/payments/payments.webhook.controller.ts (in the feature the webhook changes)
import { ApiHidden, Controller, Ctx, HttpCode, Post, type ActionCtx } from "@archlast/forge-runtime/nest";
import { IncomingWebhook, VerifyWebhook, type IncomingWebhookData } from "@archlast/forge-runtime/nest/webhooks";
import { internal } from "../../_generated/api";

@Controller("webhooks")
@ApiHidden() // served, but not in the API docs: only the provider calls it
export class PaymentsWebhookController {
  @Post("payments") // POST /http/webhooks/payments
  @HttpCode(200)
  @VerifyWebhook("payments") // 401 before the handler unless signature and timestamp check out
  payments(@Ctx() ctx: ActionCtx, @IncomingWebhook() webhook: IncomingWebhookData<{ orderId: string; amount: number }>) {
    return ctx.runMutation(internal.payments.apply, { webhookId: webhook.id, orderId: webhook.payload.orderId, amount: webhook.payload.amount });
  }
}
```

```ts
// in PaymentsWriter (ForgeService<MutationCtx>, constructor(private readonly inbox: WebhookInbox))
async apply(webhookId: string, orderId: string, amount: number) {
  if (!(await this.inbox.once("payments", webhookId))) return { applied: false }; // a redelivery: nothing to do
  await this.ctx.db.insert("payments", { orderId, amount });
  return { applied: true };
}
```

- `receivers: { name: { secret, scheme?, toleranceMs? } }`: `secret` is one, several (rotation: each is tried), or a function. Standard Webhooks is the default scheme (signed id and timestamp, 5-minute tolerance). Senders that sign only the body (GitHub: `x-hub-signature-256: sha256=…`) use `scheme: hmacScheme({ header: "x-hub-signature-256", prefix: "sha256=" })`; their id is a hash of the signed body. Anything else: a custom `{ verify({ headers, rawBody }, secrets) }` returning `{ id, timestamp? }` or `null`, comparing in constant time.
- The signature is checked on the **raw body** by the guard; never re-serialize `payload` to check it.
- `inbox.once(receiver, id)` in the mutation that applies the webhook makes it exactly-once: the id commits with the change, and if the mutation fails the sender's retry is applied. Do not dedupe on unsigned headers.
- Answer fast; do slow work by scheduling it from that mutation.
- The controller lives in the feature the webhook affects (`_modules/payments/`), named `<feature>.webhook.controller.ts`.
- With the firewall on (`WAF=on`), a provider whose payloads trip the rules (a `text/plain` body, rich text, code) gets `403` before your guard runs: put its route in `WAF_IGNORE_PATHS` (`/http/webhooks/payments`, or the root path); the signature check still protects it.

## 5. Documenting the events you send

The events are part of your API: list them in `http.docs({ webhooks: { events: { "order.paid": { summary: "An order was paid.", data: Order } }, retry: { attempts: 10 } } })` in `forge/http.ts` (`Order` a named `v.object({...}, { name: "Order" })`; `retry` only if you changed `WebhooksModule.forRoot`'s). The API docs then show the envelope, the signature headers, how to verify and the retry schedule. `eventTypes` (what may be dispatched) and `events` (what is documented) are separate lists: keep them in step.

## 6. Inbound and outbound together

Both run from the same `WebhooksModule.forRoot({ eventTypes, receivers })`: one module, one set of tables. A common shape: a provider's webhook arrives (`@VerifyWebhook`), its mutation changes your data with `inbox.once()` and, in the same mutation, `webhooks.dispatch()`es your own event to your customers. The receive and the send then commit together.

## 7. Test

`createTestBackend` runs it all: dispatch in a mutation, then `await t.finishScheduledFunctions()` runs every delivery and retry immediately. Point endpoints at a `Bun.serve` on localhost with `allowHttp: true, allowPrivateNetworks: true` in the test configuration only, and check signatures with `standardScheme.verify(...)`. Controllers need a running server; sign requests with `signWebhook({ id, timestamp, body, secrets })`. See [testing.md](testing.md).

## 8. Common mistakes

- Installing `@nestjs/webhooks`, `@nestjs/outbox`, Drizzle, BullMQ or a queue for webhooks.
- `fetch`ing webhook URLs from a mutation, or from an action without the module (no outbox, retries, signing or log).
- Dispatching outside the mutation that makes the change (a webhook for a change that rolled back, or a change with no webhook).
- Verifying a signature on the parsed body, comparing with `===`, skipping the timestamp check, or deduplicating on an unsigned header.
- Applying a received webhook in the controller (it has no database) instead of in a mutation with `inbox.once()`.
- Taking `tenant` from the request; returning endpoint secrets after creation.
- `allowHttp`/`allowPrivateNetworks` outside tests.
- Forgetting `...webhookTables` in the schema or `webhookFunctions()` in `forge/webhooks.ts` (deliveries never run).

## Full documentation

When this file is not enough, read the page instead of guessing (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                     | Read it for                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [webhooks](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/webhooks.mdx) | every option, the delivery state machine, the endpoint and log API |
| [http](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/http.mdx)       | `/http` routes, raw bodies, who is calling                          |
| [scheduling](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/scheduling.mdx) | the scheduler the deliveries run on                           |
