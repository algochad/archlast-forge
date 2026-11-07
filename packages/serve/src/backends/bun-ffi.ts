import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";
import type { Backend, LaneBinding } from "../backend.ts";
import { nativePath } from "../paths.ts";

export function backend(): Backend {
  // dlopen refcounts: every worker thread maps the same library, so the Rust-side registry is shared.
  const lib = dlopen(nativePath("archlast_serve_ffi.so"), {
    archlast_start: {
      args: [FFIType.ptr, FFIType.u32, FFIType.u32],
      returns: FFIType.u32,
    },
    archlast_last_error: {
      args: [FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    archlast_port: { args: [FFIType.u32], returns: FFIType.u32 },
    archlast_attach: {
      args: [FFIType.u32, FFIType.u32, FFIType.function],
      returns: FFIType.ptr,
    },
    archlast_drain: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    archlast_park: { args: [FFIType.ptr], returns: FFIType.i32 },
    archlast_command: {
      args: [FFIType.ptr, FFIType.ptr, FFIType.u32],
      returns: FFIType.i32,
    },
    archlast_detach: { args: [FFIType.ptr], returns: FFIType.void },
    archlast_detach_lane: {
      args: [FFIType.u32, FFIType.u32],
      returns: FFIType.void,
    },
    archlast_drain_begin: { args: [FFIType.u32], returns: FFIType.i32 },
    archlast_stats: { args: [FFIType.u32, FFIType.ptr], returns: FFIType.i32 },
    archlast_topic_count: {
      args: [FFIType.u32, FFIType.ptr, FFIType.u32],
      returns: FFIType.u32,
    },
    archlast_ws_buffered: {
      args: [FFIType.u32, FFIType.u32],
      returns: FFIType.i64,
    },
    archlast_close_idle: { args: [FFIType.u32], returns: FFIType.u32 },
    archlast_open_connections: { args: [FFIType.u32], returns: FFIType.u32 },
    archlast_stop: { args: [FFIType.u32], returns: FFIType.void },
  });
  const s = lib.symbols;

  const lastError = (fallback: string): Error => {
    const buf = new Uint8Array(512);
    const n = Math.min(s.archlast_last_error(ptr(buf), buf.length), buf.length);
    return new Error(new TextDecoder().decode(buf.subarray(0, n)) || fallback);
  };

  return {
    name: "bun-ffi",
    start(opts, lanes) {
      const id = s.archlast_start(ptr(opts), opts.length, lanes);
      if (id === 0) throw lastError("failed to start server");
      return { id, port: s.archlast_port(id) };
    },
    attach(id, lane, notify): LaneBinding {
      // threadsafe: the Rust side calls this from tokio worker threads.
      const cb = new JSCallback(notify, {
        args: [],
        returns: "void",
        threadsafe: true,
      });
      const handle = s.archlast_attach(id, lane, cb.ptr!);
      if (!handle) {
        cb.close();
        throw lastError("failed to attach lane");
      }
      // Large typed arrays have stable backing stores, so a pointer is cached per buffer.
      let drainBuf: Uint8Array | null = null;
      let drainPtr = 0;
      let cmdBuf: Uint8Array | null = null;
      let cmdPtr = 0;
      let detached = false;
      return {
        drain(buf) {
          if (detached) return 0;
          if (buf !== drainBuf) {
            drainBuf = buf;
            drainPtr = ptr(buf) as number;
          }
          return s.archlast_drain(handle, drainPtr, buf.length);
        },
        park() {
          return !detached && s.archlast_park(handle) !== 0;
        },
        command(buf, len) {
          if (detached) return;
          if (buf !== cmdBuf) {
            cmdBuf = buf;
            cmdPtr = ptr(buf) as number;
          }
          if (s.archlast_command(handle, cmdPtr, len) !== 0)
            throw lastError("command failed");
        },
        detach() {
          if (detached) return;
          detached = true;
          s.archlast_detach(handle);
          // A tokio thread may still be inside the callback; close it a little later.
          setTimeout(() => cb.close(), 2000).unref();
        },
      };
    },
    detachLane: (id, lane) => s.archlast_detach_lane(id, lane),
    drainBegin: (id) => s.archlast_drain_begin(id) === 1,
    openConnections: (id) => s.archlast_open_connections(id),
    stats(id) {
      const out = new BigUint64Array(3);
      s.archlast_stats(id, ptr(out));
      return [Number(out[0]), Number(out[1]), Number(out[2])];
    },
    topicCount(id, topic) {
      const b = new TextEncoder().encode(topic);
      return s.archlast_topic_count(id, ptr(b), b.length);
    },
    wsBuffered: (id, ws) => Number(s.archlast_ws_buffered(id, ws)),
    closeIdle: (id) => s.archlast_close_idle(id),
    stop: (id) => s.archlast_stop(id),
  };
}
