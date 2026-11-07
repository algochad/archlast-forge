import type { Backend, LaneBinding } from "../backend.ts";
import { nativePath } from "../paths.ts";

export function backend(): Backend {
  // Each Bun thread (main or worker) loads its own instance of the addon; the Rust registry is process-wide.
  const addon = require(nativePath("archlast_serve.node"));
  return {
    name: "napi",
    start: (opts, lanes) => addon.start(opts, lanes),
    attach(id, lane, notify): LaneBinding {
      const l = new addon.Lane(id, lane, notify);
      return {
        drain: (buf) => l.drain(buf),
        park: () => l.park(),
        command: (buf, len) => l.command(buf, len),
        detach: () => l.detach(),
      };
    },
    detachLane: (id, lane) => addon.detachLane(id, lane),
    drainBegin: (id) => addon.drainBegin(id),
    openConnections: (id) => addon.openConnections(id),
    stats: (id) => addon.stats(id) as [number, number, number],
    topicCount: (id, topic) => addon.topicCount(id, topic),
    wsBuffered: (id, ws) => addon.wsBuffered(id, ws),
    closeIdle: (id) => addon.closeIdle(id),
    stop: (id) => addon.stop(id),
  };
}
