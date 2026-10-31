// How a failed request is recorded: its status as the client sees it, and the error behind it (with the spans its call recorded).
import { HttpError } from "../rpc";
import { RuntimeCallError } from "../runtime";
import { handledKind, statusOf, type Outcome } from "./recorder";

const STATUS: Record<string, number> = { BAD_REQUEST: 400, UNAUTHORIZED: 401, FORBIDDEN: 403, NOT_FOUND: 404, METHOD_NOT_ALLOWED: 405, UNSUPPORTED_MEDIA_TYPE: 415, TOO_MANY_REQUESTS: 429 };

export function failureOf(e: unknown): Outcome {
  if (e instanceof HttpError) return { status: STATUS[e.code] ?? 400, error: { type: "HttpError", message: e.message, handled: true } };
  const err = e instanceof RuntimeCallError ? e : undefined;
  const kind = err?.kind ?? "internal";
  return {
    status: statusOf(kind),
    error: {
      type: err?.type ?? ((e as Error)?.constructor?.name || "Error"),
      message: (e as Error)?.message ?? String(e),
      stack: err ? err.detail : (e as Error)?.stack,
      handled: handledKind(kind),
    },
    telemetry: err?.telemetry,
  };
}
