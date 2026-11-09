import type { HeaderInit } from "./codec.ts";

/**
 * A file response streamed by the native side (no buffering, so multi-GiB downloads are fine). It handles HEAD,
 * `Range` (206/416), `ETag`/`Last-Modified` validation (304) and derives the content type from the extension.
 */
export class FileReply {
  path: string;
  status: number;
  headers: HeaderInit | null;
  /** Explicit content type; otherwise derived from the file extension. */
  contentType: string | null;
  /** Honour Range requests (default true). */
  range: boolean;

  constructor(
    path: string,
    init: {
      status?: number;
      headers?: HeaderInit;
      contentType?: string;
      range?: boolean;
    } = {},
  ) {
    this.path = path;
    this.status = init.status ?? 200;
    this.headers = init.headers ?? null;
    this.contentType = init.contentType ?? null;
    this.range = init.range ?? true;
  }
}

/** `return file("./public/logo.png")` from a handler. */
export function file(
  path: string,
  init?: ConstructorParameters<typeof FileReply>[1],
): FileReply {
  return new FileReply(path, init);
}
