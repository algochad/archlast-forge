// Forge RPC: typed request-response calls between forge backends, over HTTP (the protocol and its fast path are in forge-rpc/). Backend to backend only: never a page, a mobile app or a
// desktop app, which call their own backend's functions instead (they must never hold FORGE_RPC_TOKEN). A service declares routers
// (@Router, @Query, @Mutation, @Input), lists them in nest()'s controllers and listens with ForgeRpcServer; `archlast-forge codegen` writes
// what they serve to forge/_generated/rpc.ts, and a caller types createForgeRpcClient<Rpc>() with it. Calls go through Nest's ClientProxy.
import { createHash, timingSafeEqual } from "node:crypto";
import { isForgeError, ForgeError } from "./errors";
// By the package's own name, so the build keeps it external and its own (minified) file: see "build" in package.json.
import { createCaller, createRpc, RpcFailure, type Procedure } from "@archlast/forge-runtime/forge-rpc";
// By the packages' own names, as the other Nest entries do: the build keeps them entries of their own.
import { Catch, rxjs, timeClass, UseFilters, type ArgumentsHost } from "@archlast/forge-runtime/nest";
import { Controller } from "@nestjs/common";
import {
  BaseRpcContext,
  ClientProxy,
  MessagePattern,
  Payload,
  RpcException,
  Server,
  type CustomTransportStrategy,
  type ReadPacket,
  type WritePacket,
} from "@archlast/forge-runtime/nest/microservices";

export { z } from "zod";
export { Ctx } from "@archlast/forge-runtime/nest";

/** The transport id router methods are registered under: only ForgeRpcServer serves them, beside any other transport the app listens on. */
export const FORGE_RPC = Symbol.for("archlast-forge.rpc");
/** Where @Router keeps what a class serves (its alias and procedures), for ForgeRpcServer and codegen. By Symbol.for: codegen's copy of the runtime reads the project's. */
export const RPC_ROUTER = Symbol.for("archlast-forge.rpc.router");
const PROCEDURES = Symbol("forge-rpc procedures");
const EXTRAS = "forgeRpc";
const ORIGINAL = Symbol("forge-rpc original exception");
const bridge = () =>
  (globalThis as Record<symbol, unknown>)[Symbol.for("archlast-forge.telemetry")] as
    | {
        entry?: <T>(kind: "rpc", operation: string, incoming: string | undefined, fn: () => Promise<T>) => Promise<T>;
        outbound?: (name: string, attrs: Record<string, string | number | boolean>) => { traceparent: string; end(error?: string): void } | undefined;
      }
    | undefined;

/** A schema the server validates with: Zod (`z` from here), or any other Standard Schema library. */
export type RpcSchema = { readonly "~standard": unknown };
export interface ProcedureOptions {
  /** Validates what the caller sends, before the method runs. Without it the procedure takes no input. */
  input?: RpcSchema;
  /** Validates what the method returns. Without it the caller's type is the method's return type, and nothing is checked. */
  output?: RpcSchema;
}
export type ProcedureKind = "query" | "mutation";
export interface RouterMeta {
  alias: string;
  procedures: Record<string, ProcedureOptions & { kind: ProcedureKind }>;
}

const IDENT = /^[A-Za-z_$][\w$]*$/;

function procedure(kind: ProcedureKind) {
  return (options: ProcedureOptions = {}): MethodDecorator =>
    (target, key) => {
      if (typeof key !== "string") throw new Error("Forge RPC: a procedure needs a method with a string name");
      const proto = target as Record<symbol, RouterMeta["procedures"]>;
      const own = Object.hasOwn(proto, PROCEDURES) ? proto[PROCEDURES]! : (proto[PROCEDURES] = { ...proto[PROCEDURES] });
      own[key] = { kind, ...options };
    };
}

/** A procedure that reads: `@Query({ input, output })` on a router method. Callers use `.query(input)`. */
export const Query = procedure("query");
/** A procedure that changes something: `@Mutation({ input, output })` on a router method. Callers use `.mutate(input)`. */
export const Mutation = procedure("mutation");
/** The method's parameter that receives the validated input, or one field of it: `@Input() input` or `@Input("orderId") orderId`. */
export const Input = (key?: string): ParameterDecorator => (key === undefined ? Payload() : Payload(key));

/**
 * A class whose @Query and @Mutation methods other services call as `<alias>.<method>`. The alias defaults to the class name without
 * "Router", first letter lowercased (OrdersRouter: "orders"). List the class in nest()'s controllers: it is one, and DI works as usual.
 */
export function Router(options: { alias?: string } = {}): ClassDecorator {
  return (target) => {
    const cls = target as unknown as Function & { prototype: Record<symbol, RouterMeta["procedures"]>; [RPC_ROUTER]?: RouterMeta };
    const alias = options.alias ?? cls.name.replace(/Router$/, "").replace(/^./, (c) => c.toLowerCase());
    if (!IDENT.test(alias)) throw new Error(`Forge RPC: ${cls.name}'s alias "${alias}" must be an identifier (no dots)`);
    const procedures = cls.prototype[PROCEDURES] ?? {};
    if (!Object.keys(procedures).length) throw new Error(`Forge RPC: ${cls.name} has no @Query or @Mutation method`);
    for (const [name, p] of Object.entries(procedures)) {
      const descriptor = Object.getOwnPropertyDescriptor(cls.prototype, name);
      if (!descriptor) throw new Error(`Forge RPC: ${cls.name}.${name} is inherited: declare procedures on the router itself`);
      MessagePattern(`${alias}.${name}`, FORGE_RPC, { [EXTRAS]: p })(cls.prototype, name, descriptor);
    }
    UseFilters(ForgeRpcFilter)(cls);
    // Timed like any controller, but without the interceptor that records transport messages: ForgeRpcServer records each call itself,
    // around the handler and without an observable of its own.
    timeClass(cls, "controller", false);
    Controller()(cls);
    cls[RPC_ROUTER] = { alias, procedures };
  };
}

/** What a router method's transport context is (`@TransportCtx() ctx: ForgeRpcContext`): the pattern called and the call's request id. */
export class ForgeRpcContext extends BaseRpcContext<[pattern: string, requestId: string | undefined, traceparent?: string]> {
  getPattern() {
    return this.args[0];
  }
  /** Logged with any error the call ends with, and sent back to the caller with it. Made when first asked for: most calls never need one. */
  getRequestId(): string {
    return (this.args[1] ??= crypto.randomUUID());
  }
  /** The caller's trace (W3C traceparent), so the call is recorded under it. */
  getTraceparent() {
    return this.args[2];
  }
}

/** An error as it crosses the wire, in the engine's envelope (`/rpc` errors have the same fields), plus Nest's `status`. */
export interface ForgeRpcWireError {
  status: "error";
  message: string;
  /** BAD_REQUEST (a ForgeError, an RpcException, or input that failed validation), UNAUTHORIZED, NOT_FOUND, TIMEOUT, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR. */
  code: string;
  data?: unknown;
  requestId?: string;
}

/** Turns what a router method threw into the wire error. Only ForgeError and RpcException keep their message; anything else is logged here, with the request id. */
class ForgeRpcFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const rpc = host.switchToRpc().getContext<Partial<ForgeRpcContext>>();
    const requestId = rpc?.getRequestId?.() ?? crypto.randomUUID();
    const wire = wireOf(exception, rpc?.getPattern?.() ?? "a procedure", requestId);
    Object.defineProperty(wire, ORIGINAL, { value: exception }); // for the transport, which records the call with the exception that ended it
    return rxjs.throwError(() => wire);
  }
}
Catch()(ForgeRpcFilter);

function wireOf(e: unknown, pattern: string, requestId: string): ForgeRpcWireError {
  if (isForgeError(e)) return { status: "error", message: e.message, code: "BAD_REQUEST", data: e.data, requestId };
  if (e instanceof RpcException) {
    const err = e.getError();
    if (typeof err === "string") return { status: "error", message: err, code: "BAD_REQUEST", requestId };
    const message = (err as { message?: unknown }).message;
    return { status: "error", message: typeof message === "string" ? message : "Bad request", code: "BAD_REQUEST", data: err, requestId };
  }
  console.error(`[forge-rpc] ${pattern} failed (request ${requestId}):`, e);
  return { status: "error", message: `Server error (request ${requestId})`, code: "INTERNAL_SERVER_ERROR", requestId };
}

const MIN_TOKEN = 16;
function backendOnly() {
  if (typeof (globalThis as { window?: unknown }).window !== "undefined")
    throw new Error("Forge RPC is for calls between backends, and this is a page or an app: call your backend's functions from here, and let the backend call the service");
}
function tokenOf(token: string | undefined): string {
  const t = token ?? process.env.FORGE_RPC_TOKEN;
  if (!t || t.length < MIN_TOKEN) throw new Error(`Forge RPC needs a shared token of ${MIN_TOKEN} characters or more: set FORGE_RPC_TOKEN (the same in every app) or pass { token }`);
  return t;
}
const digest = (s: string) => createHash("sha256").update(s).digest();

export interface ForgeRpcServerOptions {
  /** The port to listen on. Callers reach it at `http://<host>:<port>`. */
  port: number;
  /** The interface to bind. Default 0.0.0.0, so other containers reach it. */
  host?: string;
  /** The shared secret callers send as a bearer token. Default: FORGE_RPC_TOKEN. */
  token?: string;
}

/**
 * The Forge RPC transport, as a Nest custom strategy: `nest(http, { controllers: [OrdersRouter], microservices: [{ strategy: new
 * ForgeRpcServer({ port: 4001 }) }] })`. It serves every @Router method of the app on a Bun server of its own: input and output
 * validated with the method's schemas, a bearer token checked on every call, errors in the engine's envelope with no stack or internal message.
 */
export class ForgeRpcServer extends Server implements CustomTransportStrategy {
  private server?: ReturnType<typeof Bun.serve>;
  private readonly expected: Buffer;

  constructor(private readonly options: ForgeRpcServerOptions) {
    super();
    backendOnly();
    this.transportId = FORGE_RPC;
    this.expected = digest(`Bearer ${tokenOf(options.token)}`);
  }

  listen(callback: (err?: unknown) => void) {
    try {
      const expected = this.expected;
      // The one header that ever passed is remembered, so a call that carries it costs a lookup, not a digest. A Set hashes the whole string
      // before it compares anything, so how far a wrong guess matches is not something timing can show.
      const accepted = new Set<string>();
      const maxBody = Number(process.env.MAX_REQUEST_BYTES) || 8 * 1024 * 1024;
      const rpc = createRpc({
        maxPayload: maxBody,
        procedures: this.procedures(),
        authorized: (header) => {
          if (header === null) return false;
          if (accepted.has(header)) return true;
          if (!timingSafeEqual(digest(header), expected)) return false;
          accepted.add(header);
          return true;
        },
      });
      this.server = Bun.serve({
        port: this.options.port,
        hostname: this.options.host,
        maxRequestBodySize: maxBody,
        fetch: (req, server) => rpc.fetch(req, server),
        websocket: rpc.websocket,
      });
      callback();
    } catch (e) {
      // nest() keeps a startup error for the calls that need the app; a service whose only Nest part is its router would never show it.
      console.error("[forge-rpc] the server didn't start:", e);
      callback(e);
    }
  }

  /** One procedure per router method the app registered, under `<alias>.<method>`. */
  private procedures() {
    const procedures = new Map<string, Procedure>();
    for (const [pattern, handler] of this.messageHandlers) {
      const meta = handler.extras?.[EXTRAS] as (ProcedureOptions & { kind: ProcedureKind }) | undefined;
      if (!meta || handler.isEventHandler) continue; // another transport's handler
      procedures.set(pattern, {
        kind: meta.kind,
        input: meta.input,
        output: meta.output,
        run: async (input, traceparent) => {
          let wire: ForgeRpcWireError | undefined;
          const invoke = async () => {
            try {
              const result = await handler(input, new ForgeRpcContext([pattern, undefined, traceparent]));
              return rxjs.isObservable(result) ? await rxjs.lastValueFrom(result, { defaultValue: undefined }) : result;
            } catch (e) {
              wire = toWire(e);
              throw (e as { [ORIGINAL]?: unknown } | undefined)?.[ORIGINAL] ?? e; // what the telemetry entry records is the exception, not its wire form
            }
          };
          try {
            // Recorded here, under the caller's trace, as the generic interceptor would (a router doesn't get it): no observable around the call.
            const entry = bridge()?.entry;
            return await (entry ? entry("rpc", pattern, traceparent, invoke) : invoke());
          } catch (e) {
            const w = wire ?? toWire(e);
            if (w.code === "BAD_REQUEST") throw new RpcFailure("BAD_REQUEST", w.message, w.data, w.requestId);
            // Anything else is a request id, never its message.
            const requestId = w.requestId ?? crypto.randomUUID();
            if (!w.requestId) console.error(`[forge-rpc] ${pattern} failed (request ${requestId}):`, e);
            throw new RpcFailure("INTERNAL_SERVER_ERROR", `Server error (request ${requestId})`, undefined, requestId);
          }
        },
      });
    }
    if (!procedures.size) throw new Error("Forge RPC: no @Router class to serve: list them in nest()'s controllers");
    return procedures;
  }

  close() {
    void this.server?.stop(true);
    this.server = undefined;
  }

  on(): never {
    throw new Error("Forge RPC has no events to listen to");
  }

  unwrap<T>(): T {
    if (!this.server) throw new Error("Forge RPC: the server isn't listening");
    return this.server as T;
  }
}

/** What reached the transport: our filter's wire error, or Nest's own `{ status, message }` if another filter answered first. */
function toWire(e: unknown): ForgeRpcWireError {
  const w = e as Partial<ForgeRpcWireError> | undefined;
  if (w && typeof w === "object" && typeof w.code === "string" && typeof w.message === "string") return w as ForgeRpcWireError;
  const message = typeof w?.message === "string" ? w.message : "Internal server error";
  return message === "Internal server error" ? { status: "error", message, code: "INTERNAL_SERVER_ERROR" } : { status: "error", message, code: "BAD_REQUEST" };
}

export interface ForgeRpcClientOptions {
  /** Where the service's ForgeRpcServer listens: `http://orders:4001`. */
  url: string;
  /** The shared secret, sent as a bearer token. Default: FORGE_RPC_TOKEN. */
  token?: string;
  /** How long a call may take before it fails with TIMEOUT. Default 5000. */
  timeoutMs?: number;
  /** Keep a WebSocket open to the service, which is much faster than HTTP requests and falls back to them when the service can't take one. Default true. */
  websocket?: boolean;
}

/**
 * A Nest ClientProxy for Forge RPC: `send(pattern, input)` as with any transport, or typed calls through createForgeRpcClient(). Calls made
 * in the same tick go out as one HTTP request, over kept-alive connections. Request-response only: emit() fails.
 */
export class ForgeRpcClient extends ClientProxy {
  private readonly call: ReturnType<typeof createCaller>;
  private authorization?: string;

  constructor(private readonly options: ForgeRpcClientOptions) {
    super();
    backendOnly();
    // The token is read at the first call, not when the client is made: ClientsModule.register() and class fields make clients as
    // their module loads, and an app that never calls the service shouldn't fail to load for want of one.
    this.call = createCaller({ url: options.url, timeoutMs: options.timeoutMs ?? 5000, websocket: options.websocket, trace: (pattern) => bridge()?.outbound?.(`RPC ${options.url.replace(/^\w+:\/\//, "")}`, { "rpc.system": "forge-rpc", "rpc.method": pattern }), authorization: () => (this.authorization ??= `Bearer ${tokenOf(options.token)}`) });
  }

  async connect() {}
  async close() {
    this.call.close();
  }
  unwrap<T>(): T {
    return this.call as T;
  }

  /** Nest's `send()` routes through connect(), serializers and an rxjs pipeline; nothing here needs any of it. */
  override send<TResult = any, TInput = any>(pattern: any, data: TInput): rxjs.Observable<TResult> {
    if (pattern === undefined || pattern === null || data === undefined || data === null) return rxjs.throwError(() => new Error("Forge RPC: send() needs a pattern and some data (use {} for none)"));
    const name = this.normalizePattern(pattern);
    return new rxjs.Observable<TResult>((subscriber) =>
      this.call(name, data, (err, response) => {
        if (err) subscriber.error(err);
        else {
          subscriber.next(response as TResult);
          subscriber.complete();
        }
      }),
    );
  }

  protected publish(packet: ReadPacket, callback: (packet: WritePacket) => void): () => void {
    // A mutation-style POST reaches queries too (the server allows it), so a plain send() needs no contract to know which a pattern is.
    return this.call(this.normalizePattern(packet.pattern), packet.data, (err, response) => callback(err ? { err, isDisposed: true } : { response, isDisposed: true }));
  }

  protected async dispatchEvent(): Promise<never> {
    throw new Error("Forge RPC is request-response only: use send(), not emit()");
  }
}

/** A failed call that isn't the service's own ForgeError: the code says why (UNAUTHORIZED, NOT_FOUND, TIMEOUT, SERVICE_UNAVAILABLE, INTERNAL_SERVER_ERROR). */
export class ForgeRpcError extends Error {
  override name = "ForgeRpcError";
  readonly code: string;
  readonly data?: unknown;
  readonly requestId?: string;
  constructor(wire: ForgeRpcWireError) {
    super(wire.message);
    this.code = wire.code;
    this.data = wire.data;
    this.requestId = wire.requestId;
  }
}

type Call<I, O> = [I] extends [undefined] ? () => Promise<O> : undefined extends I ? (input?: I) => Promise<O> : (input: I) => Promise<O>;
/** The typed client of a service's routers, from its generated `Rpc`: `.query()` on queries, `.mutate()` on mutations. */
export type ForgeRpcClientOf<R> = {
  [A in keyof R]: {
    [P in keyof R[A]]: R[A][P] extends { kind: "query"; input: infer I; output: infer O }
      ? { query: Call<I, O> }
      : R[A][P] extends { kind: "mutation"; input: infer I; output: infer O }
        ? { mutate: Call<I, O> }
        : never;
  };
};

/**
 * Typed calls to a service: `createForgeRpcClient<OrdersRpc>({ url })`, or over a ForgeRpcClient you already have (a ClientsModule
 * provider). `orders.orders.get.query({ orderId })` sends `orders.get` through the ClientProxy. A BAD_REQUEST comes back as a ForgeError
 * (the service's own, or its input check), so it reaches this app's caller as the service meant; anything else is a ForgeRpcError.
 */
export function createForgeRpcClient<R>(transport: ClientProxy | ForgeRpcClientOptions): ForgeRpcClientOf<R> {
  const client = transport instanceof ClientProxy ? transport : new ForgeRpcClient(transport);
  const call = (pattern: string) => (input?: unknown) =>
    rxjs.lastValueFrom(client.send(pattern, input ?? {}), { defaultValue: undefined }).catch((e: unknown) => {
      const wire = toWire(e);
      throw wire.code === "BAD_REQUEST" ? new ForgeError(wire.data ?? wire.message) : new ForgeRpcError(wire);
    });
  const procedures = (alias: string) =>
    new Proxy({} as Record<string, unknown>, {
      get: (cache, name) => (typeof name !== "string" || name === "then" ? undefined : (cache[name] ??= { query: call(`${alias}.${name}`), mutate: call(`${alias}.${name}`) })),
    });
  return new Proxy({} as Record<string, unknown>, {
    get: (cache, alias) => (typeof alias !== "string" || alias === "then" ? undefined : (cache[alias] ??= procedures(alias))),
  }) as ForgeRpcClientOf<R>;
}
