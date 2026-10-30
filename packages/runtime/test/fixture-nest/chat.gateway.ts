import { anyApi } from "../../src/index";
import { Ctx, type ActionCtx } from "../../src/nest";
import { MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException, type ForgeSocket, type OnGatewayConnection } from "../../src/nest-websockets";

@WebSocketGateway({ path: "/ws" })
export class ChatGateway implements OnGatewayConnection {
  @WebSocketServer() server!: { clients: Set<ForgeSocket> };
  connections = 0;

  handleConnection() {
    this.connections++;
  }

  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return { event: "echo", data };
  }

  @SubscribeMessage("count")
  async count(@Ctx() ctx: ActionCtx) {
    return { event: "count", data: await ctx.runQuery(anyApi.notes.count) };
  }

  @SubscribeMessage("who")
  async who(@Ctx() ctx: ActionCtx) {
    return { event: "who", data: await ctx.auth.getUserIdentity() };
  }

  @SubscribeMessage("shout")
  shout(@MessageBody() data: string) {
    for (const client of this.server.clients) client.send(JSON.stringify({ event: "shout", data }));
  }

  @SubscribeMessage("fail")
  fail() {
    throw new WsException("nope");
  }

  /** Which function runtime process holds this socket. */
  @SubscribeMessage("worker")
  worker() {
    return { event: "worker", data: process.env.ARCHLAST_WORKER ?? "inline" };
  }
}
