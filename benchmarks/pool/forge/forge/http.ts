import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { WorkController } from "./work.controller";

const http = httpRouter();
nest(http, { controllers: [WorkController] });
export default http;
