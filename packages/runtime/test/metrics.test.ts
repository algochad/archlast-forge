import { expect, test } from "bun:test";
import { Metrics } from "../src/server/metrics";

test("/metrics has each process's event-loop delay, and sub-millisecond latency buckets per function", () => {
  const m = new Metrics();
  m.observe("todos:list", 0.3, true);
  m.observe("todos:list", 7, true);
  const text = m.render(
    { subscriptions: 0, connections: 0, workers: 2 },
    undefined,
    new Map([
      ["srv", { role: "server", p99: 1.2, max: 4.5 }],
      ["srv/1", { role: "runtime", p99: 0.8, max: 2 }],
    ]),
  );
  expect(text).toContain('forge_function_duration_ms_bucket{function="todos:list",le="0.5"} 1');
  expect(text).toContain('forge_function_duration_ms_bucket{function="todos:list",le="10"} 2');
  expect(text).toContain('forge_event_loop_delay_ms{process="srv",role="server",stat="p99"} 1.2');
  expect(text).toContain('forge_event_loop_delay_ms{process="srv/1",role="runtime",stat="max"} 2');
});

test("/metrics shows how many queries wait in each function-runtime process, and about how long they would take", () => {
  const text = new Metrics().render({
    subscriptions: 0,
    connections: 0,
    workers: 2,
    backlog: [
      { waiting: 12, waitMs: 2400.4 },
      { waiting: 0, waitMs: 0 },
    ],
  });
  expect(text).toContain('forge_runtime_queue_waiting{worker="0"} 12');
  expect(text).toContain('forge_runtime_queue_wait_ms{worker="0"} 2400');
  expect(text).toContain('forge_runtime_queue_waiting{worker="1"} 0');
});
