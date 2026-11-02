import { anyApi, ForgeError } from "../../src/index";
import type { ActionCtx } from "../../src/nest";
import { RpcException, TransportCtx } from "../../src/nest-microservices";
import { Ctx, ForgeRpcContext, Input, Mutation, Query, Router, z } from "../../src/nest-rpc";

const item = z.object({ sku: z.string(), qty: z.number().int().positive() });

/** The Forge RPC router the tests call: every kind of answer a procedure can give. */
@Router({ alias: "shop" })
export class ShopRouter {
  @Query({ input: z.object({ a: z.number(), b: z.number() }), output: z.object({ sum: z.number() }) })
  add(@Input() input: { a: number; b: number }) {
    return { sum: input.a + input.b };
  }

  @Mutation({ input: z.object({ userId: z.string(), items: z.array(item).min(1) }), output: z.object({ orderId: z.string(), units: z.number() }) })
  order(@Input("userId") userId: string, @Input("items") items: z.infer<typeof item>[]) {
    return { orderId: `${userId}-${items.length}`, units: items.reduce((n, i) => n + i.qty, 0) };
  }

  /** No schemas: no input, and the caller's type is what this returns. */
  @Query()
  async notes(@Ctx() ctx: ActionCtx) {
    return { count: (await ctx.runQuery(anyApi.notes.count)) as number };
  }

  @Query({ output: z.object({ ok: z.boolean() }) })
  drift() {
    return { ok: "yes" } as unknown as { ok: boolean };
  }

  @Mutation({ input: z.object({ kind: z.enum(["forge", "rpc", "crash"]) }) })
  fail(@Input("kind") kind: string, @TransportCtx() rpc: ForgeRpcContext) {
    if (kind === "forge") throw new ForgeError({ reason: "out of stock" });
    if (kind === "rpc") throw new RpcException(`bad sku (${rpc.getPattern()})`);
    throw new Error("SELECT secret FROM users");
  }

  @Query({ input: z.object({ ms: z.number() }) })
  async slow(@Input("ms") ms: number) {
    await Bun.sleep(ms);
    return "late";
  }
}
