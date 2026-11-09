// A basic NestJS HTTP adapter for archlast-serve's native App API, with no archlast-forge around it: Nest registers its routes here, and each request becomes
// a light context in, a `Reply` out (no Web Request or Response, no Express, no EventEmitters). It is what the benchmark needs and no more: JSON and text bodies,
// path params, the query string, headers, status codes and Nest's own exception filter; no static files, views, CORS, versioning or streaming.
import { EventEmitter } from "node:events";
import { BadRequestException } from "@nestjs/common";
import { AbstractHttpAdapter } from "@nestjs/core";
import { App, Reply, type Context } from "/engine/packages/serve/src/index.ts";

type Handler = (req: Req, res: Res, next: (err?: unknown) => void) => unknown;

/** What Nest's param decorators read: `params`, `query`, `body` and `headers`, taken from the context when asked for. */
class Req {
  constructor(
    private readonly c: Context,
    readonly method: string,
    readonly url: string,
  ) {}
  private _body?: unknown;
  private _read = false;
  get params() {
    return this.c.params;
  }
  get query() {
    return this.c.query;
  }
  get headers() {
    return Object.fromEntries(this.c.headers);
  }
  get body(): unknown {
    if (!this._read) {
      this._read = true;
      if (this.method !== "GET" && this.method !== "HEAD") {
        const text = this.c.text();
        if (text) {
          try {
            this._body = JSON.parse(text);
          } catch {
            throw new BadRequestException("The request body is not valid JSON");
          }
        }
      }
    }
    return this._body;
  }
}

class Res {
  statusCode = 200;
  private headers?: Record<string, string>;
  body: string | null = null;
  ended = false;
  set(name: string, value: string) {
    (this.headers ??= {})[name.toLowerCase()] = value;
  }
  get(name: string) {
    return this.headers?.[name.toLowerCase()];
  }
  get headersSent() {
    return this.ended;
  }
  toReply() {
    return new Reply(this.body, { status: this.statusCode, headers: this.headers ?? undefined });
  }
}

/** Nest's `instance`: the methods the adapter base class forwards `get`, `post` and the rest to. */
class Routes {
  readonly app = new App();
  private notFound?: Handler;
  private add(method: string, path: unknown, handler: unknown) {
    if (typeof path !== "string" || typeof handler !== "function") return;
    this.app.on(method, path, (c) => this.run(handler as Handler, c));
  }
  private async run(handler: Handler, c: Context): Promise<Reply> {
    const res = new Res();
    const req = new Req(c, c.method, c.url);
    await handler(req, res, () => {});
    return res.toReply();
  }
  get = (path: unknown, handler: unknown) => this.add("GET", path, handler);
  post = (path: unknown, handler: unknown) => this.add("POST", path, handler);
  put = (path: unknown, handler: unknown) => this.add("PUT", path, handler);
  patch = (path: unknown, handler: unknown) => this.add("PATCH", path, handler);
  delete = (path: unknown, handler: unknown) => this.add("DELETE", path, handler);
  options = (path: unknown, handler: unknown) => this.add("OPTIONS", path, handler);
  head = (path: unknown, handler: unknown) => this.add("HEAD", path, handler);
  all = (path: unknown, handler: unknown) => this.add("*", path, handler);
  setNotFound(handler: Handler) {
    this.notFound = handler;
  }
}

export class ArchlastNestAdapter extends AbstractHttpAdapter<unknown, Req, Res> {
  private readonly routes: Routes;
  private port = 0;
  constructor() {
    const routes = new Routes();
    super(routes);
    this.routes = routes;
  }

  // Nest calls these while it handles a request.
  reply(res: Res, body: unknown, statusCode?: number) {
    if (statusCode) res.statusCode = statusCode;
    res.ended = true;
    if (body === undefined || body === null) return;
    if (typeof body === "object") {
      if (!res.get("content-type")) res.set("content-type", "application/json; charset=utf-8");
      res.body = JSON.stringify(body);
    } else {
      if (!res.get("content-type")) res.set("content-type", "text/plain; charset=utf-8");
      res.body = String(body);
    }
  }
  status(res: Res, statusCode: number) {
    res.statusCode = statusCode;
  }
  end(res: Res, message?: string) {
    res.ended = true;
    if (message) res.body = message;
  }
  redirect(res: Res, statusCode: number, url: string) {
    res.statusCode = statusCode;
    res.set("location", url);
    res.ended = true;
  }
  isHeadersSent(res: Res) {
    return res.headersSent;
  }
  getHeader(res: Res, name: string) {
    return res.get(name);
  }
  setHeader(res: Res, name: string, value: string) {
    res.set(name, value);
  }
  appendHeader(res: Res, name: string, value: string) {
    res.set(name, value);
  }
  getRequestHostname(req: Req) {
    return req.headers.host ?? "";
  }
  getRequestMethod(req: Req) {
    return req.method;
  }
  getRequestUrl(req: Req) {
    return req.url;
  }

  // Nest calls these while it starts.
  setNotFoundHandler(handler: Function) {
    this.routes.setNotFound(handler as Handler);
  }
  setErrorHandler() {}
  registerParserMiddleware() {} // Req parses the body when a handler asks for it
  createMiddlewareFactory(): never {
    throw new Error("Nest middleware is not part of this adapter (use guards, pipes and interceptors)");
  }
  enableCors(): never {
    throw new Error("enableCors() is not part of this adapter");
  }
  applyVersionFilter(handler: Function) {
    return handler as never;
  }
  initHttpServer() {
    // Nest listens for its "error" event while it starts, and asks the server for its address once it listens.
    this.httpServer = Object.assign(new EventEmitter(), { address: () => ({ address: "0.0.0.0", family: "IPv4", port: this.port }) });
  }
  getType() {
    return "archlast-serve";
  }
  close() {}
  override listen(port: number | string, hostnameOrCb?: string | (() => void), maybeCb?: () => void) {
    const hostname = typeof hostnameOrCb === "string" ? hostnameOrCb : "0.0.0.0";
    this.port = Number(port);
    this.routes.app.listen({ port: this.port, hostname, threads: Number(process.env.THREADS ?? 3), workers: Number(process.env.WORKERS ?? 1), reusePort: process.env.REUSEPORT === "1", backend: (process.env.ARCHLAST_BACKEND as never) ?? "napi" });
    (typeof hostnameOrCb === "function" ? hostnameOrCb : maybeCb)?.();
  }
  useStaticAssets(): never {
    throw new Error("useStaticAssets() is not part of this adapter");
  }
  setViewEngine(): never {
    throw new Error("setViewEngine() is not part of this adapter");
  }
  render(): never {
    throw new Error("render() is not part of this adapter");
  }
}
