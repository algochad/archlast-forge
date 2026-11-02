import { v } from "../../src/index";
import { Body, Contract, Controller, Get, Param, Post, Query } from "../../src/nest";

/** A route with a contract: checked on every request, and the OpenAPI document's source for it. */
@Controller("orders")
export class OrdersController {
  @Post(":shop")
  @Contract({
    summary: "Order from a shop",
    params: { shop: v.string() },
    query: { express: v.optional(v.boolean()) },
    body: v.object({ sku: v.string(), qty: v.number() }),
    returns: v.object({ shop: v.string(), sku: v.string(), qty: v.number(), express: v.boolean() }),
  })
  order(@Param("shop") shop: string, @Body() body: { sku: string; qty: number }, @Query("express") express?: string) {
    return { shop, ...body, express: express === "true" };
  }

  @Get()
  list() {
    return [];
  }
}
