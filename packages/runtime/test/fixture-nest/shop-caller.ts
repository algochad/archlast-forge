import { Controller, Get, Inject, Injectable, Module, Query as QueryParam } from "../../src/nest";
import { ClientsModule, type ClientProxy } from "../../src/nest-microservices";
import { createForgeRpcClient, ForgeRpcClient, type ForgeRpcClientOf } from "../../src/nest-rpc";
import type { Rpc } from "./_rpc-types";

/** A class that calls a router, as forge-rpc.mdx shows it with ClientsModule: here the fixture's own shop router. */
@Injectable()
export class ShopService {
  private readonly shop: ForgeRpcClientOf<Rpc>;

  constructor(@Inject("SHOP") client: ClientProxy) {
    this.shop = createForgeRpcClient<Rpc>(client);
  }

  add(a: number, b: number) {
    return this.shop.shop.add.query({ a, b });
  }
}

@Controller("shop-caller")
export class ShopCallerController {
  constructor(private readonly shop: ShopService) {}

  @Get("add")
  add(@QueryParam("a") a: string, @QueryParam("b") b: string) {
    return this.shop.add(Number(a), Number(b));
  }
}

@Module({
  imports: [ClientsModule.register([{ name: "SHOP", customClass: ForgeRpcClient, options: { url: `http://127.0.0.1:${process.env.NEST_RPC_PORT}` } }])],
  providers: [ShopService],
  controllers: [ShopCallerController],
})
export class ShopCallerModule {}
