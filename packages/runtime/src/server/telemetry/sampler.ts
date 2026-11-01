// A process's own health, read every few seconds: CPU over the interval, memory, and how late the event loop ran timers.
// Bun has no event-loop-utilization or GC-pause figures (performance.eventLoopUtilization reads zero), so those aren't reported.
import { monitorEventLoopDelay } from "node:perf_hooks";

export type ProcessHealth = { cpu: number; cpuUser: number; cpuSystem: number; rss: number; heapUsed: number; heapTotal: number; loopMean: number; loopP99: number; loopMax: number };

/** Returns a function that reads the process's health since the last time it was called. */
export function processSampler(): () => ProcessHealth {
  const loop = monitorEventLoopDelay({ resolution: 20 });
  loop.enable();
  let cpu = process.cpuUsage();
  let at = performance.now();
  const ms = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);
  return () => {
    const used = process.cpuUsage(cpu);
    const wall = (performance.now() - at) * 1000; // µs, as cpuUsage counts
    cpu = process.cpuUsage();
    at = performance.now();
    // Not bun:jsc's heapStats(): it walks the whole heap on the main thread (180 ms at 100 MB of live objects, at every sample, in every process).
    const mem = process.memoryUsage();
    const health = {
      cpu: wall ? ((used.user + used.system) / wall) * 100 : 0,
      cpuUser: wall ? (used.user / wall) * 100 : 0,
      cpuSystem: wall ? (used.system / wall) * 100 : 0,
      rss: mem.rss,
      heapUsed: mem.heapUsed,
      heapTotal: mem.heapTotal,
      loopMean: ms(loop.mean),
      loopP99: ms(loop.percentile(99)),
      loopMax: ms(loop.max),
    };
    loop.reset();
    return health;
  };
}

export const instanceId = (serverId: string, worker?: number) => (worker === undefined ? serverId : `${serverId}/w${worker}`);
