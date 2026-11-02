// Forge RPC: typed request-response calls between forge backends, over HTTP. Backend to backend only: never a page, a mobile app or a
// desktop app, which call their own backend's functions instead (they must never hold FORGE_RPC_TOKEN). A service declares routers
// (@Router, @Query, @Mutation, @Input), lists them in nest()'s controllers and listens with ForgeRpcServer; `archlast-forge codegen` writes
// what they serve to forge/_generated/rpc.ts, and a caller types createForgeRpcClient<Rpc>() with it. Calls go through Nest's ClientProxy.
import { createTRPCUntypedClient, httpBatchLink, TRPCClientError } from "@trpc/client";
import { initTRPC, TRPCError } from "@trpc/server";
import { fetchRequestHandler } from "@trpc/server/adapters/fetch";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { isForgeError, ForgeError } from "./errors";
// By the packages' own names, as the other Nest entries do: the build keeps them entries of their own.
import { Catch, Controller, rxjs, UseFilters, type ArgumentsHost } from "@archlast/forge-runtime/nest";
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
    Controller()(cls);
    cls[RPC_ROUTER] = { alias, procedures };
  };
}

/** What a router method's transport context is (`@TransportCtx() ctx: ForgeRpcContext`): the pattern called and the call's request id. */
export class ForgeRpcContext extends BaseRpcContext<[pattern: string, requestId: string, traceparent?: string]> {
  getPattern() {
    return this.args[0];
  }
  /** Logged with any error the call ends with, and sent back to the caller with it. */
  getRequestId() {
    return this.args[1];
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
    const requestId = rpc?.getRequestId?.() ?? randomUUID();
    return rxjs.throwError(() => wireOf(exception, rpc?.getPattern?.() ?? "a procedure", requestId));
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

/** Carries a wire error through tRPC to the error formatter. */
class WireCause extends Error {
  constructor(readonly wire: ForgeRpcWireError) {
    super(wire.message);
  }
}

export interface ForgeRpcServerOptions {
  /** The port to listen on. Callers reach it at `http://<host>:<port>`. */
  port: number;
  /** The interface to bind. Default 0.0.0.0, so other containers reach it. */
  host?: string;
  /** The shared secret callers send as a bearer token. Default: FORGE_RPC_TOKEN. */
  token?: string;
}

type RpcCtx = { authorized: boolean; traceparent?: string };

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
      const router = this.router();
      const expected = this.expected;
      this.server = Bun.serve({
        port: this.options.port,
        hostname: this.options.host,
        maxRequestBodySize: Number(process.env.MAX_REQUEST_BYTES) || 8 * 1024 * 1024,
        fetch: (req) =>
          fetchRequestHandler({
            endpoint: "",
            req,
            router,
            allowMethodOverride: true, // every call is a POST, so a large query input never goes in a URL
            createContext: (): RpcCtx => ({
              authorized: timingSafeEqual(digest(req.headers.get("authorization") ?? ""), expected),
              traceparent: req.headers.get("traceparent") ?? undefined,
            }),
          }),
      });
      callback();
    } catch (e) {
      // nest() keeps a startup error for the calls that need the app; a service whose only Nest part is its router would never show it.
      console.error("[forge-rpc] the server didn't start:", e);
      callback(e);
    }
  }

  /** One tRPC procedure per router method the app registered, under `<alias>.<method>`. */
  private router() {
    const t = initTRPC.context<RpcCtx>().create({
      isDev: false, // tRPC's dev mode puts stack traces in responses
      errorFormatter({ shape, error, path }) {
        const wire = error.cause instanceof WireCause ? error.cause.wire : undefined;
        let requestId = wire?.requestId;
        let message = shape.message;
        if (shape.data.code === "INTERNAL_SERVER_ERROR") {
          if (!requestId) {
            requestId = randomUUID();
            console.error(`[forge-rpc] ${path ?? "a call"} failed (request ${requestId}):`, error.cause ?? error); // an output that broke its schema, say
          }
          message = `Server error (request ${requestId})`;
        }
        return { message, code: shape.code, data: { code: shape.data.code, httpStatus: shape.data.httpStatus, path, requestId, data: wire?.data } };
      },
    });
    const authed = t.procedure.use(({ ctx, next }) => {
      if (!ctx.authorized) throw new TRPCError({ code: "UNAUTHORIZED", message: "Forge RPC: the bearer token is missing or wrong" });
      return next();
    });
    const routes: Record<string, Record<string, unknown>> = {};
    for (const [pattern, handler] of this.messageHandlers) {
      const meta = handler.extras?.[EXTRAS] as (ProcedureOptions & { kind: ProcedureKind }) | undefined;
      if (!meta || handler.isEventHandler) continue; // another transport's handler
      const [alias, name] = pattern.split(".") as [string, string];
      let p: any = authed;
      if (meta.input) p = p.input(meta.input);
      if (meta.output) p = p.output(meta.output);
      const resolve = async ({ input, ctx }: { input: unknown; ctx: RpcCtx }) => {
        try {
          const result = await handler(input, new ForgeRpcContext([pattern, randomUUID(), ctx.traceparent]));
          return rxjs.isObservable(result) ? await rxjs.lastValueFrom(result, { defaultValue: undefined }) : result;
        } catch (e) {
          throw new TRPCError({ code: (e as ForgeRpcWireError)?.code === "BAD_REQUEST" ? "BAD_REQUEST" : "INTERNAL_SERVER_ERROR", cause: new WireCause(toWire(e)) });
        }
      };
      (routes[alias] ??= {})[name] = meta.kind === "query" ? p.query(resolve) : p.mutation(resolve);
    }
    if (!Object.keys(routes).length) throw new Error("Forge RPC: no @Router class to serve: list them in nest()'s controllers");
    return t.router(Object.fromEntries(Object.entries(routes).map(([alias, procs]) => [alias, t.router(procs as any)])));
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
}

/**
 * A Nest ClientProxy for Forge RPC: `send(pattern, input)` as with any transport, or typed calls through createForgeRpcClient(). Calls made
 * in the same tick go out as one HTTP request, over kept-alive connections. Request-response only: emit() fails.
 */
export class ForgeRpcClient extends ClientProxy {
  private readonly rpc: ReturnType<typeof createTRPCUntypedClient>;
  private readonly timeoutMs: number;
  private authorization?: string;

  constructor(private readonly options: ForgeRpcClientOptions) {
    super();
    backendOnly();
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.rpc = createTRPCUntypedClient({ links: [httpBatchLink({ url: options.url, methodOverride: "POST", maxItems: 32, headers: () => ({ authorization: this.authorization! }) })] });
  }

  async connect() {}
  async close() {}
  unwrap<T>(): T {
    return this.rpc as T;
  }

  protected publish(packet: ReadPacket, callback: (packet: WritePacket) => void): () => void {
    const pattern = this.normalizePattern(packet.pattern);
    // The token is read at the first call, not when the client is made: ClientsModule.register() and class fields make clients as
    // their module loads, and an app that never calls the service shouldn't fail to load for want of one.
    try {
      this.authorization ??= `Bearer ${tokenOf(this.options.token)}`;
    } catch (e) {
      callback({ err: { status: "error", message: (e as Error).message, code: "UNAUTHORIZED" } satisfies ForgeRpcWireError, isDisposed: true });
      return () => {};
    }
    const abort = new AbortController();
    let done = false;
    const finish = (p: WritePacket) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      callback(p);
    };
    const timer = setTimeout(() => {
      finish({ err: { status: "error", message: `Forge RPC: ${pattern} took longer than ${this.timeoutMs} ms`, code: "TIMEOUT" } satisfies ForgeRpcWireError, isDisposed: true });
      abort.abort();
    }, this.timeoutMs);
    // A mutation call reaches queries too (the server allows the POST), so a plain send() needs no contract to know which it is.
    this.rpc.mutation(pattern, packet.data, { signal: abort.signal }).then(
      (response) => finish({ response, isDisposed: true }),
      (e) => finish({ err: this.wireOf(e, pattern), isDisposed: true }),
    );
    return () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      abort.abort();
    };
  }

  private wireOf(e: unknown, pattern: string): ForgeRpcWireError {
    const d = e instanceof TRPCClientError ? (e.data as { code?: string; data?: unknown; requestId?: string } | undefined) : undefined;
    if (d?.code) return { status: "error", message: (e as Error).message, code: d.code, ...(d.data !== undefined && { data: d.data }), ...(d.requestId && { requestId: d.requestId }) };
    return { status: "error", message: `Forge RPC: ${this.options.url} did not answer ${pattern} (${(e as Error)?.message ?? e})`, code: "SERVICE_UNAVAILABLE" };
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
