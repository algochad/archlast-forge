import { httpAction, httpRouter, minimalAction, minimalJson, v } from "../../src/index";
import { nest } from "../../src/nest";
import { ForgeGraphQLDriver, GraphQLModule, type ForgeGraphQLOptions } from "../../src/nest-graphql";
import { Transport, type MicroserviceOptions } from "../../src/nest-microservices";
import { ForgeRpcServer } from "../../src/nest-rpc";
import { DirectController, DirectNotes } from "./direct.controller";
import { ChatGateway } from "./chat.gateway";
import { ExpressController } from "./express.controller";
import { MathController } from "./math.controller";
import { NotesModule } from "./notes.controller";
import { NotesResolver } from "./notes.resolver";
import { OrdersController } from "./orders.controller";
import { ShopCallerModule } from "./shop-caller";
import { ShopRouter } from "./shop.router";

// The tests give each server its own ports; a process without them has no microservice.
const microservices: MicroserviceOptions[] = [];
if (process.env.NEST_TCP_PORT) microservices.push({ transport: Transport.TCP, options: { host: "127.0.0.1", port: Number(process.env.NEST_TCP_PORT) } });
if (process.env.NEST_RPC_PORT) microservices.push({ strategy: new ForgeRpcServer({ port: Number(process.env.NEST_RPC_PORT), host: "127.0.0.1" }) });

const http = httpRouter();
http.docs({
  securitySchemes: { oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "/api/auth/oauth2/token", scopes: { "orders:read": "Read orders" } } } } },
  errors: { schema: v.object({ statusCode: v.number(), message: v.string() }, { name: "NestError" }) },
});
// ctx.read / ctx.write on a route that is not Nest's: one read and one write transaction
http.route({
  method: "POST",
  path: "/minimal-notes",
  handler: minimalAction(async (ctx, req) => minimalJson(await ctx.write(async (c) => (await c.db.insert("notes", { text: new TextDecoder().decode(req.body), at: 2 }), (await c.db.query("notes").collect()).length)))),
});
http.route({ method: "GET", path: "/minimal-notes", handler: minimalAction(async (ctx) => minimalJson(await ctx.read(async (c) => (await c.db.query("notes").collect()).map((n) => n.text)))) });
http.route({ method: "GET", path: "/plain", handler: httpAction(async () => new Response("from httpRouter")) });
nest(http, {
  imports: [
    NotesModule,
    GraphQLModule.forRoot<ForgeGraphQLOptions>({ driver: ForgeGraphQLDriver, autoSchemaFile: true, yoga: { graphiql: false } }),
    ...(process.env.NEST_RPC_PORT ? [ShopCallerModule] : []), // its client needs the router's port and FORGE_RPC_TOKEN
  ],
  controllers: [ExpressController, MathController, OrdersController, ShopRouter, DirectController],
  providers: [ChatGateway, NotesResolver, DirectNotes],
  cors: { origin: "https://app.example", credentials: true },
  microservices,
});
export default http;
