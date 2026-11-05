import { v } from "../../src/index";
import { ApiHidden, ApiSecurity, Body, Contract, Controller, Get, Param, Post, Query } from "../../src/nest";

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

  /** What a scope guard declares (ApiSecurity) and the route's errors, for the document. */
  @Get("one/:id")
  @ApiSecurity("oauth", ["orders:read"])
  @Contract({ params: { id: v.string({ description: "The order's id" }) }, errors: { 404: "order_not_found" }, returns: v.object({ id: v.string() }) })
  one(@Param("id") id: string) {
    return { id };
  }

  /** Served, and left out of the docs. */
  @Post("hooks/provider")
  @ApiHidden()
  webhook() {
    return { ok: true };
  }
}
