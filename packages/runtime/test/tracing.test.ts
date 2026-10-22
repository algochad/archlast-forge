import { expect, test } from "bun:test";
import { join } from "node:path";
import { startServer } from "../src/server/server";
import { tempDir } from "./helpers";

test("function calls are exported as OTLP spans that continue the caller's trace", async () => {
  const received: any[] = [];
  const collector = Bun.serve({ port: 0, fetch: async (req) => (received.push(await req.json()), new Response("{}")) });
  const srv = await startServer({
    convexDir: join(import.meta.dir, "fixture"),
    dev: true,
    env: { ...process.env, PORT: "0", DATA_DIR: tempDir(), OTEL_EXPORTER_OTLP_ENDPOINT: collector.url.href, OTEL_SERVICE_NAME: "forge-test" },
  });
  try {
    const traceId = "4bf92f3577b34da6a3ce929d0e0e4736";
    await fetch(`${srv.url}/trpc/todos.events?input=%7B%7D`, { headers: { traceparent: `00-${traceId}-00f067aa0ba902b7-01`, "x-request-id": "trace-req" } });
    await fetch(`${srv.url}/trpc/todos.crash?input=%7B%7D`);
    for (let i = 0; i < 50 && received.length === 0; i++) await Bun.sleep(100);
    const spans = received.flatMap((b) => b.resourceSpans[0].scopeSpans[0].spans);
    expect(received[0].resourceSpans[0].resource.attributes).toContainEqual({ key: "service.name", value: { stringValue: "forge-test" } });
    const events = spans.find((s: any) => s.name === "todos:events");
    expect(events).toMatchObject({ traceId, parentSpanId: "00f067aa0ba902b7", kind: 2, status: { code: 1 } });
    expect(events.attributes).toContainEqual({ key: "forge.request_id", value: { stringValue: "trace-req" } });
    expect(spans.find((s: any) => s.name === "todos:crash").status.code).toBe(2);
  } finally {
    await srv.stop();
    collector.stop(true);
  }
});
