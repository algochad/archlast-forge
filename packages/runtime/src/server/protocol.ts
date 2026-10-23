import type { FunctionKind, UserIdentity } from "../functions";
import type { CallHeaders, CallResult, LogEntry, SerializedError } from "./executor";
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
  | { t: "call"; name: string; kind: FunctionKind; args: unknown; headers: CallHeaders; allowInternal?: boolean; requestId?: string; identity?: UserIdentity | null }
  | { t: "identity"; headers: CallHeaders }
  | { t: "auth"; req: SerializedRequest }
  | { t: "admin"; op: string; args?: Record<string, unknown>; actor: string }
);

/** Function runtime → server. */
export type RuntimeMessage =
  | { t: "ready"; manifest: Manifest }
  | { t: "fatal"; error: string }
  | { t: "result"; id: number; ok: true; value: CallResult | SerializedResponse | unknown }
  | { t: "result"; id: number; ok: false; error: SerializedError }
  | { t: "publish"; topics: string[] }
  | { t: "log"; entry: LogEntry };
