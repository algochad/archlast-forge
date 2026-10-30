import { anyApi } from "../../src/index";
import { Controller, type ActionCtx } from "../../src/nest";
import { Ctx, MessagePattern, Payload } from "../../src/nest-microservices";

@Controller()
export class MathController {
  @MessagePattern("sum")
  sum(@Payload() numbers: number[]) {
    return numbers.reduce((a, b) => a + b, 0);
  }

  @MessagePattern("count")
  count(@Ctx() ctx: ActionCtx) {
    return ctx.runQuery(anyApi.notes.count);
  }
}
