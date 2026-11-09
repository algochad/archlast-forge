import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { ItemsController } from "./items.controller";

const http = httpRouter();
nest(http, { controllers: [ItemsController] });
export default http;
