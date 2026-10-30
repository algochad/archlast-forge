import { Ctx, type ActionCtx } from "../../src/nest";
import { ConnectedSocket, MessageBody, SubscribeMessage, WebSocketGateway, WebSocketServer, WsException, type Server, type Socket } from "../../src/nest-websockets";

/** Socket.IO at the default path, /http/socket.io: a handler's return value is the client's ack. */
@WebSocketGateway()
export class EventsGateway {
  @WebSocketServer() server!: Server;

  @SubscribeMessage("echo")
  echo(@MessageBody() data: unknown) {
    return data;
  }

  @SubscribeMessage("who")
  async who(@Ctx() ctx: ActionCtx) {
    return { identity: await ctx.auth.getUserIdentity() };
  }

  @SubscribeMessage("join")
  join(@ConnectedSocket() socket: Socket, @MessageBody() room: string) {
    void socket.join(room);
    return "joined";
  }

  @SubscribeMessage("tell")
  tell(@MessageBody() message: { room: string; text: string }) {
    this.server.to(message.room).emit("told", message.text);
  }

  @SubscribeMessage("fail")
  fail() {
    throw new WsException("nope");
  }
}

@WebSocketGateway({ namespace: "admin" })
export class AdminGateway {
  @SubscribeMessage("ping")
  ping() {
    return "pong";
  }
}
