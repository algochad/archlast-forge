import { anyApi, ForgeError } from "../../src/index";
import {
  APP_INTERCEPTOR,
  Body,
  Controller,
  Ctx,
  Get,
  Headers,
  HttpException,
  Injectable,
  Module,
  StreamableFile,
  UseInterceptors,
  rxjs,
  type CallHandler,
  Param,
  ParseIntPipe,
  Post,
  Query,
  Redirect,
  UseGuards,
  type ActionCtx,
  type CanActivate,
  type ExecutionContext,
  type MiddlewareConsumer,
  type NestModule,
  type NestInterceptor,
  type NestRequest,
  type NestResponse,
} from "../../src/nest";
import { Clock, Counter, NotesReader, NotesWriter, Viewer } from "./notes.service";

const api = anyApi;

@Injectable()
class KeyGuard implements CanActivate {
  canActivate(context: ExecutionContext) {
    return context.switchToHttp().getRequest().headers["x-key"] === "open sesame";
  }
}

@Injectable()
class Wrap implements NestInterceptor {
  intercept(_context: ExecutionContext, next: CallHandler) {
    return next.handle().pipe(rxjs.map((data) => ({ wrapped: data })));
  }
}

/** Global, through APP_INTERCEPTOR: every route gets the header. Global interceptors also run for gateways and resolvers, which have no HTTP response. */
@Injectable()
class Stamp implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    if (context.getType() === "http") context.switchToHttp().getResponse<NestResponse>().headers.set("x-stamp", "1");
    return next.handle();
  }
}

@Controller("notes")
export class NotesController {
  constructor(private readonly viewer: Viewer) {}

  @Get()
  list(@Ctx() ctx: ActionCtx) {
    return ctx.runQuery(api.notes.list);
  }

  @Post()
  async add(@Ctx() ctx: ActionCtx, @Body() body: { text: string }) {
    return { id: await ctx.runMutation(api.notes.add, { text: body.text }) };
  }

  @Get("who")
  async who() {
    return { identity: await this.viewer.who() };
  }

  @Get("echo/:id")
  echo(@Param("id") id: string, @Query("x") x: string, @Headers("x-thing") thing: string) {
    return { id, x, thing };
  }

  @Get("plus/:n")
  plus(@Param("n", ParseIntPipe) n: number) {
    return { n: n + 1 };
  }

  @Get("secret")
  @UseGuards(KeyGuard)
  secret() {
    return { secret: true };
  }

  @Get("teapot")
  teapot() {
    throw new HttpException("short and stout", 418);
  }

  @Get("forge")
  forge() {
    throw new ForgeError({ code: "NOPE" });
  }

  @Get("boom")
  boom() {
    throw new Error("secret internal detail");
  }

  @Get("text")
  text() {
    return "plain";
  }

  @Get("raw")
  raw() {
    return new Response("raw body", { status: 202, headers: { "x-raw": "1" } });
  }

  @Get("wrapped")
  @UseInterceptors(Wrap)
  wrapped() {
    return 7;
  }

  @Get("file")
  file() {
    return new StreamableFile(Buffer.from("a,b\n1,2\n"), { type: "text/csv", disposition: 'attachment; filename="rows.csv"' });
  }

  @Get("away")
  @Redirect("/elsewhere", 302)
  away() {}
}

@Module({ controllers: [NotesController], providers: [Clock, Counter, NotesReader, NotesWriter, Viewer, KeyGuard, { provide: APP_INTERCEPTOR, useClass: Stamp }] })
export class NotesModule implements NestModule {
  configure(consumer: MiddlewareConsumer) {
    consumer.apply((_req: NestRequest, res: NestResponse, next: () => void) => (res.headers.set("x-middleware", "yes"), next())).forRoutes(NotesController);
  }
}
