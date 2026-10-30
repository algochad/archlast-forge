import { httpRouter } from "../../src/index";
import { nest } from "../../src/nest";
import { AppModule } from "./app.module";

// The module-class form of nest().
const http = httpRouter();
nest(http, AppModule);
export default http;
