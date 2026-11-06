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
  order(@Param("shop") shop: string, @Body() body: { sku: string; qty: number }, @Query("express") express?: boolean) {
    return { shop, ...body, express: express ?? false };
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

  /** What the handler gets: the contract's params and query as their validators convert them, anything else as the text it came as. */
  @Get("page/:n")
  @Contract({
    params: { n: v.number({ int: true }) },
    query: { limit: v.optional(v.number()), all: v.optional(v.boolean()), tags: v.optional(v.array(v.string())) },
  })
  page(@Param("n") n: number, @Query() q: { limit?: number; all?: boolean; tags?: string[]; other?: string }) {
    return { n, limit: q.limit, all: q.all, tags: q.tags, other: q.other, types: [typeof n, typeof q.limit, typeof q.all, typeof q.other] };
  }

  /** Served, and left out of the docs. */
  @Post("hooks/provider")
  @ApiHidden()
  webhook() {
    return { ok: true };
  }
}
