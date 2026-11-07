import { backend as bunFfi } from "./backends/bun-ffi.ts";
import { backend as napi } from "./backends/napi.ts";

export type BackendName = "bun-ffi" | "napi";

/** One JS thread's connection to a lane of a running server. */
export interface LaneBinding {
    /** Fills `buf` with queued events. Returns bytes written, 0 if none, or -needed if the first one does not fit. */
    drain(buf: Uint8Array): number;
    /** Call when idle: true if work arrived meanwhile (keep draining), false once the lane is asleep and will be notified. */
    park(): boolean;
    /** Executes the first `len` bytes of `buf` (a command batch). */
    command(buf: Uint8Array, len: number): void;
    /** Disconnects this thread; the lane stops receiving work. */
    detach(): void;
}

export interface Backend {
    readonly name: BackendName;
    /** Starts the Rust server (main thread only). */
    start(opts: Uint8Array, lanes: number): { id: number; port: number };
    /** `notify` fires on the calling JS thread, coalesced, whenever the lane has work. */
    attach(id: number, lane: number, notify: () => void): LaneBinding;
    /** Marks a lane dead (its worker died) so no new work is routed to it. */
    detachLane(id: number, lane: number): void;
    /** Begins a graceful shutdown (non-blocking). False if this engine cannot drain. */
    drainBegin(id: number): boolean;
    openConnections(id: number): number;
    /** `[pending requests, open WebSockets, open connections]` */
    stats(id: number): [number, number, number];
    topicCount(id: number, topic: string): number;
    /** Bytes queued for a WebSocket (-1 if it is gone). */
    wsBuffered(id: number, ws: number): number;
    /** Closes keep-alive connections with no request in flight; returns how many. */
    closeIdle(id: number): number;
    stop(id: number): void;
}

// Both backends run on Bun only: "bun-ffi" via bun:ffi, "napi" via Bun's Node-API support.
const loaded = new Map<BackendName, Backend>();

export function getBackend(name: BackendName): Backend {
    let b = loaded.get(name);
    if (!b) loaded.set(name, (b = name === "bun-ffi" ? bunFfi() : napi()));
    return b;
}

export function defaultBackend(): BackendName {
    const forced = process.env.ARCHLAST_BACKEND;
    return forced === "bun-ffi" || forced === "napi" ? forced : "napi";
}
