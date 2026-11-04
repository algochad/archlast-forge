import { Controller, Get, Param } from "@archlast/forge-runtime/nest";

@Controller("tasks")
export class TasksController {
  @Get(":id")
  one(@Param("id") id: string) {
    return { id, from: "nest" };
  }
}
