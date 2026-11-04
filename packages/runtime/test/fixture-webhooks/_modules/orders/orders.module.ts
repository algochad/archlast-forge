import { Module } from "@archlast/forge-runtime/nest";
import { hmacScheme, WebhooksModule } from "@archlast/forge-runtime/nest/webhooks";
import { PaymentsWebhookController } from "../payments/payments.webhook.controller";
import { OrdersWriter } from "./orders.service";

@Module({
  imports: [
    WebhooksModule.forRoot({
      eventTypes: ["order.shipped", "order.cancelled"],
      retry: { attempts: 4, delayMs: 10 },
      allowHttp: true, // the tests' receiver is plain HTTP on localhost
      allowPrivateNetworks: true,
      receivers: {
        payments: { secret: () => process.env.PAYMENTS_WEBHOOK_SECRET },
        github: { secret: "gh-secret", scheme: hmacScheme({ header: "x-hub-signature-256", prefix: "sha256=" }) },
      },
    }),
  ],
  controllers: [PaymentsWebhookController],
  providers: [OrdersWriter],
})
export class OrdersModule {}
