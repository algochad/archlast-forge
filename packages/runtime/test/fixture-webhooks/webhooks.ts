import { mutation, paginationOptsValidator, query, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { WebhookEndpoints, WebhookLog, webhookFunctions } from "@archlast/forge-runtime/nest/webhooks";

// The scheduler's delivery functions (internal).
export const { deliver, claim, settle } = webhookFunctions();

// Endpoint management. Public here so the tests can call it over /rpc; a real app takes the tenant from the caller, never an argument.
export const createEndpoint = mutation({
  args: { url: v.string(), eventTypes: v.array(v.string()), tenant: v.optional(v.string()) },
  handler: async (ctx, a) => (await inject(ctx, WebhookEndpoints)).create(a),
});
const tenant = v.optional(v.string());
export const rotateSecret = mutation({
  args: { id: v.string(), overlapMs: v.optional(v.number()), tenant },
  handler: async (ctx, { id, overlapMs, tenant }) => (await inject(ctx, WebhookEndpoints)).rotateSecret(id, { overlapMs, tenant }),
});
export const retry = mutation({
  args: { deliveryId: v.string(), tenant },
  handler: async (ctx, { deliveryId, tenant }) => (await inject(ctx, WebhookEndpoints)).retry(deliveryId, tenant),
});
export const endpoint = query({ args: { id: v.string(), tenant }, handler: async (ctx, { id, tenant }) => (await inject(ctx, WebhookLog)).endpoint(id, tenant) });
export const deliveries = query({
  args: { endpointId: v.string(), paginationOpts: paginationOptsValidator, tenant },
  handler: async (ctx, { endpointId, paginationOpts, tenant }) => (await inject(ctx, WebhookLog)).deliveries(endpointId, paginationOpts, tenant),
});
export const attempts = query({
  args: { deliveryId: v.string(), tenant },
  handler: async (ctx, { deliveryId, tenant }) => (await inject(ctx, WebhookLog)).attempts(deliveryId, tenant),
});
