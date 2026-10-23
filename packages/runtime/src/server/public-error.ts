import { log } from "./logger";
import { RuntimeCallError } from "./runtime";

export type PublicCode = "BAD_REQUEST" | "TIMEOUT" | "INTERNAL_SERVER_ERROR" | "SERVICE_UNAVAILABLE";

export interface PublicError {
  message: string;
  code: PublicCode;
  /** ForgeError data. */
  data?: unknown;
  requestId: string;
}

/**
 * What a caller may see. ForgeError and argument validation messages pass through; anything else is
 * "Server error" outside dev, with the full error logged under the request id.
 */
export function toPublicError(e: unknown, requestId: string, dev: boolean, context: Record<string, unknown> = {}): PublicError {
  const err = e instanceof RuntimeCallError ? e : new RuntimeCallError((e as Error)?.message ?? String(e), "internal", undefined, (e as Error)?.stack);
  switch (err.kind) {
    case "user":
      return { message: err.message, code: "BAD_REQUEST", data: err.data, requestId };
    case "validation":
      return { message: err.message, code: "BAD_REQUEST", requestId };
    case "overloaded":
      return { message: err.message, code: "SERVICE_UNAVAILABLE", requestId };
    case "timeout":
      log("warn", err.message, { requestId, ...context });
      return { message: err.message, code: "TIMEOUT", requestId };
    default:
      log("error", err.message, { requestId, ...context, stack: dev ? undefined : err.detail });
      return { message: dev ? err.message : `Server error (request ${requestId})`, code: "INTERNAL_SERVER_ERROR", requestId };
  }
}
