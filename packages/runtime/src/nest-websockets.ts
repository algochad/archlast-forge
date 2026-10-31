// WebSocket gateways for Nest inside archlast-forge: everything @nestjs/websockets exports. The engine's server holds the sockets and the
// gateway runs in the function runtime. A gateway's `path` (default "/") is below /http and the mount prefix:
// `@WebSocketGateway({ path: "/chat" })` answers at ws://host/http/chat. Messages are `{ "event": "...", "data": ... }`, as with @nestjs/platform-ws.
import { WebSocketGateway as NestGateway } from "@nestjs/websockets";
// By the package's own name, not "./nest": the build keeps nest.ts its own entry then, and its `export *` of @nestjs/common survives.
import { timeClass } from "@archlast/forge-runtime/nest";

export * from "@nestjs/websockets";
export { onSocket, type ForgeSocket } from "@archlast/forge-runtime/nest";

/** Nest's `@WebSocketGateway()`, timing the gateway's handlers for the dashboard. */
export const WebSocketGateway = ((...args: unknown[]) => {
  const decorate = (NestGateway as (...a: unknown[]) => ClassDecorator)(...args);
  return (target: Function) => {
    timeClass(target, "gateway");
    return decorate(target);
  };
}) as typeof NestGateway;
// The types of a Socket.IO gateway (nest(http, { websockets: "socket.io" })): `@WebSocketServer() server: Server`, `@ConnectedSocket() socket: Socket`.
export type { Namespace, Server, Socket } from "socket.io";
