import { defineSchema, defineTable, v } from "@archlast/forge-runtime";
import { webhookTables } from "@archlast/forge-runtime/nest/webhooks";

export default defineSchema({
  ...webhookTables,
  orders: defineTable({ tenant: v.string(), item: v.string(), status: v.string() }).index("by_tenant", ["tenant"]),
  payments: defineTable({ orderId: v.string(), amount: v.number() }),
});
