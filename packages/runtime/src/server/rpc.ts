// The public wire protocol. Functions are called over HTTP, live queries over one WebSocket per client.
//
//   POST /rpc/<function name>            body: JSON arguments        → { "result": value }
//   GET  /rpc/<function name>?args=<json> (queries only)             → { "result": value }
//   errors, with the matching HTTP status                            → { "error": { message, code, data?, requestId } }
//
//   WebSocket /rpc, JSON messages
//     client → server  { type: "subscribe", id, name, args } | { type: "unsubscribe", id }
//     server → client  { type: "data", id, data: QueryUpdate } | { type: "error", id, error }
//
// A subscription's first message is the query's current result, then one after each relevant write. A client that reconnects
// subscribes again and gets a fresh first message.
import type { ServerWebSocket } from "bun";
import type { FunctionKind } from "../functions";
import type { CallHeaders } from "./executor";
import type { Manifest } from "./project";
import { toPublicError, type PublicCode } from "./public-error";
import type { FunctionRuntime } from "./runtime";
import type { QueryRunner, SubscriptionManager } from "./subscriptions";
import type { Tracer } from "./tracing";

/** What a call needs from its HTTP request or WebSocket handshake. */
export type Context = { headers: CallHeaders; requestId: string; traceparent?: string };

export type ErrorCode = PublicCode | "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN" | "METHOD_NOT_ALLOWED" | "UNSUPPORTED_MEDIA_TYPE" | "TOO_MANY_REQUESTS";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TIMEOUT: 408,
  UNSUPPORTED_MEDIA_TYPE: 415,
  TOO_MANY_REQUESTS: 429,
  INTERNAL_SERVER_ERROR: 500,
  SERVICE_UNAVAILABLE: 503,
};

export interface ErrorBody {
  message: string;
  code: ErrorCode;
  /** What a function threw as a ForgeError. */
  data?: unknown;
  requestId: string;
}

const JSON_TYPE = "application/json;charset=utf-8";
export const errorResponse = (error: ErrorBody) =>
  Response.json({ error }, { status: STATUS[error.code], headers: { "x-request-id": error.requestId, ...(error.code === "SERVICE_UNAVAILABLE" && { "retry-after": "1" }) } });

/** A failure with a code, for handlers that answer with something other than a function's own error. */
export class HttpError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message);
  }
}

/** Reads a JSON request: the body of a POST, or the named query parameter of a GET (from the already parsed `url`). Empty means `{}`. */
export async function readJson(req: Request, param: string, url: URL): Promise<unknown> {
  try {
    if (req.method === "GET") {
      const raw = url.searchParams.get(param);
      return raw ? JSON.parse(raw) : {};
    }
    const text = await req.text();
    return text ? JSON.parse(text) : {};
  } catch {
    throw new HttpError("BAD_REQUEST", "The request must be valid JSON");
  }
}

/** A cross-site form can send a POST without a preflight, but not one with a JSON content type. */
export const requireJson = (req: Request) => {
  if (req.method === "POST" && !req.headers.get("content-type")?.includes("application/json")) throw new HttpError("UNSUPPORTED_MEDIA_TYPE", "Send application/json");
};

export interface SocketData extends Context {
  ip?: string;
  /** Live subscriptions on this connection, by the client's id. */
  live: Map<string, AbortController>;
}

export interface RpcOptions {
  dev: boolean;
  maxSubscriptionsPerConnection: number;
  tracer?: Tracer;
}

/** The calls and subscriptions of every public function in the manifest. Internal functions aren't reachable. */
export function buildRpc(manifest: Manifest, runtime: FunctionRuntime, queries: QueryRunner, subs: SubscriptionManager, opts: RpcOptions) {
  const kinds = new Map<string, FunctionKind>();
  for (const f of manifest.functions) if (f.visibility !== "internal") kinds.set(f.name, f.kind);

  const send = (ws: ServerWebSocket<SocketData>, message: object) => void ws.send(JSON.stringify(message));

  return {
    /** Args are validated in the function runtime. */
    async call(name: string, req: Request, url: URL, ctx: Context): Promise<Response> {
      try {
        const kind = kinds.get(name);
        if (!kind) throw new HttpError("NOT_FOUND", `No function "${name}"`);
        if (req.method === "GET" ? kind !== "query" : req.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED", `Call ${name} with ${kind === "query" ? "GET or POST" : "POST"}`);
        requireJson(req);
        const args = await readJson(req, "args", url);
        // The body as a string: a cached query keeps its serialized form, so a hit costs no JSON work.
        const run = async () => {
          if (kind !== "query") return JSON.stringify({ result: (await runtime.call(name, kind, args, ctx.headers, { requestId: ctx.requestId })).value });
          const r = await queries.run(name, args, ctx.headers, ctx.requestId);
          return `{"result":${(r.json ??= JSON.stringify(r.value))}}`;
        };
        const body = await (opts.tracer ? opts.tracer.span(name, ctx.traceparent, { "forge.function": name, "forge.request_id": ctx.requestId }, run) : run());
        return new Response(body, { headers: { "content-type": JSON_TYPE, "x-request-id": ctx.requestId } });
      } catch (e) {
        if (e instanceof HttpError) return errorResponse({ message: e.message, code: e.code, requestId: ctx.requestId });
        return errorResponse(toPublicError(e, ctx.requestId, opts.dev, { function: name }));
      }
    },

    message(ws: ServerWebSocket<SocketData>, raw: string) {
      let m: { type?: unknown; id?: unknown; name?: unknown; args?: unknown };
      try {
        m = JSON.parse(raw);
      } catch {
        return ws.close(1003, "Messages are JSON");
      }
      const { live, requestId } = ws.data;
      const id = m.id;
      if (typeof id !== "string" || id.length > 64) return ws.close(1008, "Messages need a string id");
      if (m.type === "unsubscribe") return void (live.get(id)?.abort(), live.delete(id));
      if (m.type !== "subscribe") return ws.close(1008, "Unknown message type");
      const name = String(m.name);
      const refuse = (code: ErrorCode, message: string) => send(ws, { type: "error", id, error: { message, code, requestId } satisfies ErrorBody });
      if (live.has(id)) return refuse("BAD_REQUEST", `Subscription ${id} already exists`);
      if (kinds.get(name) !== "query") return refuse("NOT_FOUND", `No query "${name}"`);
      if (live.size >= opts.maxSubscriptionsPerConnection) return refuse("TOO_MANY_REQUESTS", `At most ${opts.maxSubscriptionsPerConnection} subscriptions per connection`);
      const stop = new AbortController();
      live.set(id, stop);
      void (async () => {
        try {
          for await (const data of subs.subscribe(name, m.args ?? {}, ws.data.headers, stop.signal, requestId)) send(ws, { type: "data", id, data });
        } catch (e) {
          if (!stop.signal.aborted) send(ws, { type: "error", id, error: toPublicError(e, requestId, opts.dev, { function: name }) });
        } finally {
          if (live.get(id) === stop) live.delete(id);
        }
      })();
    },

    close(ws: ServerWebSocket<SocketData>) {
      for (const stop of ws.data.live.values()) stop.abort();
      ws.data.live.clear();
    },
  };
}

export type Rpc = ReturnType<typeof buildRpc>;
