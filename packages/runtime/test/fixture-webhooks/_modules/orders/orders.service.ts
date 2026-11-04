import { ForgeError } from "@archlast/forge-runtime";
import { ForgeService, Injectable, type MutationCtx } from "@archlast/forge-runtime/nest";
import { WebhookInbox, Webhooks } from "@archlast/forge-runtime/nest/webhooks";

@Injectable()
export class OrdersWriter extends ForgeService<MutationCtx> {
  constructor(
    private readonly webhooks: Webhooks,
    private readonly inbox: WebhookInbox,
  ) {
    super();
  }

  place(tenant: string, item: string) {
    return this.ctx.db.insert("orders", { tenant, item, status: "placed" });
  }

  /** The order and its webhook commit together: if this throws after dispatching, nothing is sent. */
  async ship(id: string, o: { failAfter?: boolean; messageId?: string }) {
    const order = await this.ctx.db.get(id as never);
    if (!order) throw new ForgeError("No such order");
    await this.ctx.db.patch(id as never, { status: "shipped" } as never);
    const sent = await this.webhooks.dispatch({ type: "order.shipped", tenant: (order as any).tenant, data: { orderId: id, item: (order as any).item }, id: o.messageId });
    if (o.failAfter) throw new ForgeError("Failed after dispatching");
    return sent;
  }

  async applyPayment(webhookId: string, orderId: string, amount: number) {
    if (!(await this.inbox.once("payments", webhookId))) return { applied: false };
    await this.ctx.db.insert("payments", { orderId, amount });
    return { applied: true };
  }
}
