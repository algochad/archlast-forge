import { httpRouter } from "@archlast/forge-runtime";
import { nest } from "@archlast/forge-runtime/nest";
import { appModules } from "./_modules";

const http = httpRouter();
nest(http, { imports: appModules });
export default http;
