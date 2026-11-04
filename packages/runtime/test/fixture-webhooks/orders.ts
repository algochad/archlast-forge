import { internalMutation, mutation, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { OrdersWriter } from "./_modules/orders/orders.service";

export const place = mutation({
  args: { tenant: v.string(), item: v.string() },
  handler: async (ctx, a) => (await inject(ctx, OrdersWriter)).place(a.tenant, a.item),
});
export const ship = mutation({
  args: { id: v.string(), failAfter: v.optional(v.boolean()), messageId: v.optional(v.string()) },
  handler: async (ctx, a) => (await inject(ctx, OrdersWriter)).ship(a.id, a),
});
/** Applies a verified payment webhook once. */
export const applyPayment = internalMutation({
  args: { webhookId: v.string(), orderId: v.string(), amount: v.number() },
  handler: async (ctx, a) => (await inject(ctx, OrdersWriter)).applyPayment(a.webhookId, a.orderId, a.amount),
});
