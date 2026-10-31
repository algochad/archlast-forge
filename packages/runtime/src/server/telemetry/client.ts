// The server's handle on the telemetry worker: batches go one way, queries come back as promises.
import { log } from "../logger";
import type { TelemetryBatch } from "./types";
import type { WorkerInit, WorkerReply, WorkerRequest } from "./worker";

export class TelemetryClient {
  private worker: Worker;
  private seq = 0;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private failed?: string;
  readonly ready: Promise<void>;

  constructor(script: URL, init: Omit<WorkerInit, "t">) {
    this.worker = new Worker(script);
    const ready = Promise.withResolvers<void>();
    this.ready = ready.promise;
    this.worker.onmessage = (e: MessageEvent<WorkerReply>) => {
      const msg = e.data;
      if (msg.t === "ready") return ready.resolve();
      if (msg.t === "fatal") {
        this.failed = msg.error;
        log("error", "telemetry store failed to start", { error: msg.error });
        return ready.reject(new Error(msg.error));
      }
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.ok) p?.resolve(msg.value);
      else p?.reject(new Error(msg.error));
    };
    this.worker.onerror = (e) => {
      this.failed = e.message;
      log("error", "telemetry worker crashed", { error: e.message });
      for (const p of this.pending.values()) p.reject(new Error(`Telemetry store unavailable: ${e.message}`));
      this.pending.clear();
    };
    this.ready.catch(() => {});
    this.post({ t: "init", ...init });
  }

  private post(msg: WorkerRequest, transfer?: Transferable[]) {
    this.worker.postMessage(msg, transfer ? { transfer } : undefined);
  }

  write(batch: TelemetryBatch) {
    if (!this.failed) this.post({ t: "write", batch });
  }

  async call<T = unknown>(op: string, args: Record<string, unknown> = {}, actor?: string, transfer?: Transferable[]): Promise<T> {
    if (this.failed) throw new Error(`Telemetry store unavailable: ${this.failed}`);
    await this.ready;
    const id = ++this.seq;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.post({ t: "call", id, op, args, actor }, transfer);
    });
  }

  /** Decodes and stores an OTLP export; the body moves to the worker rather than being copied. */
  ingest(signal: "traces" | "logs" | "metrics", body: ArrayBuffer, contentType: string, service?: string | null) {
    return this.call<{ traces: number; spans: number; logs: number; metrics: number }>("ingest", { signal, body, contentType, service }, undefined, [body]);
  }

  /** Waits (a little) for what was sent to be written, then ends the worker. Calling it again does nothing. */
  async close() {
    if (this.failed === "closed") return;
    await Promise.race([this.call("flush").catch(() => {}), Bun.sleep(3000)]);
    this.failed = "closed";
    this.worker.terminate();
    for (const p of this.pending.values()) p.reject(new Error("Telemetry store closed"));
    this.pending.clear();
  }
}
