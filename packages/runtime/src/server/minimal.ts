// A cheaper way for the server to hand a request to the handler of a route and take its answer back, for routes that can do without Web `Request` and
// `Response` objects (the Nest mount: its adapter reads the fields it needs and writes its own answer). A handler that has a `MINIMAL` function is called
// with a `MinimalRequest` instead of a `Request`; what it answers is a `Response` or a `MinimalResponse`. Anything else takes the ordinary path.
export const MINIMAL = Symbol.for("archlast-forge.minimal-http");

// The handler can come from forge/node_modules while the engine uses its own runtime.
const MINIMAL_RESPONSE = Symbol.for("archlast-forge.minimal-response");
const legacyConstructors = new Set<typeof MinimalResponse>();

export interface MinimalRequest {
  method: string;
  /** Absolute, as a `Request`'s `url` is. */
  url: string;
  /** The path of `url`, and its query string with the `?` (empty when there is none). */
  path: string;
  search: string;
  /** Names are lower-case; a name may repeat. */
  headers: [string, string][];
  body?: ArrayBuffer;
}

export class MinimalResponse {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: string | Uint8Array | null;
  constructor(status: number, headers: [string, string][], body: string | Uint8Array | null) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

Object.defineProperty(MinimalResponse.prototype, MINIMAL_RESPONSE, { value: true });

/** Older installs export the same class without the shared brand. Accept actual instances of the app's exported class. */
export function registerLegacyMinimalResponse(ctor: unknown) {
  if (typeof ctor === "function" && ctor.prototype && !isMinimalResponse(ctor.prototype)) legacyConstructors.add(ctor as typeof MinimalResponse);
}

export function isMinimalResponse(value: unknown): value is MinimalResponse {
  if (value == null) return false;
  if ((value as { [MINIMAL_RESPONSE]?: unknown })[MINIMAL_RESPONSE] === true) return true;
  for (const ctor of legacyConstructors) if (value instanceof ctor) return true;
  return false;
}

/** A JSON answer: `minimalJson({ ok: true })`, `minimalJson(item, 201)`. */
export const minimalJson = (data: unknown, status = 200, headers: [string, string][] = []) => new MinimalResponse(status, [["content-type", "application/json"], ...headers], JSON.stringify(data));

/** A JSON answer from text that already is JSON: `minimalRaw(await ctx.read((c) => c.db.getJson(id)))`. Nothing is parsed or written out again. */
export const minimalRaw = (json: string, status = 200, headers: [string, string][] = []) => new MinimalResponse(status, [["content-type", "application/json"], ...headers], json);

/** A text answer: `minimalText("ok")`. */
export const minimalText = (text: string, status = 200, headers: [string, string][] = []) => new MinimalResponse(status, [["content-type", "text/plain;charset=utf-8"], ...headers], text);
