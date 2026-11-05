// Security headers from code: the REST API's (nest(http, { helmet })) over the engine's preset, and the app pages' (http.helmet()).
import { httpAction, httpRouter } from "../../src/index";
import { nest } from "../../src/nest";
import { PingController } from "./ping.controller";

const http = httpRouter({ root: true });
http.helmet({ app: { contentSecurityPolicy: { directives: { "img-src": ["'self'", "https://images.example.com"] } } } });
http.route({ method: "GET", path: "/plain", handler: httpAction(async () => Response.json({ plain: true })) });
nest(http, { prefix: "/api/", controllers: [PingController], helmet: { referrerPolicy: { policy: "same-origin" } } });
export default http;
