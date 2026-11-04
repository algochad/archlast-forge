import { Controller, Ctx, HttpCode, Post, type ActionCtx } from "@archlast/forge-runtime/nest";
import { IncomingWebhook, VerifyWebhook, type IncomingWebhookData } from "@archlast/forge-runtime/nest/webhooks";
import { anyApi } from "@archlast/forge-runtime";

const internal = anyApi as any;

@Controller("webhooks")
export class PaymentsWebhookController {
  @Post("payments")
  @HttpCode(200)
  @VerifyWebhook("payments")
  async payments(@Ctx() ctx: ActionCtx, @IncomingWebhook() webhook: IncomingWebhookData<{ orderId: string; amount: number }>) {
    return ctx.runMutation(internal.orders.applyPayment, { webhookId: webhook.id, orderId: webhook.payload.orderId, amount: webhook.payload.amount });
  }

  @Post("github")
  @HttpCode(200)
  @VerifyWebhook("github")
  github(@IncomingWebhook() webhook: IncomingWebhookData) {
    return { id: webhook.id, payload: webhook.payload };
  }
}
