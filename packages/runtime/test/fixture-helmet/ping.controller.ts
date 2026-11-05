import { Controller, Get, Header } from "../../src/nest";

@Controller("ping")
export class PingController {
  @Get()
  ping() {
    return { ok: true };
  }

  /** A handler's own header wins over the preset's. */
  @Get("framed")
  @Header("x-frame-options", "SAMEORIGIN")
  framed() {
    return { ok: true };
  }
}
