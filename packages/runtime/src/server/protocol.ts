import type { FunctionKind, UserIdentity } from "../functions";
import type { CallHeaders, CallResult, LogEntry, SerializedError } from "./executor";
import type { Manifest } from "./project";
import type { CallTelemetry, TraceParent } from "./telemetry/context";
import type { MetricPoint, RuntimeSample, TraceRecord } from "./telemetry/types";

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
  telemetry?: CallTelemetry;
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
  /** A stream for a response that is sent as it is written (`stream`): across IPC its bytes follow as `chunk` messages. */
  body: ArrayBuffer | ReadableStream<Uint8Array>;
  stream?: true;
  telemetry?: CallTelemetry;
}

/** Server → function runtime, with no answer: the sockets of Nest gateways and GraphQL subscriptions under /http. */
export type HostEvent =
  | { t: "ws"; op: "open"; sid: string; path: string; headers: [string, string][]; requestId?: string }
  | { t: "ws"; op: "message"; sid: string; data: string | ArrayBuffer }
  | { t: "ws"; op: "close"; sid: string; code: number; reason: string }
  /** The client left a streamed response (by the id of the call that started it). */
  | { t: "cancel"; id: number }
  /** A PubSub event from one worker, for every worker (createPubSub in @archlast/forge-runtime/nest). */
  | { t: "relay"; topic: string; payload: unknown };

/** Function runtime → server: what a gateway sends to one of those sockets, or that it closes it. */
export type SocketMessage = { t: "ws"; op: "send"; sid: string; data: string | ArrayBuffer } | { t: "ws"; op: "close"; sid: string; code?: number; reason?: string };

/** Server → function runtime. */
export type HostMessage = {
  id: number;
  /** For a query: when waiting for its turn in the process has gone on as long as it may (epoch ms). A call still queued then isn't run. */
  deadline?: number;
} & (
  | {
      t: "call";
      name: string;
      kind: FunctionKind;
      args: unknown;
      headers: CallHeaders;
      allowInternal?: boolean;
      requestId?: string;
      identity?: UserIdentity | null;
      trace?: TraceParent;
      access?: "only" | "skip";
    }
  | { t: "identity"; headers: CallHeaders; detail?: boolean }
  | { t: "auth"; req: SerializedRequest; trace?: TraceParent }
  | { t: "http"; req: HttpRequestMessage; headers: CallHeaders; requestId?: string; trace?: TraceParent }
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
  | { t: "log"; entry: LogEntry }
  | { t: "chunk"; id: number; data?: ArrayBuffer; end?: true; error?: string }
  | { t: "relay"; topic: string; payload: unknown }
  /** A trace the runtime started itself (a scheduled job), finished. */
  | { t: "trace"; trace: TraceRecord }
  /** Custom metrics recorded since the last of these, as they stand now. */
  | { t: "metrics"; points: Omit<MetricPoint, "service" | "instance">[]; instance: string }
  /** The runtime process's own CPU, memory and event loop, every 10 seconds (in a child process; inline it is the server's). */
  | { t: "sample"; sample: Omit<RuntimeSample, "service"> }
  | SocketMessage;
