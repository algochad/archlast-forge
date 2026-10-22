import type { FunctionKind } from "../functions";
import type { CallHeaders, CallResult, LogEntry } from "./executor";
import type { Manifest } from "./project";

export interface SerializedRequest {
  method: string;
  url: string;
  headers: [string, string][];
  body?: string;
}

export interface SerializedResponse {
  status: number;
  headers: [string, string][];
  body: string;
}

/** Server → function runtime. */
export type HostMessage = { id: number } & (
  | { t: "call"; name: string; kind: FunctionKind; args: unknown; headers: CallHeaders }
  | { t: "auth"; req: SerializedRequest }
  | { t: "docs"; table: string; limit: number }
  | { t: "scheduled"; limit: number }
);

export type RuntimeError = { message: string; code: "BAD_REQUEST" | "INTERNAL_SERVER_ERROR" };

/** Function runtime → server. */
export type RuntimeMessage =
  | { t: "ready"; manifest: Manifest }
  | { t: "fatal"; error: string }
  | { t: "result"; id: number; ok: true; value: CallResult | SerializedResponse | unknown }
  | { t: "result"; id: number; ok: false; error: RuntimeError }
  | { t: "publish"; topics: string[] }
  | { t: "log"; entry: LogEntry };
