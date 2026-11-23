import { Body, Controller, Get, HttpCode, Post } from "@archlast/forge-runtime/nest";

@Controller()
export class ApiController {
  @Get("ping")
  ping() {
    return { ok: true };
  }

  @Post("webhook")
  @HttpCode(202)
  webhook(@Body() body: { event: string }) {
    return { received: body.event };
  }
}
