import { httpAction, httpRouter } from "../../src/index";
import { nest } from "../../src/nest";
import { ForgeGraphQLDriver, GraphQLModule, type ForgeGraphQLOptions } from "../../src/nest-graphql";
import { Transport } from "../../src/nest-microservices";
import { ChatGateway } from "./chat.gateway";
import { ExpressController } from "./express.controller";
import { MathController } from "./math.controller";
import { NotesModule } from "./notes.controller";
import { NotesResolver } from "./notes.resolver";

const http = httpRouter();
http.route({ method: "GET", path: "/plain", handler: httpAction(async () => new Response("from httpRouter")) });
nest(http, {
  imports: [NotesModule, GraphQLModule.forRoot<ForgeGraphQLOptions>({ driver: ForgeGraphQLDriver, autoSchemaFile: true, yoga: { graphiql: false } })],
  controllers: [ExpressController, MathController],
  providers: [ChatGateway, NotesResolver],
  cors: { origin: "https://app.example", credentials: true },
  // The tests give each server its own port; a process without one has no microservice.
  microservices: process.env.NEST_TCP_PORT ? [{ transport: Transport.TCP, options: { host: "127.0.0.1", port: Number(process.env.NEST_TCP_PORT) } }] : [],
});
export default http;
