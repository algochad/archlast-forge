import { httpRouter } from "../../src/index";
import { nest } from "../../src/nest";
import { AdminGateway, EventsGateway } from "./events.gateway";

const http = httpRouter();
nest(http, { providers: [EventsGateway, AdminGateway], websockets: "socket.io" });
export default http;
