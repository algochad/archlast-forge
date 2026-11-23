import { Readable } from "node:stream";
import { Controller, Get, Header, Req, Res, StreamableFile, type NestRequest, type NestResponse } from "../../src/nest";

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

  @Get("file")
  file() {
    return new StreamableFile(Readable.from(["one ", "two"]));
  }

  @Get("drain")
  drain(@Res() res: NestResponse) {
    const ready = res.write(new Uint8Array(128 * 1024).fill(65));
    if (ready) res.end("early");
    else res.once("drain", () => res.end("drained"));
  }

  @Get("protocol")
  protocol(@Req() req: NestRequest) {
    return { protocol: req.protocol, secure: req.secure };
  }

  @Get("failure")
  failure() {
    throw undefined;
  }
}
