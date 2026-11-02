// A microservice's telemetry, sent to the main app whose dashboard shows it (DASHBOARD_URL): the batches the recorder makes once a second, as
// JSON, to POST /_telemetry there, where they go into that app's store as they would into this one's. While the main app is away (a restart, a
// deploy) batches wait, up to a minute of them; a batch it refuses is dropped, since sending it again won't change the answer.
import { log } from "../logger";
import type { TelemetryBatch } from "./types";

/** Batches kept while the main app can't be reached: one a second, so about a minute. */
const KEEP = 60;

export function telemetryForwarder(url: string, token: string) {
  const queue: TelemetryBatch[] = [];
  let sending = false;
  let warnedAt = 0;
  const warn = (message: string) => {
    if (Date.now() - warnedAt < 60_000) return;
    warnedAt = Date.now();
    log("warn", message);
  };
  const send = async () => {
    if (sending || !queue.length) return;
    sending = true;
    const batches = queue.splice(0);
    // In the order they were made: a minute's rollup is sent again as it grows, and the store keeps the last one it is given.
    const merged: Record<string, unknown[]> = {};
    for (const b of batches) for (const [k, v] of Object.entries(b)) (merged[k] ??= []).push(...(v as unknown[]));
    try {
      const res = await fetch(`${url}/_telemetry`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify(merged),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.status >= 500) throw new Error(`it answered ${res.status}`);
      if (!res.ok) warn(`the dashboard at ${url} refused this service's telemetry (${res.status}): ${(await res.text()).slice(0, 300)}`);
    } catch (e) {
      queue.unshift(...batches);
      if (queue.length > KEEP) queue.splice(0, queue.length - KEEP);
      warn(`couldn't send telemetry to the dashboard at ${url} (DASHBOARD_URL): ${(e as Error).message}`);
    } finally {
      sending = false;
    }
  };
  return (batch: TelemetryBatch) => {
    queue.push(batch);
    void send();
  };
}
