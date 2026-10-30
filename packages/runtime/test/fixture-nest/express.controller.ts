import { Controller, Get, Req, Res, Sse, rxjs, type NestRequest, type NestResponse } from "../../src/nest";

/** Whether the client of the endless stream below went away, as the handler heard it. */
let foreverClosed = false;

/** Handlers that write the response themselves, the Express way. */
@Controller("express")
export class ExpressController {
  @Get("forever")
  forever(@Res() res: NestResponse) {
    foreverClosed = false;
    res.setHeader("content-type", "text/plain");
    const timer = setInterval(() => res.write("tick "), 50);
    res.on("close", () => (clearInterval(timer), (foreverClosed = true)));
    res.write("start ");
  }

  @Get("forever-closed")
  foreverIsClosed() {
    return { closed: foreverClosed };
  }

  @Get("json")
  json(@Res() res: NestResponse) {
    res.status(201).set("x-a", "1").cookie("k", "v", { httpOnly: true, maxAge: 60_000 }).json({ ok: true });
  }

  @Get("send")
  send(@Res() res: NestResponse) {
    res.type("html").send("<b>hi</b>");
  }

  @Get("passthrough")
  passthrough(@Res({ passthrough: true }) res: NestResponse) {
    res.setHeader("x-pass", "yes");
    return { passed: true };
  }

  @Get("stream")
  stream(@Res() res: NestResponse) {
    res.setHeader("content-type", "text/plain");
    res.write("first ");
    setTimeout(() => res.end("last"), 400);
  }

  @Get("redirect")
  redirect(@Res() res: NestResponse) {
    res.redirect(301, "/elsewhere");
  }

  @Get("request")
  request(@Req() req: NestRequest) {
    return { cookies: req.cookies, protocol: req.protocol, thing: req.get("X-Thing") };
  }

  @Sse("ticks")
  ticks() {
    return rxjs.interval(10).pipe(
      rxjs.take(3),
      rxjs.map((i) => ({ data: { i } })),
    );
  }
}
