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
import type { QueryObserver, QueryRunner, SubscriptionManager } from "./subscriptions";
import { failureOf } from "./telemetry/outcome";
import type { Telemetry } from "./telemetry/recorder";

/** What a call needs from its HTTP request or WebSocket handshake. */
export type Context = { headers: CallHeaders; requestId: string; traceparent?: string };

export type ErrorCode = PublicCode | "NOT_FOUND" | "UNAUTHORIZED" | "FORBIDDEN" | "METHOD_NOT_ALLOWED" | "PAYLOAD_TOO_LARGE" | "UNSUPPORTED_MEDIA_TYPE" | "TOO_MANY_REQUESTS";

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  METHOD_NOT_ALLOWED: 405,
  TIMEOUT: 408,
  PAYLOAD_TOO_LARGE: 413,
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

const tooLarge = (max: number) => new HttpError("PAYLOAD_TOO_LARGE", `The request body is over ${max} bytes (MAX_REQUEST_BYTES)`);

/**
 * A request body of at most `max` bytes. Bun refuses longer ones by itself, except where the engine takes uploads (built-in storage, a backup
 * from the dashboard) and raises Bun's limit for them: then this keeps every other body to MAX_REQUEST_BYTES.
 */
export async function readBytes(req: Request, max: number): Promise<Uint8Array> {
  const declared = req.headers.get("content-length");
  if (declared !== null) {
    if (Number(declared) > max) throw tooLarge(max);
    return new Uint8Array(await req.arrayBuffer()); // a declared length is all Bun reads
  }
  if (!req.body) return new Uint8Array(0);
  const parts: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of req.body) {
    size += chunk.byteLength;
    if (size > max) throw tooLarge(max);
    parts.push(chunk);
  }
  return Buffer.concat(parts);
}

export async function readText(req: Request, max: number): Promise<string> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) <= max) return req.text();
  return new TextDecoder().decode(await readBytes(req, max));
}

/** A request's JSON as it arrived: the body of a POST, or the named query parameter of a GET (from the already parsed `url`). */
const rawJson = async (req: Request, param: string, url: URL, max = Infinity) => (req.method === "GET" ? (url.searchParams.get(param) ?? "") : await readText(req, max));

/** Empty means `{}`. */
function parseJson(raw: string): unknown {
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    throw new HttpError("BAD_REQUEST", "The request must be valid JSON");
  }
}

export const readJson = async (req: Request, param: string, url: URL, max = Infinity): Promise<unknown> => parseJson(await rawJson(req, param, url, max));

const encoder = new TextEncoder();

/**
 * A cross-site form or fetch can send a POST without a preflight, but not one with a JSON content type. The media type is compared whole:
 * `text/plain; x=application/json` is a type a page may send without one.
 */
export const requireJson = (req: Request) => {
  if (req.method === "POST" && req.headers.get("content-type")?.split(";")[0]!.trim().toLowerCase() !== "application/json")
    throw new HttpError("UNSUPPORTED_MEDIA_TYPE", "Send application/json");
};

export interface SocketData extends Context {
  ip?: string;
  /** Live subscriptions on this connection, by the client's id. */
  live: Map<string, AbortController>;
  /** The JSON size of each live subscription's subscribe message, by id: what the connection holds for them. */
  held?: Map<string, number>;
  /** Whose connection count this socket is in (MAX_CONNECTIONS_PER_IP). */
  slot?: string;
}

export interface RpcOptions {
  dev: boolean;
  maxSubscriptionsPerConnection: number;
  /** The JSON size of one subscribe message; the live subscriptions of one connection may hold 16 times this. */
  maxSubscriptionBytes?: number;
  maxRequestBytes?: number;
  telemetry?: Telemetry;
  /**
   * Builds the answer to a successful call. Set when the HTTP engine has a type cheaper than Web `Response` (archlast-serve's `Reply`); it
   * is read at each call. Such an answer is returned with the CORS headers of `ctx.cors` already on it, since it has no `Headers` to add to.
   */
  reply?: (body: string | Uint8Array, headers: Record<string, string>) => Response;
}

/** The calls and subscriptions of every public function in the manifest. Internal functions aren't reachable. */
export function buildRpc(manifest: Manifest, runtime: FunctionRuntime, queries: QueryRunner, subs: SubscriptionManager, opts: RpcOptions) {
  const kinds = new Map<string, FunctionKind>();
  for (const f of manifest.functions) if (f.visibility !== "internal") kinds.set(f.name, f.kind);

  const send = (ws: ServerWebSocket<SocketData>, message: object) => void ws.send(JSON.stringify(message));

  return {
    /** Args are validated in the function runtime. */
    async call(name: string, req: Request, url: URL, ctx: Context & { cors?: Record<string, string> }): Promise<Response> {
      const kind = kinds.get(name);
      // Each call to a function that exists is a request (calls to unknown names are not, so they can't flood the operation list).
      const tel = opts.telemetry;
      const root = kind && tel?.begin(kind, name, req.method, ctx.traceparent, ctx.requestId);
      // The trace parent only when the query runs: a cache hit makes no ids.
      const obs: QueryObserver = root
        ? {
            get trace() {
              return tel!.parent(root);
            },
          }
        : {};
      try {
        if (!kind) throw new HttpError("NOT_FOUND", `No function "${name}"`);
        if (req.method === "GET" ? kind !== "query" : req.method !== "POST") throw new HttpError("METHOD_NOT_ALLOWED", `Call ${name} with ${kind === "query" ? "GET or POST" : "POST"}`);
        requireJson(req);
        const raw = await rawJson(req, "args", url, opts.maxRequestBytes);
        // A query's cache entry is keyed by the raw arguments and keeps its encoded response body: a hit parses, serializes and encodes nothing.
        const run = async (): Promise<string | Uint8Array<ArrayBuffer>> => {
          if (kind !== "query") {
            // A caller the server already knows goes along, so the function runtime needn't look them up again.
            const known = queries.known(ctx.headers);
            const r = await runtime.call(name, kind, parseJson(raw), ctx.headers, { requestId: ctx.requestId, trace: obs.trace, ...(known !== undefined && { identity: known }) });
            obs.telemetry = r.telemetry;
            return `{"result":${r.json ?? JSON.stringify(r.value) ?? "null"}}`;
          }
          const r = await queries.run(name, () => parseJson(raw), ctx.headers, ctx.requestId, raw, obs);
          return (r.body ??= encoder.encode(`{"result":${(r.json ??= JSON.stringify(r.value) ?? "null")}}`));
        };
        const body = await run();
        if (root) opts.telemetry!.end(root, { status: 200, telemetry: obs.telemetry, cache: obs.cache, user: obs.user });
        if (opts.reply) return opts.reply(body, { "content-type": JSON_TYPE, "x-request-id": ctx.requestId, ...ctx.cors });
        return new Response(body, { headers: { "content-type": JSON_TYPE, "x-request-id": ctx.requestId } });
      } catch (e) {
        if (root) opts.telemetry!.end(root, { ...failureOf(e), cache: obs.cache, user: obs.user });
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
      const held = (ws.data.held ??= new Map());
      const id = m.id;
      if (typeof id !== "string" || id.length > 64) return ws.close(1008, "Messages need a string id");
      if (m.type === "unsubscribe") return void (live.get(id)?.abort(), live.delete(id), held.delete(id));
      if (m.type !== "subscribe") return ws.close(1008, "Unknown message type");
      const name = String(m.name);
      const refuse = (code: ErrorCode, message: string) => send(ws, { type: "error", id, error: { message, code, requestId } satisfies ErrorBody });
      if (live.has(id)) return refuse("BAD_REQUEST", `Subscription ${id} already exists`);
      if (kinds.get(name) !== "query") return refuse("NOT_FOUND", `No query "${name}"`);
      if (live.size >= opts.maxSubscriptionsPerConnection) return refuse("TOO_MANY_REQUESTS", `At most ${opts.maxSubscriptionsPerConnection} subscriptions per connection`);
      // A subscription keeps its arguments for as long as it lives, so they are bounded, and kept as their JSON text: parsed, a small message can take many times its size in memory.
      const max = opts.maxSubscriptionBytes ?? 64 * 1024;
      if (raw.length > max) return refuse("PAYLOAD_TOO_LARGE", `A subscribe message is at most ${max} bytes (MAX_SUBSCRIPTION_BYTES)`);
      let holding = raw.length;
      for (const n of held.values()) holding += n;
      if (holding > max * 16) return refuse("PAYLOAD_TOO_LARGE", `The live queries of one connection hold at most ${max * 16} bytes of arguments (16 × MAX_SUBSCRIPTION_BYTES)`);
      const args = JSON.stringify(m.args ?? {});
      const stop = new AbortController();
      live.set(id, stop);
      held.set(id, raw.length);
      void (async () => {
        try {
          // A value comes with its JSON, built once for every subscriber of the query, so a fan-out to many sockets serializes it once.
          for await (const { json, ...data } of subs.subscribe(name, () => JSON.parse(args), ws.data.headers, stop.signal, requestId, args))
            json === undefined ? send(ws, { type: "data", id, data }) : void ws.send(`{"type":"data","id":${JSON.stringify(id)},"data":{"value":${json}}}`);
        } catch (e) {
          if (!stop.signal.aborted) send(ws, { type: "error", id, error: toPublicError(e, requestId, opts.dev, { function: name }) });
        } finally {
          if (live.get(id) === stop) (live.delete(id), held.delete(id));
        }
      })();
    },

    close(ws: ServerWebSocket<SocketData>) {
      for (const stop of ws.data.live.values()) stop.abort();
      ws.data.live.clear();
      ws.data.held?.clear();
    },
  };
}

export type Rpc = ReturnType<typeof buildRpc>;
