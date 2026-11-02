import { httpAction, httpRouter } from "../../src/index";
import { nest } from "../../src/nest";
import { ForgeGraphQLDriver, GraphQLModule, type ForgeGraphQLOptions } from "../../src/nest-graphql";
import { Transport, type MicroserviceOptions } from "../../src/nest-microservices";
import { ForgeRpcServer } from "../../src/nest-rpc";
import { ChatGateway } from "./chat.gateway";
import { ExpressController } from "./express.controller";
import { MathController } from "./math.controller";
import { NotesModule } from "./notes.controller";
import { NotesResolver } from "./notes.resolver";
import { OrdersController } from "./orders.controller";
import { ShopRouter } from "./shop.router";

// The tests give each server its own ports; a process without them has no microservice.
const microservices: MicroserviceOptions[] = [];
if (process.env.NEST_TCP_PORT) microservices.push({ transport: Transport.TCP, options: { host: "127.0.0.1", port: Number(process.env.NEST_TCP_PORT) } });
if (process.env.NEST_RPC_PORT) microservices.push({ strategy: new ForgeRpcServer({ port: Number(process.env.NEST_RPC_PORT), host: "127.0.0.1" }) });

const http = httpRouter();
http.route({ method: "GET", path: "/plain", handler: httpAction(async () => new Response("from httpRouter")) });
nest(http, {
  imports: [NotesModule, GraphQLModule.forRoot<ForgeGraphQLOptions>({ driver: ForgeGraphQLDriver, autoSchemaFile: true, yoga: { graphiql: false } })],
  controllers: [ExpressController, MathController, OrdersController, ShopRouter],
  providers: [ChatGateway, NotesResolver],
  cors: { origin: "https://app.example", credentials: true },
  microservices,
});
export default http;
