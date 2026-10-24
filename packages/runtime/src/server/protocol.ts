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

/** An HTTP action's request and response. Bodies are bytes: IPC uses structured clone, so they cross as they are. */
export interface HttpRequestMessage {
  method: string;
  url: string;
  headers: [string, string][];
  body?: ArrayBuffer;
}

export interface HttpResponseMessage {
  status: number;
  headers: [string, string][];
  body: ArrayBuffer;
}

/** Server → function runtime. */
export type HostMessage = { id: number } & (
  | { t: "call"; name: string; kind: FunctionKind; args: unknown; headers: CallHeaders; allowInternal?: boolean; requestId?: string; identity?: UserIdentity | null }
  | { t: "identity"; headers: CallHeaders }
  | { t: "auth"; req: SerializedRequest }
  | { t: "http"; req: HttpRequestMessage; headers: CallHeaders; requestId?: string }
  | { t: "admin"; op: string; args?: Record<string, unknown>; actor: string }
);

/** Messages in one direction sent in the same turn of the event loop travel as one, in order (a write's publish, log and result are three). */
export type Batch<M> = { t: "batch"; messages: M[] };

/** Function runtime → server. */
export type RuntimeMessage =
  | { t: "ready"; manifest: Manifest }
  | { t: "fatal"; error: string }
  | { t: "result"; id: number; ok: true; value: CallResult | SerializedResponse | HttpResponseMessage | unknown }
  | { t: "result"; id: number; ok: false; error: SerializedError }
  | { t: "publish"; topics: string[] }
  | { t: "log"; entry: LogEntry };
