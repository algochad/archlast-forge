// An app whose public docs are its REST API: /docs in production too, the document at the root, OAuth2 with scopes, problem+json errors.
import { httpAction, httpRouter, v } from "../../src/index";

const http = httpRouter({ root: true });

export const Price = v.object({ amount: v.number({ int: true, min: 1, description: "In the smallest unit of the currency." }), currency: v.string({ pattern: "^[A-Z]{3}$", example: "USD" }) }, { name: "Price" });
const Payment = v.object(
  { id: v.string({ example: "pay_123" }), type: v.enum("one_time", "subscription"), price: Price, refundedAt: v.nullable(v.string({ format: "date-time" })) },
  { name: "Payment", description: "A charge." },
);
const Problem = v.object({ type: v.string(), title: v.string(), status: v.number(), detail: v.optional(v.string()), code: v.string() }, { name: "Problem" });

http.docs({
  path: "/docs",
  openapi: "/openapi.json",
  explorer: "/docs/try",
  production: true,
  include: ["/api/v1"],
  functions: false,
  info: { title: "Midas API", version: "v1", description: "Payments." },
  servers: ["https://api.example.com"],
  securitySchemes: {
    oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "/api/auth/oauth2/token", scopes: { "payments:read": "Read payments", "payments:write": "Create payments" } } } },
  },
  security: [{ oauth: [] }],
  errors: { schema: Problem, contentType: "application/problem+json", common: { 401: "unauthorized", 429: "rate_limited" } },
  parameters: {
    idempotencyKey: { in: "header", name: "Idempotency-Key", schema: v.string({ maxLength: 255 }), description: "Makes a retried POST safe." },
    version: { in: "header", name: "Midas-API-Version", schema: v.literal("v1"), global: true },
    limit: { in: "query", name: "limit", schema: v.number({ int: true, min: 1, max: 100, default: 20 }) },
  },
  headers: { "x-request-id": { description: "The request's id, for support." } },
  tags: [{ name: "Payments", description: "Charge a customer." }],
  tagGroups: [{ name: "Core", tags: ["Payments"] }],
  webhooks: { events: { "payment.succeeded": { summary: "A payment went through.", data: Payment } }, retry: { attempts: 5 } },
  page: { title: "Midas", theme: { accent: "#6d28d9" } },
});

http.route({
  method: "GET",
  path: "/api/v1/payments",
  summary: "List payments",
  tags: ["Payments"],
  query: { type: v.optional(v.enum("one_time", "subscription")), limit: v.optional(v.number({ int: true, min: 1, max: 100 })) },
  returns: v.object({ page: v.array(Payment), isDone: v.boolean() }),
  security: [{ oauth: ["payments:read"] }],
  handler: httpAction(async (_ctx, req) => Response.json({ type: new URL(req.url).searchParams.get("type"), page: [], isDone: true })),
});

http.route({
  method: "POST",
  path: "/api/v1/payments",
  summary: "Create a payment",
  tags: ["Payments"],
  body: v.object({ type: v.enum("one_time", "subscription"), price: Price }),
  returns: Payment,
  status: 201,
  parameters: ["idempotencyKey"],
  security: [{ oauth: ["payments:write"] }],
  errors: { 409: { code: "duplicate_payment", description: "The idempotency key was used for another request." }, 422: ["amount_too_small", "currency_unsupported"] },
  responseHeaders: { "Idempotent-Replayed": { description: "true when this answer is a replay." } },
  codeSamples: [{ lang: "node", label: "Node SDK", source: "await midas.payments.create({ ... })" }],
  handler: httpAction(async (_ctx, req) => Response.json(await req.json(), { status: 201 })),
});

// Inbound, signature-checked: none of an integrator's business.
http.route({ method: "POST", path: "/api/webhooks/dodo", hidden: true, handler: httpAction(async () => new Response(null, { status: 204 })) });
http.route({ method: "GET", path: "/internal/stats", summary: "Stats", handler: httpAction(async () => Response.json({})) });

export default http;
