// NestJS inside archlast-forge: controllers served under /http, and services that queries, mutations and actions use with their own ctx.
// `nest(http, { controllers, providers })` in forge/http.ts mounts the app; `inject(ctx, Service)` resolves a service for a function call.
// Requests reach Nest through ForgeAdapter, which takes them from the engine's /http routing, and gateway sockets through the engine's
// server (onSocket): Nest never opens a server of its own. GraphQL, WebSocket gateways and microservices have their own entries.
import "reflect-metadata";
import {
  applyDecorators,
  BadRequestException,
  Catch,
  SetMetadata,
  UseInterceptors,
  type CallHandler,
  type NestInterceptor,
  Controller as NestController,
  Injectable as NestInjectable,
  createParamDecorator,
  Global,
  HttpException,
  Inject,
  Module,
  RequestMethod,
  Scope,
  StreamableFile,
  VersioningType,
  type ArgumentsHost,
  type DynamicModule,
  type ExecutionContext,
  type ForwardReference,
  type INestApplication,
  type LoggerService,
  type LogLevel,
  type NestApplicationOptions,
  type Provider,
  type Type,
  type VersioningOptions,
  type WsMessageHandler,
} from "@nestjs/common";
import { AbstractHttpAdapter, BaseExceptionFilter, ContextIdFactory, ModulesContainer, NestFactory, REQUEST } from "@nestjs/core";
import type { ContextId } from "@nestjs/core";
import type { MicroserviceOptions } from "@nestjs/microservices";
import { IoAdapter } from "@nestjs/platform-socket.io";
import { AbstractWsAdapter } from "@nestjs/websockets";
import cors from "cors";
import { Server as EngineServer } from "engine.io";
import { Server as IoServer, type ServerOptions as IoOptions } from "socket.io";
import { EventEmitter } from "node:events";
import { STATUS_CODES } from "node:http";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { match } from "path-to-regexp";
import { EMPTY, filter, fromEvent, mergeMap, Observable, takeUntil, type Subscription } from "rxjs";
import { httpAction, type ActionCtx, type HttpRoute, type MutationCtx, type QueryCtx, type UserIdentity } from "./functions";
import { queryValue } from "./server/http";
import { NEST_MOUNT, type NestRoute } from "./server/openapi";
import { validate, validateFields, ValidationError, type PropertyValidators, type Validator } from "./values";

export * from "@nestjs/common";
export { APP_FILTER, APP_GUARD, APP_INTERCEPTOR, APP_PIPE, BaseExceptionFilter, ModuleRef, Reflector } from "@nestjs/core";
export * as rxjs from "rxjs";
export type { ActionCtx, MutationCtx, QueryCtx } from "./functions";
/** What Nest's handlers and middleware get as `req` and `res`: Express's API on top of the engine's request (see the docs' NestJS page). */
export type { ForgeRequest as NestRequest, ForgeResponse as NestResponse };

type AnyCtx = QueryCtx | MutationCtx | ActionCtx;

/** Where the function's or request's ctx sits on the object Nest knows as the request (or the socket). */
const FORGE_CTX = Symbol.for("archlast-forge.ctx");
/** Marks a Response whose body is sent as it is written: the engine streams it instead of waiting for the end. */
const STREAM = Symbol.for("archlast-forge.stream");

/** What the engine's function runtime gives this module (runtime-core.ts sets it): a global, because the engine's copy of this package may not be the project's. */
interface EngineHost {
  identityOf(headers: Record<string, string>): Promise<UserIdentity | null>;
  actionCtx(identity: UserIdentity | null, requestId?: string): ActionCtx;
  wsSend(sid: string, data: string | ArrayBuffer): void;
  wsClose(sid: string, code?: number, reason?: string): void;
  /** Sends a PubSub event to every function runtime process (this one too). */
  relay(topic: string, payload: unknown): void;
}
const hostOf = () => (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.host")] as EngineHost | undefined;

/** The engine's telemetry (runtime-core.ts sets it): timing for the app's classes, and the matched route for the request. */
interface TelemetryBridge {
  wrap<T extends (...args: any[]) => any>(fn: T, name: string, attrs?: Record<string, string | number | boolean>): T;
  annotate(attrs: Record<string, string | number | boolean>, request?: boolean): void;
  entry?<T>(kind: "rpc" | "ws", operation: string, traceparent: string | undefined, fn: () => Promise<T>): Promise<T>;
}
const telemetry = () => (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.telemetry")] as TelemetryBridge | undefined;
const TIMED = Symbol.for("archlast-forge.timed");

/**
 * Times every method of one of the app's classes, so the dashboard shows where requests spend their time, class by class. Classes are the
 * app's when they are decorated through this package (libraries import Nest's decorators from @nestjs/* directly). It runs when the class
 * is decorated, before Nest binds route handlers to the methods; Nest keeps a handler's routes, guards and pipes as metadata on the method
 * itself, so the timed method carries the same metadata. `interceptor: false` leaves out the one that records transport messages, for a
 * transport that records them itself (Forge RPC).
 */
export function timeClass(target: Function, kind: string, interceptor = true) {
  const bridge = telemetry();
  const proto = target.prototype as Record<string | symbol, unknown> | undefined;
  if (!bridge || !proto || Object.hasOwn(proto, TIMED)) return;
  Object.defineProperty(proto, TIMED, { value: true });
  if (interceptor && (kind === "controller" || kind === "gateway")) UseInterceptors(EntryInterceptor)(target);
  for (const key of Object.getOwnPropertyNames(proto)) {
    const d = Object.getOwnPropertyDescriptor(proto, key);
    if (key === "constructor" || !d || typeof d.value !== "function" || !d.writable) continue;
    const original = d.value as (...args: unknown[]) => unknown;
    const timed = bridge.wrap(original, `${target.name}.${key}`, { "code.namespace": target.name, "code.function": key, "nest.kind": kind });
    for (const meta of Reflect.getOwnMetadataKeys(original)) Reflect.defineMetadata(meta, Reflect.getOwnMetadata(meta, original), timed);
    Object.defineProperty(timed, "name", { value: original.name });
    Object.defineProperty(proto, key, { ...d, value: timed });
  }
}

/**
 * A message from a microservice transport (Forge RPC, TCP, Redis, NATS, …) or to a gateway, recorded as a request of its own: kind `rpc` under
 * its pattern, kind `ws` as `Gateway:event`. HTTP requests aren't: the engine's server records those as they arrive. Values a handler
 * streams pass through as they come; the request ends with the stream.
 */
class EntryInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const bridge = telemetry();
    const type = context.getType<string>();
    if (!bridge?.entry || (type !== "rpc" && type !== "ws")) return next.handle();
    let operation: string;
    let incoming: string | undefined;
    if (type === "rpc") {
      const c = context.switchToRpc().getContext() as { getPattern?(): unknown; getChannel?(): unknown; getSubject?(): unknown; getTraceparent?(): string | undefined } | undefined;
      const pattern = c?.getPattern?.() ?? c?.getChannel?.() ?? c?.getSubject?.();
      operation = typeof pattern === "string" ? pattern : `${context.getClass().name}.${context.getHandler().name}`;
      incoming = c?.getTraceparent?.();
    } else operation = `${context.getClass().name}:${String(Reflect.getMetadata("message", context.getHandler()) ?? context.getHandler().name)}`;
    return new Observable((subscriber) => {
      let inner: Subscription | undefined;
      // next.handle() inside the call: Nest binds the handler to the async context it is asked in, which is then this request's.
      bridge
        .entry!(type, operation, incoming, () => new Promise<void>((resolve, reject) => (inner = next.handle().subscribe({ next: (v) => subscriber.next(v), error: reject, complete: resolve }))))
        .then(
          () => subscriber.complete(),
          (e) => subscriber.error(e),
        );
      return () => inner?.unsubscribe();
    });
  }
}

/** Nest's `@Injectable()`, timing the class's methods (see timeClass). */
export const Injectable = ((options?: Parameters<typeof NestInjectable>[0]) => {
  const decorate = NestInjectable(options);
  return (target: Function) => {
    timeClass(target, "provider");
    return decorate(target);
  };
}) as typeof NestInjectable;

/** Nest's `@Controller()`, timing the class's handlers (see timeClass). */
export const Controller = ((...args: unknown[]) => {
  const decorate = (NestController as (...a: unknown[]) => ClassDecorator)(...args);
  return (target: Function) => {
    timeClass(target, "controller");
    return decorate(target);
  };
}) as typeof NestController;
const engine = () => {
  const host = hostOf();
  if (!host) throw new Error("This needs the archlast-forge engine (archlast-forge dev or start); createTestBackend runs functions only");
  return host;
};
/** Which function runtime process this is: 0 inline, or the first of a pool. Things that must exist once per server start only there. */
const firstWorker = () => Number(process.env.ARCHLAST_WORKER ?? 0) === 0;

/** The injection token for the ctx of the call a request-scoped provider serves: `@InjectCtx()` or `@Inject(CTX)`. */
export const CTX = Symbol.for("archlast-forge.CTX");
export const InjectCtx = () => Inject(CTX);

/**
 * A handler's parameter that receives its ActionCtx: an HTTP request's, a gateway socket's or a GraphQL operation's (the caller's
 * identity), or for a microservice message, which has no caller, an anonymous one. `get(@Ctx() ctx: ActionCtx)`.
 */
export const Ctx = createParamDecorator((_data: unknown, host: ExecutionContext): ActionCtx => {
  const type = host.getType<string>();
  const holder = type === "http" ? host.switchToHttp().getRequest() : type === "ws" ? host.switchToWs().getClient() : type === "graphql" ? host.getArgs()[2]?.req : undefined;
  return holder?.[FORGE_CTX] ?? holder?.request?.[FORGE_CTX] ?? engine().actionCtx(null); // a Socket.IO socket has it on its request
});

/**
 * A PubSub whose events reach every function runtime process: `publish(topic, payload)` anywhere (a mutation, a controller), and
 * `subscribe(topic)` (an async iterator, which a GraphQL subscription resolver returns) or `on(topic, listener)` where you listen.
 * With RUNTIME_WORKERS > 1 an event published by one worker is heard by subscribers in all of them. Payloads must be structured-cloneable.
 */
export function createPubSub<Topics extends Record<string, unknown> = Record<string, unknown>>() {
  return {
    publish<K extends keyof Topics & string>(topic: K, payload: Topics[K]) {
      const host = hostOf();
      if (host) host.relay(topic, payload);
      else deliver(topic, payload); // createTestBackend: one process, no engine
    },
    on<K extends keyof Topics & string>(topic: K, listener: (payload: Topics[K]) => void) {
      const set = listeners.get(topic) ?? listeners.set(topic, new Set()).get(topic)!;
      set.add(listener as (payload: unknown) => void);
      return () => void set.delete(listener as (payload: unknown) => void);
    },
    subscribe<K extends keyof Topics & string>(topic: K): AsyncIterableIterator<Topics[K]> {
      const queue: Topics[K][] = [];
      let wake: (() => void) | undefined;
      let done = false;
      const off = this.on(topic, (payload) => (queue.push(payload), wake?.()));
      return {
        [Symbol.asyncIterator]() {
          return this;
        },
        async next() {
          while (!queue.length && !done) await new Promise<void>((r) => (wake = r));
          return queue.length ? { value: queue.shift()!, done: false } : { value: undefined, done: true };
        },
        async return() {
          done = true;
          off();
          wake?.();
          return { value: undefined, done: true };
        },
      };
    },
  };
}

const listeners = new Map<string, Set<(payload: unknown) => void>>();
const deliver = (topic: string, payload: unknown) => listeners.get(topic)?.forEach((listener) => listener(payload));
// Relayed events from the engine (runtime-core.ts reads this).
(globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.relay")] = (msg: { topic: string; payload: unknown }) => deliver(msg.topic, msg.payload);

/**
 * A service that works with the ctx of the call it serves, as `this.ctx`. Say which ctx it needs: `ForgeService<QueryCtx>` reads,
 * `ForgeService<MutationCtx>` writes. `inject(ctx, Service)` only accepts a ctx that has what the service needs.
 * It is request-scoped: an instance per call, and so is anything that injects it.
 */
export abstract class ForgeService<C extends AnyCtx = AnyCtx> {
  protected readonly ctx!: C;
}
Inject(CTX)(ForgeService.prototype, "ctx");

/** Gives every provider the CTX token: what `inject()` or the HTTP request put on Nest's request object, or for a microservice message an anonymous ActionCtx. */
class ForgeCtxModule {}
Global()(ForgeCtxModule);
Module({
  providers: [{ provide: CTX, scope: Scope.REQUEST, inject: [REQUEST], useFactory: (req: Record<symbol, unknown> | undefined) => req?.[FORGE_CTX] ?? engine().actionCtx(null) }],
  exports: [CTX],
})(ForgeCtxModule);

export interface NestOptions {
  controllers?: Type[];
  providers?: Provider[];
  imports?: (Type | DynamicModule | Promise<DynamicModule> | ForwardReference)[];
  /**
   * Where the controllers and gateways are served, below /http (and at the root as well with `httpRouter({ root: true })`). Default "/":
   * `@Controller("users")` answers at /http/users. With a root router, `prefix: "/api/"` serves `@Controller("users")` at /api/users.
   */
  prefix?: string;
  /** CORS for the controllers, as Nest's `enableCors()` takes it: `true`, the options of the `cors` package, or a function of the request. */
  cors?: NestApplicationOptions["cors"];
  /** Microservice transports the app also listens on (TCP, Redis, NATS, MQTT, gRPC, Kafka, RabbitMQ), as `app.connectMicroservice()` takes them. */
  microservices?: MicroserviceOptions[];
  /** Anything else on the app before it starts: `app.useGlobalPipes()`, `app.enableVersioning()`, `app.setGlobalPrefix()`. */
  setup?: (app: INestApplication) => void | Promise<void>;
  /** The protocol of the app's WebSocket gateways: "ws" (@nestjs/platform-ws's JSON `{ event, data }`, the default) or "socket.io". */
  websockets?: "ws" | "socket.io";
  /** Nest's own log output. Default: errors and warnings. */
  logger?: LoggerService | LogLevel[] | false;
}

interface Started {
  app: INestApplication;
  adapter: ForgeAdapter;
}
let started: Promise<Started> | undefined;
let mountPrefix = "/";

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"] as const;

/**
 * Mounts a Nest application in forge/http.ts: its controllers answer under `prefix` (every method), its gateways take WebSockets there,
 * and its providers are what `inject()` resolves in functions. Routes added with `http.route()` keep priority: exact paths win, then the
 * longest prefix.
 */
export function nest(http: { route(spec: HttpRoute): void; root?: boolean }, options: NestOptions | Type) {
  if (started) throw new Error("nest() is called once, in forge/http.ts: put every controller and provider in that one call (or in modules it imports)");
  const o: NestOptions = typeof options === "function" ? { imports: [options] } : options;
  const prefix = (mountPrefix = o.prefix ?? "/");
  if (!prefix.startsWith("/") || !prefix.endsWith("/")) throw new Error(`nest() prefix must start and end with "/", got "${prefix}"`);

  class AppModule {}
  Module({ imports: [ForgeCtxModule, ...(o.imports ?? [])], controllers: o.controllers ?? [], providers: o.providers ?? [] })(AppModule);
  (globalThis as Record<symbol, unknown>)[SOCKETS] = dispatch;
  started = (async () => {
    const adapter = new ForgeAdapter(prefix);
    // abortOnError: false, or a wiring mistake would end the whole process instead of failing the calls that need it.
    const app = await NestFactory.create<INestApplication>(AppModule, adapter, { logger: o.logger ?? ["error", "warn"], bodyParser: false, abortOnError: false, cors: o.cors });
    app.useWebSocketAdapter(o.websockets === "socket.io" ? new ForgeIoAdapter(app, adapter) : new ForgeWsAdapter(app));
    app.useGlobalFilters(new ForgeExceptionFilter(adapter));
    // One listener per server: in a pool of function runtime processes only the first connects, so a port is bound once and a message handled once.
    const microservices = firstWorker() ? (o.microservices ?? []) : [];
    for (const m of microservices) app.connectMicroservice(m);
    await o.setup?.(app);
    await app.init();
    if (microservices.length) await app.startAllMicroservices();
    return { app, adapter };
  })();
  started.catch(() => {}); // reported to every call that needs the app

  const handler = httpAction(async (ctx, request) => (await started!).adapter.handle(request, ctx));
  (handler as unknown as Record<symbol, unknown>)[NEST_MOUNT] = true;
  for (const method of METHODS) http.route({ method, pathPrefix: prefix, handler });
  (globalThis as Record<symbol, unknown>)[NEST_ROUTES] = async () => routesOf((await started!).app, http.root ? prefix : `/http${prefix}`);
}

/**
 * A route's contract, in the engine's validators: checked on every request before the handler runs (a mismatch answers 400 with the reason),
 * and described in the OpenAPI document, so the two can't drift. `params` and `query` values arrive as text and are converted the way
 * /http routes convert theirs.
 *
 *     @Post(":id/items") @Contract({ params: { id: v.string() }, body: v.object({ sku: v.string(), qty: v.number() }), returns: v.object({ ok: v.boolean() }) })
 */
export interface ContractSpec {
  body?: Validator;
  query?: PropertyValidators;
  params?: PropertyValidators;
  returns?: Validator;
  summary?: string;
  description?: string;
  tags?: string[];
}
const CONTRACT = "archlast-forge:contract";
const NEST_ROUTES = Symbol.for("archlast-forge.nest-routes");

class ContractInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler) {
    const spec = Reflect.getMetadata(CONTRACT, context.getHandler()) as ContractSpec | undefined;
    if (spec) {
      const req = context.switchToHttp().getRequest<ForgeRequest>();
      const fromText = (fields: PropertyValidators, given: Record<string, string | string[] | undefined>) =>
        Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, given[k] === undefined ? undefined : queryValue(v, [given[k]!].flat())]));
      try {
        if (spec.params) validateFields(spec.params, fromText(spec.params, req.params), "params");
        if (spec.query) validateFields(spec.query, fromText(spec.query, req.query), "query");
        if (spec.body) validate(spec.body, req.body, "body");
      } catch (e) {
        if (e instanceof ValidationError) throw new BadRequestException(e.message);
        throw e;
      }
    }
    return next.handle();
  }
}
NestInjectable()(ContractInterceptor);

export const Contract = (spec: ContractSpec) => applyDecorators(SetMetadata(CONTRACT, spec), UseInterceptors(ContractInterceptor));

/** Every controller route of the app, from Nest's own metadata (paths, methods) and @Contract: what the OpenAPI document lists. */
function routesOf(app: INestApplication, prefix: string): NestRoute[] {
  const routes: NestRoute[] = [];
  const join = (...parts: string[]) => "/" + parts.map((p) => p.replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  // Nest's PATH_METADATA and METHOD_METADATA keys, as @nestjs/common's constants define them.
  for (const module of app.get(ModulesContainer, { strict: false }).values())
    for (const wrapper of module.controllers.values()) {
      const cls = wrapper.metatype as Type | undefined;
      if (!cls?.prototype) continue;
      const bases = [Reflect.getMetadata("path", cls) ?? "/"].flat() as string[];
      for (const key of Object.getOwnPropertyNames(cls.prototype)) {
        const fn = (cls.prototype as Record<string, unknown>)[key];
        if (key === "constructor" || typeof fn !== "function") continue;
        const method = Reflect.getMetadata("method", fn) as RequestMethod | undefined;
        const paths = Reflect.getMetadata("path", fn) as string | string[] | undefined;
        if (method === undefined || paths === undefined || !METHOD_NAMES[method]) continue;
        for (const base of bases)
          for (const p of [paths].flat()) routes.push({ method: METHOD_NAMES[method]!, path: join(prefix, base, p), name: `${cls.name}.${key}`, contract: Reflect.getMetadata(CONTRACT, fn) });
      }
    }
  return routes;
}

const contexts = new WeakMap<object, ContextId>();
type NeededCtx<T> = T extends ForgeService<infer C> ? C : AnyCtx;

/**
 * A provider for this call, with `ctx` as its ctx: `const users = await inject(ctx, UsersService)`. Request-scoped providers are made
 * once per call (two `inject`s with the same ctx share them); singletons are the same instance everywhere.
 */
export async function inject<T extends object>(ctx: NeededCtx<T>, type: Type<T>): Promise<T> {
  if (!started) throw new Error(`inject(${type.name}): no Nest application. Mount one in forge/http.ts with nest(http, { providers: [${type.name}] })`);
  const { app } = await started;
  let id = contexts.get(ctx);
  if (!id) {
    id = ContextIdFactory.create();
    app.registerRequestByContextId({ [FORGE_CTX]: ctx }, id);
    contexts.set(ctx, id);
  }
  return app.resolve(type, id, { strict: false });
}

/** HttpExceptions answer as Nest answers them. Anything else goes back to the engine, which treats it like an HTTP action's error. */
class ForgeExceptionFilter extends BaseExceptionFilter {
  override catch(exception: unknown, host: ArgumentsHost) {
    if (host.getType() !== "http") throw exception; // a resolver's or a gateway's: GraphQL and the gateway report it themselves
    if (exception instanceof HttpException) return super.catch(exception, host);
    host.switchToHttp().getResponse<ForgeResponse>().fail(exception);
  }
}
Catch()(ForgeExceptionFilter);

// ---- sockets: gateways, GraphQL subscriptions, and anything registered with onSocket() ----

/** Where the engine's runtime hands socket events (runtime-core.ts reads it). */
const SOCKETS = Symbol.for("archlast-forge.sockets");
/** Paths below /http that take WebSockets, and what to do with a socket that opens there. */
const socketPaths = new Map<string, (socket: ForgeSocket) => void>();
const openSockets = new Map<string, ForgeSocket>();
const joinPath = (prefix: string, path: string) => (prefix + path.replace(/^\/+/, "")).replace(/(.)\/$/, "$1");

/**
 * Takes WebSockets at `path` below /http and the mount prefix: `onSocket("/live", (socket) => ...)` answers ws://host/http/live. Gateways
 * and GraphQL subscriptions are built on it. The socket has the ws package's `send`, `close`, `readyState` and "message" and "close" events.
 */
export function onSocket(path: string, open: (socket: ForgeSocket) => void) {
  socketPaths.set(joinPath(mountPrefix, path), open);
}

type SocketEvent = { op: "open"; sid: string; path: string; headers: [string, string][]; requestId?: string } | { op: "message"; sid: string; data: string | ArrayBuffer } | { op: "close"; sid: string; code: number; reason: string };

function dispatch(msg: SocketEvent) {
  const host = engine();
  if (msg.op === "open") {
    const open = socketPaths.get(new URL(msg.path, "http://x").pathname.replace(/(.)\/$/, "$1")); // "/socket.io/" is "/socket.io"
    if (!open) return host.wsClose(msg.sid, 1008, "No WebSocket gateway at this path");
    const socket = new ForgeSocket(msg.sid, host, msg.path, Object.fromEntries(msg.headers));
    openSockets.set(msg.sid, socket);
    // The caller is resolved once, from the upgrade request's cookie or token; messages wait for it.
    socket.ready = host.identityOf(socket.request.headers).then(
      (identity) => ((socket[FORGE_CTX] = host.actionCtx(identity, msg.requestId)), open(socket)),
      (e) => (console.error(e), socket.close(1011, "Server error")),
    );
    return;
  }
  const socket = openSockets.get(msg.sid);
  if (!socket) return;
  if (msg.op === "message") void socket.ready.then(() => socket.emit("message", typeof msg.data === "string" ? msg.data : Buffer.from(msg.data)));
  else {
    openSockets.delete(msg.sid);
    void socket.ready.then(() => ((socket.readyState = 3), socket.emit("close", msg.code, msg.reason)));
  }
}

/** A WebSocket the engine's server holds, as the ws package's client looks: `send`, `close`, `readyState`, and "message" and "close" events. */
export class ForgeSocket extends EventEmitter {
  /** 1 while open, 2 while closing, 3 closed (the ws package's numbers). */
  readyState = 1;
  ready: Promise<unknown> = Promise.resolve();
  readonly request: { url: string; headers: Record<string, string> };
  /** The subprotocol the client asked for first, which the engine accepted. */
  readonly protocol: string;
  [FORGE_CTX]?: ActionCtx;

  constructor(
    readonly id: string,
    private readonly host: EngineHost,
    url: string,
    headers: Record<string, string>,
  ) {
    super();
    this.request = { url, headers };
    this.protocol = headers["sec-websocket-protocol"]?.split(",")[0]?.trim() ?? "";
  }

  send(data: string | ArrayBuffer | Uint8Array) {
    if (this.readyState !== 1) return;
    this.host.wsSend(this.id, typeof data === "string" || data instanceof ArrayBuffer ? data : (data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) as ArrayBuffer));
  }

  close(code = 1000, reason = "") {
    if (this.readyState > 1) return;
    this.readyState = 2;
    this.host.wsClose(this.id, code, reason);
  }

  /** Nest's gateway exception filter "emits" an exception on the client: it is sent, as `{ "event": "exception", "data": ... }`. */
  override emit(event: string | symbol, ...args: unknown[]) {
    if (event === "exception") this.send(JSON.stringify({ event, data: args[0] }));
    return super.emit(event, ...args);
  }
}

/** One per gateway path: the clients connected there (as the ws package's server has them). */
class GatewayServer extends EventEmitter {
  readonly clients = new Set<ForgeSocket>();
  constructor(readonly path: string) {
    super();
  }
  close() {
    for (const client of this.clients) client.close(1001, "The server is shutting down");
  }
}

/** Nest's WebSocket adapter for archlast-forge, speaking @nestjs/platform-ws's protocol: `{ "event": "...", "data": ... }` messages, and a handler's return value sent back as JSON. */
class ForgeWsAdapter extends AbstractWsAdapter {
  private readonly servers = new Map<string, GatewayServer>();

  create(_port: number, options?: { path?: string }) {
    const path = options?.path ?? "/";
    let server = this.servers.get(path);
    if (!server) {
      const created = (server = new GatewayServer(path));
      this.servers.set(path, created);
      onSocket(path, (socket) => {
        created.clients.add(socket);
        socket.on("close", () => created.clients.delete(socket));
        created.emit("connection", socket, socket.request);
      });
    }
    return server;
  }

  bindMessageHandlers(client: ForgeSocket, handlers: WsMessageHandler[], transform: (data: unknown) => Observable<unknown>) {
    fromEvent(client, "message")
      .pipe(
        mergeMap((raw) => {
          let message: { event?: string; data?: unknown };
          try {
            message = JSON.parse(String(raw));
          } catch {
            return EMPTY;
          }
          const handler = handlers.find((h) => h.message === message?.event);
          return handler ? transform(handler.callback(message.data, message.event)) : EMPTY;
        }),
        filter((response) => response !== undefined && response !== null),
        takeUntil(fromEvent(client, "close")),
      )
      .subscribe((response) => client.send(JSON.stringify(response)));
  }

  override async close(server: GatewayServer) {
    server.close();
  }
}

// ---- Socket.IO (nest(http, { websockets: "socket.io" })) ----

/** The ForgeSocket behind an engine.io upgrade request. */
const FORGE_SOCKET = Symbol("forge.socket");

/** A ForgeSocket as engine.io's WebSocket transport uses the ws package's: `send(data, opts, cb)`, and "message" with `(data, isBinary)`. */
class EioSocket extends EventEmitter {
  readonly _socket: { remoteAddress: string };
  constructor(private readonly forge: ForgeSocket) {
    super();
    this._socket = { remoteAddress: forge.request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "" };
    forge.on("message", (data: string | Buffer) => this.emit("message", typeof data === "string" ? Buffer.from(data) : data, typeof data !== "string"));
    forge.on("close", (code: number, reason: string) => this.emit("close", code, reason));
  }
  get readyState() {
    return this.forge.readyState;
  }
  send(data: string | Uint8Array, options?: unknown, cb?: (err?: Error) => void) {
    this.forge.send(data);
    (typeof options === "function" ? (options as (err?: Error) => void) : cb)?.();
  }
  close(code?: number, reason?: string) {
    this.forge.close(code, reason);
  }
  terminate() {
    this.forge.close(1001, "Terminated");
  }
}

/** engine.io's `wsEngine`: the engine's server already upgraded the socket, so the "upgrade" hands over the socket that came with the request. */
class ForgeWsEngine {
  handleUpgrade(req: Record<symbol, ForgeSocket>, _socket: unknown, _head: unknown, done: (ws: EioSocket) => void) {
    done(new EioSocket(req[FORGE_SOCKET]!));
  }
  on() {}
  close() {}
}

/**
 * Nest's Socket.IO adapter, with Socket.IO's server on engine.io fed by the engine's sockets (and, for clients that start with
 * long-polling, by the HTTP adapter). Namespaces, rooms, acks and broadcasts are Nest's and Socket.IO's own.
 */
class ForgeIoAdapter extends IoAdapter {
  constructor(
    app: INestApplication,
    private readonly http: ForgeAdapter,
  ) {
    super(app);
  }

  override createIOServer(_port: number, options?: Partial<IoOptions>) {
    const path = (options?.path ?? "/socket.io").replace(/(.)\/$/, "$1");
    const { pingInterval, pingTimeout, maxHttpBufferSize, allowRequest, cors, transports } = options ?? {};
    const given = Object.fromEntries(Object.entries({ pingInterval, pingTimeout, maxHttpBufferSize, allowRequest, cors, transports }).filter(([, v]) => v !== undefined)); // an undefined would replace engine.io's default
    const engine = new EngineServer({
      ...given,
      httpCompression: false, // the engine's server and proxies compress
      perMessageDeflate: false,
      wsEngine: ForgeWsEngine,
    });
    const io = new IoServer(options ?? {});
    io.bind(engine as never);
    onSocket(path, (socket) => {
      const req = {
        method: "GET",
        url: socket.request.url,
        headers: socket.request.headers,
        connection: { remoteAddress: socket.request.headers["x-forwarded-for"]?.split(",")[0]?.trim() ?? "", encrypted: false },
        [FORGE_CTX]: socket[FORGE_CTX],
        [FORGE_SOCKET]: socket,
      };
      engine.handleUpgrade(req as never, { write: () => true, destroy: () => socket.close(1008, "Refused"), end: () => {} } as never, Buffer.alloc(0));
    });
    // Long-polling: the HTTP requests at the same path. engine.io reads a POST's body from "data" and "end" events, which the parsed request gets now.
    this.http.all(path, (req: ForgeRequest, res: ForgeResponse) => {
      engine.handleRequest(req as never, res as never);
      setImmediate(() => (req.rawBody?.length && req.emit("data", req.encoding ? req.rawBody.toString(req.encoding) : req.rawBody), req.emit("end")));
    });
    return io;
  }
}

// ---- the HTTP adapter ----

const bytes = (chunk: unknown, encoding?: BufferEncoding) =>
  chunk instanceof Uint8Array ? chunk : chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : Buffer.from(String(chunk), typeof encoding === "string" ? encoding : "utf8");
/** "json" → application/json, as Express's `res.type()` does. */
const mime = (type: string) => (type.includes("/") ? type : Bun.file(`x.${type.replace(/^\./, "")}`).type);

const toObject = (params: URLSearchParams) => {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of params) out[k] = k in out ? [...[out[k]!].flat(), v] : v;
  return out;
};

/** What Nest's handlers see as `req`: the parts its decorators read (`@Body`, `@Query`, `@Param`, `@Headers`, `@Req`), Express's helpers, and the Web Request. */
class ForgeRequest extends EventEmitter {
  readonly url: string;
  readonly originalUrl: string;
  readonly baseUrl = "";
  readonly hostname: string;
  readonly protocol: string;
  readonly headers: Record<string, string>;
  readonly query: Record<string, string | string[]>;
  readonly cookies: Record<string, string>;
  /** Node's connection, as engine.io reads it; the engine's server knows the address, which isn't passed on. */
  readonly connection = { remoteAddress: "", encrypted: false };
  /** What Node's `setEncoding()` asked for: "data" events then carry strings. */
  encoding?: BufferEncoding;
  setEncoding(encoding: BufferEncoding) {
    this.encoding = encoding;
    return this;
  }
  params: Record<string, string> = {};
  [FORGE_CTX]: ActionCtx;

  constructor(
    readonly raw: Request,
    readonly method: string,
    readonly path: string,
    readonly body: unknown,
    readonly rawBody: Buffer | undefined,
    ctx: ActionCtx,
  ) {
    super();
    const url = new URL(raw.url);
    this.url = this.originalUrl = path + url.search;
    this.hostname = url.hostname;
    this.headers = Object.fromEntries(raw.headers);
    this.protocol = this.headers["x-forwarded-proto"]?.split(",")[0]?.trim() || url.protocol.slice(0, -1);
    this.query = toObject(url.searchParams);
    this.cookies = Object.fromEntries(new Bun.CookieMap(this.headers.cookie ?? ""));
    this[FORGE_CTX] = ctx;
  }
  get secure() {
    return this.protocol === "https";
  }
  get xhr() {
    return this.headers["x-requested-with"]?.toLowerCase() === "xmlhttprequest";
  }
  get(name: string) {
    return this.headers[name.toLowerCase()];
  }
  header(name: string) {
    return this.get(name);
  }
}

type CookieOptions = { maxAge?: number; expires?: Date; path?: string; domain?: string; secure?: boolean; httpOnly?: boolean; sameSite?: "strict" | "lax" | "none" | boolean; partitioned?: boolean };

/**
 * What Nest's handlers see as `res`: Express's response API (`status().json()`, `send`, `set`, `cookie`, `redirect`) and Node's
 * (`setHeader`, `write`, `end`). A response is sent when it ends, unless `write()` or `flushHeaders()` started it earlier: then it streams.
 */
class ForgeResponse extends EventEmitter {
  statusCode = 200;
  statusMessage = "";
  readonly headers = new Headers();
  readonly locals: Record<string, unknown> = {};
  body: BodyInit | null = null;
  writableEnded = false;
  error: unknown;
  request?: ForgeRequest;
  private readable?: ReadableStream<Uint8Array>;
  private stream?: ReadableStreamDefaultController<Uint8Array>;
  private resolve!: () => void;
  /** Resolves when the response is ready to go: ended, or streaming. */
  readonly done = new Promise<void>((r) => (this.resolve = r));

  get headersSent() {
    return Boolean(this.readable) || this.writableEnded;
  }
  get finished() {
    return this.writableEnded;
  }

  /** Sends the head now, and the body as it is written. */
  flushHeaders() {
    if (this.readable || this.writableEnded) return;
    this.readable = new ReadableStream<Uint8Array>({
      start: (c) => void (this.stream = c),
      cancel: () => {
        // The client went away (shortcut: noticed only with functions inline in the server, the production default; through a child process the writes go on until the handler stops).
        this.writableEnded = true;
        this.emit("close");
        this.request?.emit("close");
      },
    });
    this.resolve();
  }
  write(chunk: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) {
    if (this.writableEnded) return false;
    this.flushHeaders();
    this.stream!.enqueue(bytes(chunk, typeof encoding === "string" ? encoding : undefined));
    (typeof encoding === "function" ? encoding : cb)?.();
    return true;
  }
  end(chunk?: unknown, encoding?: BufferEncoding | (() => void), cb?: () => void) {
    if (this.writableEnded) return this;
    if (typeof chunk === "function") [cb, chunk] = [chunk as () => void, undefined];
    const done = typeof encoding === "function" ? encoding : cb;
    if (this.readable) {
      if (chunk !== undefined && chunk !== null) this.stream!.enqueue(bytes(chunk, typeof encoding === "string" ? encoding : undefined));
      this.stream!.close();
    } else if (chunk !== undefined && chunk !== null) this.body = typeof chunk === "string" || chunk instanceof Uint8Array || chunk instanceof ArrayBuffer ? (chunk as BodyInit) : String(chunk);
    this.writableEnded = true;
    this.resolve();
    this.emit("finish");
    this.emit("close");
    done?.();
    return this;
  }
  fail(error: unknown) {
    this.error = error;
    this.stream?.error(error);
    this.writableEnded = true;
    this.resolve();
  }

  status(code: number) {
    this.statusCode = code;
    return this;
  }
  sendStatus(code: number) {
    return this.status(code).type("txt").send(STATUS_CODES[code] ?? String(code));
  }
  setHeader(name: string, value: string | number | readonly string[]) {
    this.headers.delete(name);
    for (const v of [value].flat()) this.headers.append(name, String(v));
    return this;
  }
  getHeader(name: string) {
    return this.headers.get(name) ?? undefined;
  }
  getHeaders() {
    return Object.fromEntries(this.headers);
  }
  getHeaderNames() {
    return [...this.headers.keys()];
  }
  hasHeader(name: string) {
    return this.headers.has(name);
  }
  removeHeader(name: string) {
    this.headers.delete(name);
  }
  writeHead(code: number, message?: string | Record<string, string | string[]>, headers?: Record<string, string | string[]>) {
    if (typeof message !== "string") [headers, message] = [message, undefined];
    this.statusCode = code;
    if (message) this.statusMessage = message;
    for (const [k, v] of Object.entries(headers ?? {})) this.setHeader(k, v);
    return this;
  }
  set(field: string | Record<string, string | string[]>, value?: string | string[]) {
    if (typeof field === "object") for (const [k, v] of Object.entries(field)) this.set(k, v);
    else this.setHeader(field, field.toLowerCase() === "content-type" ? mime(String(value)) : (value ?? ""));
    return this;
  }
  header(field: string | Record<string, string | string[]>, value?: string | string[]) {
    return this.set(field, value);
  }
  get(field: string) {
    return this.getHeader(field);
  }
  append(field: string, value: string | string[]) {
    for (const v of [value].flat()) this.headers.append(field, v);
    return this;
  }
  type(type: string) {
    return this.setHeader("content-type", mime(type));
  }
  contentType(type: string) {
    return this.type(type);
  }
  location(url: string) {
    return this.setHeader("location", url);
  }
  vary(field: string) {
    this.headers.append("vary", field);
    return this;
  }
  attachment(filename?: string) {
    if (filename && !this.headers.has("content-type")) this.type(filename.split(".").pop() ?? "bin");
    return this.setHeader("content-disposition", filename ? `attachment; filename="${basename(filename)}"` : "attachment");
  }
  /** Express's `res.cookie()`: `maxAge` is in milliseconds, and an object value is sent as `j:` and its JSON. */
  cookie(name: string, value: unknown, options: CookieOptions = {}) {
    const { maxAge, sameSite, ...rest } = options;
    const timing = maxAge === undefined ? {} : { maxAge: Math.floor(maxAge / 1000), expires: new Date(Date.now() + maxAge) };
    const same = sameSite === true ? "strict" : sameSite === false ? undefined : sameSite;
    this.headers.append("set-cookie", new Bun.Cookie(name, typeof value === "string" ? value : `j:${JSON.stringify(value)}`, { path: "/", ...rest, ...timing, sameSite: same }).serialize());
    return this;
  }
  clearCookie(name: string, options: CookieOptions = {}) {
    return this.cookie(name, "", { ...options, maxAge: undefined, expires: new Date(1) });
  }
  json(body: unknown) {
    if (!this.headers.has("content-type")) this.headers.set("content-type", "application/json; charset=utf-8");
    return this.end(JSON.stringify(body));
  }
  /** Express's `res.send()`: an object as JSON, a string as HTML, bytes as they are. */
  send(body?: unknown) {
    if (body === undefined || body === null) return this.end();
    if (typeof body === "string") {
      if (!this.headers.has("content-type")) this.headers.set("content-type", "text/html; charset=utf-8");
      return this.end(body);
    }
    if (body instanceof Uint8Array || body instanceof ArrayBuffer) {
      if (!this.headers.has("content-type")) this.headers.set("content-type", "application/octet-stream");
      return this.end(body);
    }
    return this.json(body);
  }
  redirect(status: number | string, url?: string) {
    const [code, to] = typeof status === "number" ? [status, url!] : [302, status];
    return this.status(code).location(to).end();
  }

  toResponse() {
    const empty = this.statusCode === 204 || this.statusCode === 304;
    const body = this.readable ?? (empty ? null : this.body);
    const res = new Response(body, { status: this.statusCode, statusText: this.statusMessage || undefined, headers: this.headers });
    if (body instanceof ReadableStream) (res as unknown as Record<symbol, boolean>)[STREAM] = true;
    return res;
  }
}

type Handler = (req: ForgeRequest, res: ForgeResponse, next: (err?: unknown) => void) => unknown;
interface Layer {
  method?: string;
  matches: (path: string) => false | { params: Record<string, string> };
  handler: Handler;
  route: boolean;
  /** The path as the route was declared (`/users/:id`). */
  pattern: string;
}

/** The `instance` Nest's adapter base class hands routes to: an Express-style list of layers, run in order. */
class Router {
  readonly layers: Layer[] = [];
  private layer(method: string | undefined, route: boolean, args: unknown[]): Layer {
    const [path, handler] = (typeof args[0] === "function" ? ["/", args[0]] : args) as [string, Handler];
    // Middleware at the root runs for every path: path-to-regexp's prefix match needs a "/" after "/", so it would match only "/".
    const test = !route && (path === "/" || path === "") ? () => ({ params: {} }) : match(path, { decode: decodeURIComponent, end: route });
    return { method, route, handler, pattern: path || "/", matches: (p) => test(p) as false | { params: Record<string, string> } };
  }
  private add(method: string | undefined, route: boolean, args: unknown[]) {
    this.layers.push(this.layer(method, route, args));
  }
  use = (...args: unknown[]) => this.add(undefined, false, args);
  all = (...args: unknown[]) => this.add(undefined, true, args);
  get = (...args: unknown[]) => this.add("GET", true, args);
  post = (...args: unknown[]) => this.add("POST", true, args);
  put = (...args: unknown[]) => this.add("PUT", true, args);
  patch = (...args: unknown[]) => this.add("PATCH", true, args);
  delete = (...args: unknown[]) => this.add("DELETE", true, args);
  options = (...args: unknown[]) => this.add("OPTIONS", true, args);
  head = (...args: unknown[]) => this.add("HEAD", true, args);
  middleware(method: string | undefined, path: string, handler: Handler) {
    this.add(method, false, [path, handler]);
  }
  /** Ahead of every route, as CORS has to be. */
  first(handler: Handler) {
    this.layers.unshift(this.layer(undefined, false, [handler]));
  }
}

const unsupported = (what: string) => new Error(`${what} is not available for Nest inside archlast-forge`);

/** The body as Express's parsers would leave it: JSON parsed, forms as an object, text as a string, anything else as bytes. */
async function readBody(request: Request): Promise<{ body: unknown; rawBody?: Buffer }> {
  if (request.method === "GET" || request.method === "HEAD" || !request.body) return { body: undefined };
  const rawBody = Buffer.from(await request.arrayBuffer());
  if (!rawBody.length) return { body: undefined, rawBody };
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  if (/[/+]json\b/.test(type)) {
    try {
      return { body: JSON.parse(rawBody.toString("utf8")), rawBody };
    } catch {
      throw new BadRequestException("The request body is not valid JSON");
    }
  }
  if (type.startsWith("application/x-www-form-urlencoded")) return { body: toObject(new URLSearchParams(rawBody.toString("utf8"))), rawBody };
  if (type.startsWith("text/")) return { body: rawBody.toString("utf8"), rawBody };
  return { body: rawBody, rawBody };
}

const METHOD_NAMES: Partial<Record<RequestMethod, string>> = {
  [RequestMethod.GET]: "GET",
  [RequestMethod.POST]: "POST",
  [RequestMethod.PUT]: "PUT",
  [RequestMethod.DELETE]: "DELETE",
  [RequestMethod.PATCH]: "PATCH",
  [RequestMethod.OPTIONS]: "OPTIONS",
  [RequestMethod.HEAD]: "HEAD",
};

/** Nest's HTTP adapter for archlast-forge. Nest registers its routes here at `init()`, and the engine's /http routing calls `handle()`. */
class ForgeAdapter extends AbstractHttpAdapter<unknown, ForgeRequest, ForgeResponse> {
  private notFound?: Handler;
  private readonly router: Router;

  constructor(private readonly prefix: string) {
    const router = new Router();
    super(router);
    this.router = router;
  }

  /** Runs one request through Nest. Errors that are not HttpExceptions are thrown, so the engine answers them like an HTTP action's. */
  async handle(request: Request, ctx: ActionCtx): Promise<Response> {
    let parsed: Awaited<ReturnType<typeof readBody>>;
    try {
      parsed = await readBody(request);
    } catch (e) {
      if (!(e instanceof HttpException)) throw e;
      return Response.json(e.getResponse(), { status: e.getStatus() });
    }
    // Nest sees paths below the mount point, so `prefix: "/api/"` with `@Controller("users")` serves /http/api/users.
    const path = "/" + new URL(request.url).pathname.slice(this.prefix.length);
    const req = new ForgeRequest(request, request.method, path, parsed.body, parsed.rawBody, ctx);
    const res = new ForgeResponse();
    res.request = req;

    const layers = this.router.layers;
    let i = 0;
    const next = (err?: unknown): Promise<void> | void => {
      if (err) return res.fail(err);
      while (i < layers.length) {
        const layer = layers[i++]!;
        if (layer.method && layer.method !== req.method) continue;
        const found = layer.matches(path);
        if (!found) continue;
        if (layer.route) {
          req.params = found.params;
          // The request is named after the route it matched, below /http: the mount prefix and Nest's own path.
          telemetry()?.annotate({ "http.route": `${this.prefix.slice(0, -1)}${layer.pattern}` }, true);
        }
        return Promise.resolve()
          .then(() => layer.handler(req, res, next))
          .then(
            () => {},
            (e) => res.fail(e),
          );
      }
      return Promise.resolve(this.notFound?.(req, res, next)).then(
        () => {},
        (e) => res.fail(e),
      );
    };
    await next();
    await res.done; // handlers answer when they end the response or start streaming it; the action's time limit bounds the wait
    if (res.error) throw res.error; // before the head went out; an error while streaming ends the stream instead
    return res.toResponse();
  }

  // Nest calls these while it handles a request.
  reply(res: ForgeResponse, body: unknown, statusCode?: number) {
    if (statusCode) res.statusCode = statusCode;
    if (body === undefined || body === null) return res.end();
    if (body instanceof Response) {
      res.statusCode = body.status; // a Response a controller built says what it means, over Nest's default 200 or 201
      for (const [k, v] of body.headers) res.headers.append(k, v);
      res.body = body.body;
      return res.end();
    }
    if (body instanceof StreamableFile) {
      const { type, disposition, length } = body.getHeaders();
      if (type && !res.headers.has("content-type")) res.headers.set("content-type", type);
      if (disposition && !res.headers.has("content-disposition")) res.headers.set("content-disposition", String(disposition));
      if (length !== undefined && !res.headers.has("content-length")) res.headers.set("content-length", String(length));
      res.body = Readable.toWeb(body.getStream()) as unknown as ReadableStream; // Node's web stream type and the DOM's are the same thing at runtime
      return res.end();
    }
    if (body instanceof Uint8Array || body instanceof ArrayBuffer || body instanceof Blob || body instanceof ReadableStream) {
      res.body = body as BodyInit;
      return res.end();
    }
    if (typeof body === "object") {
      if (!res.headers.has("content-type")) res.headers.set("content-type", "application/json; charset=utf-8");
      return res.end(JSON.stringify(body));
    }
    if (!res.headers.has("content-type")) res.headers.set("content-type", "text/plain; charset=utf-8");
    return res.end(String(body));
  }
  status(res: ForgeResponse, statusCode: number) {
    res.statusCode = statusCode;
  }
  end(res: ForgeResponse, message?: string) {
    res.end(message);
  }
  redirect(res: ForgeResponse, statusCode: number, url: string) {
    res.redirect(statusCode, url);
  }
  isHeadersSent(res: ForgeResponse) {
    return res.headersSent;
  }
  getHeader(res: ForgeResponse, name: string) {
    return res.getHeader(name);
  }
  setHeader(res: ForgeResponse, name: string, value: string) {
    res.setHeader(name, value);
  }
  appendHeader(res: ForgeResponse, name: string, value: string) {
    res.append(name, value);
  }
  getRequestHostname(req: ForgeRequest) {
    return req.hostname;
  }
  getRequestMethod(req: ForgeRequest) {
    return req.method;
  }
  getRequestUrl(req: ForgeRequest) {
    return req.originalUrl;
  }

  // Nest calls these while it starts.
  setNotFoundHandler(handler: Function) {
    this.notFound = handler as Handler;
  }
  setErrorHandler() {} // errors reach ForgeExceptionFilter, or the engine
  registerParserMiddleware() {} // handle() parses bodies itself
  createMiddlewareFactory(method: RequestMethod) {
    return (path: string, callback: Function) => this.router.middleware(METHOD_NAMES[method], path, callback as Handler);
  }
  /** `app.enableCors()` and the `cors` option of nest(): the `cors` package, ahead of every route, so preflight requests get their answer. */
  enableCors(options?: Parameters<typeof cors>[0]) {
    const run = cors(options);
    this.router.first((req, res, next) => run(req as never, res as never, next));
  }
  applyVersionFilter(handler: Function, _version: unknown, options: VersioningOptions) {
    if (options.type !== VersioningType.URI) throw new Error("Nest inside archlast-forge supports URI versioning only");
    return handler as (req: ForgeRequest, res: ForgeResponse, next: () => void) => Function;
  }
  initHttpServer() {
    this.httpServer = {};
  }
  getType() {
    return "archlast-forge";
  }
  close() {}
  override listen() {
    throw new Error("Nest inside archlast-forge does not listen: its controllers are served by the engine under /http");
  }
  useStaticAssets(): never {
    throw unsupported("useStaticAssets() (serve files from public/ or storage instead)");
  }
  setViewEngine(): never {
    throw unsupported("setViewEngine()");
  }
  render(): never {
    throw unsupported("render()");
  }
}
