# Command: `webhooks <send|receive|both> [events or provider]`

Wires webhooks with the engine's module (`@archlast/forge-runtime/nest/webhooks`), on the app's own database: signed, retried deliveries with a log for what you send, and verified, once-only handling for what you receive. Examples: `/archlast-forge webhooks send "invoice.paid, invoice.voided"`, `/archlast-forge webhooks receive stripe`.

## 1. Before you write

1. Read [webhooks.md](../webhooks.md) in full (sections 1 to 7).
2. Check whether it is wired already (`WebhooksModule` in `forge/_modules/`, its tables in `forge/schema.ts`): wire it once, then add events.
3. Know the events: for sending, each event's name (`<thing>.<past tense>`) and payload; for receiving, the provider and its signing scheme and secret name (never invent a secret: it goes in `.env`).

## 2. Steps

1. **Wire it once** (webhooks.md §1): `...webhookTables` in `forge/schema.ts`, `forge/webhooks.ts` exporting `webhookFunctions()` (that file name: the scheduler calls them by name), and `WebhooksModule.forRoot({ eventTypes, receivers })` imported once, in the app's `_modules/webhooks/` module listed in `_modules/index.ts`.
2. **Send** (§2, §3): `webhooks.dispatch(event, payload)` in the **Writer**, in the same mutation as the change (so the event exists only if the change committed). Endpoints are the customer's: scoped to their user or tenant, created and listed through your functions (§3).
3. **Receive** (§4): a `<feature>.webhook.controller.ts` in the folder of the feature the webhook changes, `@VerifyWebhook()` on it, `@ApiHidden()` so it stays out of the API docs, and the change applied once (`inbox.once()`) in a mutation.
4. **Document** the events you send in `http.docs({ webhooks })` when the app has API docs (§5).
5. Tests (§7), then `bun run codegen && bun run typecheck && bun test`.

## 3. Verify

- Sending: a test makes the change and finds the delivery queued with the right event and payload; against `bun run dev`, an endpoint pointed at a local listener receives a signed request, and the delivery log (`WebhookLog`, through your functions) shows it delivered.
- Receiving: a correctly signed request is applied once (send it twice: one change), a wrongly signed one is refused (`401`), and the route is absent from `openapi.json`.

## 4. Report

```
Webhooks: send <events> | receive <provider>
  wired: WebhooksModule (tables …) · dispatch in <Feature>Writer.<method>
  receive: POST /http/… (@VerifyWebhook, secret NAME in .env) → <feature>.<mutation>
Checks: tests … · signed delivery seen · bad signature refused · replay applied once
```

## 5. Stop and ask when

- the provider's signing secret or scheme is unknown;
- an event's payload would include personal or secret data (confirm what customers may receive);
- the app would call webhook URLs from a mutation or install a queue: never; that is what the module is for.

## Full documentation

| Page                                                                                                      | Read it for                                                  |
| --------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| [webhooks](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/webhooks.mdx) | the module, signing, retries, the delivery log, verification |
| [api-docs](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/api-docs.mdx) | documenting the events you send                             |
