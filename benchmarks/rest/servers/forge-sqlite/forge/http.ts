import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { ItemsController, ItemsDb, SeedController } from "./items.controller";

const http = httpRouter();
nest(http, { controllers: [ItemsController, SeedController], providers: [ItemsDb] });
export default http;
