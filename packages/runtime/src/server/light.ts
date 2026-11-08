// A cheaper way for the server to hand a request to the handler of a route and take its answer back, for routes that can do without Web `Request` and
// `Response` objects (the Nest mount: its adapter reads the fields it needs and writes its own answer). A handler that has a `LIGHT` function is called
// with a `LightRequest` instead of a `Request`; what it answers is a `Response` or a `LightResponse`. Anything else takes the ordinary path.
export const LIGHT = Symbol.for("archlast-forge.light-http");

export interface LightRequest {
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

export class LightResponse {
  readonly status: number;
  readonly headers: [string, string][];
  readonly body: string | Uint8Array | null;
  constructor(status: number, headers: [string, string][], body: string | Uint8Array | null) {
    this.status = status;
    this.headers = headers;
    this.body = body;
  }
}

/** A JSON answer: `lightJson({ ok: true })`, `lightJson(item, 201)`. */
export const lightJson = (data: unknown, status = 200, headers: [string, string][] = []) => new LightResponse(status, [["content-type", "application/json"], ...headers], JSON.stringify(data));

/** A text answer: `lightText("ok")`. */
export const lightText = (text: string, status = 200, headers: [string, string][] = []) => new LightResponse(status, [["content-type", "text/plain;charset=utf-8"], ...headers], text);
