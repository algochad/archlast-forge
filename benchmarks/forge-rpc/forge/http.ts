import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { Transport, type MicroserviceOptions } from "@archlast/forge-runtime/nest/microservices";
import { ForgeRpcServer } from "@archlast/forge-runtime/nest/rpc";
import { EchoController } from "./echo.controller";
import { EchoRouter } from "./echo.router";

const microservices: MicroserviceOptions[] = [
  { transport: Transport.TCP, options: { host: "127.0.0.1", port: Number(process.env.BENCH_TCP_PORT) } },
  { strategy: new ForgeRpcServer({ port: Number(process.env.BENCH_RPC_PORT), host: "127.0.0.1" }) },
];
if (process.env.BENCH_REDIS_URL) {
  const u = new URL(process.env.BENCH_REDIS_URL);
  microservices.push({ transport: Transport.REDIS, options: { host: u.hostname, port: Number(u.port || 6379) } });
}

const http = httpRouter();
nest(http, { controllers: [EchoController, EchoRouter], microservices });
export default http;
