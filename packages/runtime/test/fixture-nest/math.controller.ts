import { anyApi } from "../../src/index";
import { Controller, Get, Param, type ActionCtx } from "../../src/nest";
import { computePool } from "../../src/pool";
import { Ctx, MessagePattern, Payload } from "../../src/nest-microservices";

// A pool made in a file with decorators, from plain functions: the workers load only the functions, so they need none of the plugins this file needs.
const work = computePool({ cube: (n: number) => n ** 3, where: (_: void) => (Bun.isMainThread ? "main" : "worker") }, { threads: 1 });

@Controller()
export class MathController {
  @Get("math/cube/:n")
  async cube(@Param("n") n: string) {
    return { cube: await work.call.cube(Number(n)), ran: await work.call.where() };
  }

  @MessagePattern("sum")
  sum(@Payload() numbers: number[]) {
    return numbers.reduce((a, b) => a + b, 0);
  }

  @MessagePattern("count")
  count(@Ctx() ctx: ActionCtx) {
    return ctx.runQuery(anyApi.notes.count);
  }
}
