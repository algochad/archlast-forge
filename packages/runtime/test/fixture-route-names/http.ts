import { httpAction, httpRouter } from "../../src/index";
import { Controller, Get, nest, Param } from "../../src/nest";

@Controller("users")
class Users {
  @Get(":name")
  one(@Param("name") name: string) {
    return { name };
  }
}

@Controller("orders")
class Orders {
  @Get(":id")
  one(@Param("id") id: string) {
    return { id };
  }
}

const http = httpRouter();
http.route({ method: "GET", path: "/ping", handler: httpAction(async () => new Response("ok")) });
nest(http, { controllers: [Users, Orders] });
export default http;
