// The server side of Forge RPC: one function from a Request to a Response, for Bun.serve. Wire format in wire.ts. Bun only.
import { CODES, RpcFailure } from "./wire";

/** A Zod schema, or any Standard Schema. */
export type Schema = { readonly "~standard": unknown };

export interface Procedure {
  kind: "query" | "mutation";
  /** Checks what the caller sent. Without it the method gets no input at all. */
  input?: Schema;
  /** Checks what the method returned. */
  output?: Schema;
  /** Runs the method. Rejects with an RpcFailure for an error the caller is told about; anything else is a bug and is answered with a request id. */
  run(input: unknown, traceparent: string | undefined): Promise<unknown>;
}

export interface HandlerOptions {
  procedures: Map<string, Procedure>;
  /** Whether the Authorization header is the right one. */
  authorized(header: string | null): boolean;
  /** Most calls in one request or frame. */
  maxBatch?: number;
  /** Most bytes in a WebSocket frame. */
  maxPayload?: number;
  /**
   * Builds the answer to a call. A server whose engine has a cheaper type than Web `Response` (archlast-serve's `Reply`) says so here; it is
   * read at each call, so it may be set after the server has started. Default: `new Response`.
   */
  respond?: (body: string, status: number, headers: Record<string, string>) => Response;
}

/** Input or output that failed its schema. */
class Invalid {
  constructor(readonly message: string) {}
}

const JSON_HEADERS = { "content-type": "application/json" };

/**
 * A function that checks a value against `schema`: it returns the parsed value (a promise of it for an async schema), or throws Invalid.
 * Zod is called directly and synchronously, which is most of the cost of a call that has nothing else to do.
 */
function parserOf(schema: Schema): (value: unknown) => unknown {
  const s = schema as {
    safeParse?(v: unknown): { success: boolean; data?: unknown; error?: { message: string } };
    safeParseAsync?(v: unknown): Promise<{ success: boolean; data?: unknown; error?: { message: string } }>;
    "~standard": { validate(v: unknown): unknown };
  };
  const done = (r: { success: boolean; data?: unknown; error?: { message: string } }) => {
    if (r.success) return r.data;
    throw new Invalid(r.error?.message ?? "Invalid");
  };
  if (typeof s.safeParse === "function") {
    let async = false;
    return (value) => {
      if (!async)
        try {
          return done(s.safeParse!(value));
        } catch (e) {
          if (e instanceof Invalid) throw e;
          if (typeof s.safeParseAsync !== "function" || !/async/i.test(String((e as Error)?.name) + String((e as Error)?.message))) throw new Invalid((e as Error)?.message ?? "Invalid");
          async = true; // a refinement is async: this schema is only ever parsed asynchronously from now on
        }
      return s.safeParseAsync!(value).then(done);
    };
  }
  const std = s["~standard"];
  const finish = (r: any) => {
    if (r.issues) throw new Invalid(JSON.stringify(r.issues, null, 2));
    return r.value;
  };
  return (value) => {
    const r = std.validate(value);
    return r instanceof Promise ? r.then(finish) : finish(r);
  };
}

type Parsed = Procedure & { parseIn?: (v: unknown) => unknown; parseOut?: (v: unknown) => unknown };

const failure = (e: unknown): RpcFailure => {
  if (e instanceof RpcFailure) return e;
  const requestId = crypto.randomUUID();
  console.error(`[forge-rpc] a call failed (request ${requestId}):`, e);
  return new RpcFailure("INTERNAL_SERVER_ERROR", `Server error (request ${requestId})`, undefined, requestId);
};

const errorJson = (f: RpcFailure, path: string) =>
  JSON.stringify({ error: { message: f.message, code: (CODES[f.code] ?? CODES.INTERNAL_SERVER_ERROR!)[0], data: { code: f.code, httpStatus: (CODES[f.code] ?? CODES.INTERNAL_SERVER_ERROR!)[1], path, requestId: f.requestId, data: f.data } } });

/** What a call came to: its JSON text (a `{"result":…}` or `{"error":…}` object) and the HTTP status it stands for. */
interface Outcome {
  json: string;
  status: number;
}

/** What `Bun.serve` needs to serve Forge RPC: HTTP (`fetch`) and the faster WebSocket the client prefers (`websocket`). */
export interface Rpc {
  /** For `Bun.serve({ fetch })`: answers a call or a batch of calls, and upgrades a WebSocket request that carries the token. */
  fetch(req: Request, server: { upgrade(req: Request, options?: unknown): boolean }): Response | Promise<Response> | undefined;
  /** For `Bun.serve({ websocket })`. */
  websocket: any;
}

/**
 * The server: `createRpc(options)` gives `Bun.serve` its `fetch` and `websocket`. Over HTTP a request is a call or a batch (wire.ts). Over a
 * WebSocket the client sends frames of calls, `[[id, "router.method", input?, traceparent?], …]`, and the server answers with frames of
 * `[[id, {"result"|"error"…}], …]` (the same objects as the HTTP array holds) as calls finish, those that finish in the same tick in one frame.
 */
export function createRpc(options: HandlerOptions): Rpc {
  const procedures = new Map<string, Parsed>();
  for (const [name, p] of options.procedures) procedures.set(name, { ...p, parseIn: p.input && parserOf(p.input), parseOut: p.output && parserOf(p.output) });
  const maxBatch = options.maxBatch ?? 256;

  /** Runs one call: the check of its input, the method, the check of its output. Never rejects. */
  async function run(name: string, raw: unknown, get: boolean, trace: string | undefined): Promise<Outcome> {
    try {
      const p = procedures.get(name);
      if (!p) throw new RpcFailure("NOT_FOUND", `No procedure found on path "${name}"`);
      if (get && p.kind === "mutation") throw new RpcFailure("METHOD_NOT_SUPPORTED", `Unsupported GET-request to mutation procedure at path "${name}"`);
      let input: unknown;
      if (p.parseIn) {
        try {
          input = p.parseIn(raw);
          if (input instanceof Promise) input = await input;
        } catch (e) {
          throw e instanceof Invalid ? new RpcFailure("BAD_REQUEST", e.message) : e;
        }
      }
      let out: unknown = await p.run(input, trace);
      if (p.parseOut) {
        try {
          out = p.parseOut(out);
          if (out instanceof Promise) out = await out;
        } catch (e) {
          const requestId = crypto.randomUUID();
          console.error(`[forge-rpc] ${name} failed (request ${requestId}): the output broke its schema:`, e instanceof Invalid ? e.message : e);
          throw new RpcFailure("INTERNAL_SERVER_ERROR", `Server error (request ${requestId})`, undefined, requestId);
        }
      }
      const json = JSON.stringify(out);
      return { json: json === undefined ? '{"result":{}}' : `{"result":{"data":${json}}}`, status: 200 };
    } catch (e) {
      const f = failure(e);
      return { json: errorJson(f, name), status: (CODES[f.code] ?? CODES.INTERNAL_SERVER_ERROR!)[1] };
    }
  }

  const answer = (body: string, status: number): Response => (options.respond ? options.respond(body, status, JSON_HEADERS) : new Response(body, { status, headers: JSON_HEADERS }));

  async function handle(req: Request): Promise<Response> {
    const url = req.url;
    const method = req.method;
    const query = url.indexOf("?");
    let path = url.slice(url.indexOf("/", url.indexOf("//") + 2) + 1, query < 0 ? undefined : query);
    if (path.includes("%"))
      try {
        path = decodeURIComponent(path);
      } catch {}
    const batch = query >= 0 && url.includes("batch=1", query);
    const names = batch ? path.split(",") : [path];
    const n = names.length;
    const fail = (f: RpcFailure) => {
      const json = names.map((name) => errorJson(f, name));
      const status = (CODES[f.code] ?? CODES.INTERNAL_SERVER_ERROR!)[1];
      return answer(batch ? `[${json.join(",")}]` : json[0]!, status);
    };

    const get = method === "GET";
    if (!get && method !== "POST") return fail(new RpcFailure("METHOD_NOT_SUPPORTED", `Unsupported ${method}-request`));
    if (n > maxBatch) return fail(new RpcFailure("PAYLOAD_TOO_LARGE", `Batch size is too large (${n} calls; the most is ${maxBatch})`));
    if (!options.authorized(req.headers.get("authorization"))) return fail(new RpcFailure("UNAUTHORIZED", "Forge RPC: the bearer token is missing or wrong"));

    // The inputs: the body (POST), or the `input` parameter (GET).
    let inputs: any;
    try {
      const text = get ? new URL(url).searchParams.get("input") : await req.text();
      inputs = text ? JSON.parse(text) : undefined;
    } catch (e) {
      return fail(new RpcFailure("BAD_REQUEST", (e as Error)?.message ?? "Invalid JSON"));
    }
    const trace = req.headers.get("traceparent") ?? undefined;

    let outcomes: Outcome[];
    if (n === 1) outcomes = [await run(names[0]!, batch ? inputs?.[0] : inputs, get, trace)];
    else outcomes = await Promise.all(names.map((name, i) => run(name, inputs?.[i], get, trace)));

    // The status: 200 when every call worked; the one status every call failed with; else 207.
    let status = outcomes[0]!.status;
    for (let i = 1; i < n; i++) if (outcomes[i]!.status !== status) status = 207;
    return answer(batch ? `[${outcomes.map((o) => o.json).join(",")}]` : outcomes[0]!.json, status);
  }

  interface Socket {
    data: unknown;
    send(message: string): unknown;
    close(code?: number, reason?: string): void;
  }

  return {
    fetch(req, server) {
      if (req.headers.get("upgrade") === "websocket") {
        if (!options.authorized(req.headers.get("authorization"))) return new Response("Forge RPC: the bearer token is missing or wrong", { status: 401 });
        return server.upgrade(req) ? undefined : new Response("Forge RPC: this is not a WebSocket upgrade", { status: 400 });
      }
      return handle(req);
    },
    websocket: {
      maxPayloadLength: options.maxPayload ?? 8 * 1024 * 1024,
      idleTimeout: 120,
      perMessageDeflate: false,
      message(ws: Socket, message: string | Buffer) {
        let calls: any;
        try {
          if (typeof message !== "string") return ws.close(1003, "text frames only");
          calls = JSON.parse(message);
        } catch {
          return ws.close(1007, "not JSON");
        }
        if (!Array.isArray(calls) || calls.length > maxBatch) return ws.close(1009, `a frame carries at most ${maxBatch} calls`);
        // The answers go back in one frame once every call of this one has finished. A call that is slow doesn't hold the rest up: when
        // the first has finished the others get until the end of this turn of the event loop, and what is ready goes then.
        let left = calls.length;
        let ready: string[] = [];
        let flushing = false;
        const flush = () => {
          flushing = false;
          if (!ready.length) return;
          const frame = ready;
          ready = [];
          ws.send("[" + frame.join(",") + "]");
        };
        for (const call of calls) {
          if (!Array.isArray(call) || typeof call[1] !== "string") return ws.close(1007, "not a call");
          const noInput = call[0] < 0; // a negative id: the call has no input (see the client)
          const id = noInput ? -call[0] : call[0];
          void run(call[1], noInput ? undefined : call[2], false, typeof call[3] === "string" ? call[3] : undefined).then((o) => {
            ready.push(`[${id},${o.json}]`);
            if (--left === 0) flush();
            else if (!flushing) {
              flushing = true;
              setImmediate(flush);
            }
          });
        }
      },
    },
  };
}

/** The request handler for `Bun.serve({ fetch })`, HTTP only. */
export function createHandler(options: HandlerOptions): (req: Request) => Promise<Response> {
  const rpc = createRpc(options);
  return (req) => rpc.fetch(req, { upgrade: () => false }) as Promise<Response>;
}
