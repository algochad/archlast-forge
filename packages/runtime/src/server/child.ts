// Function runtime process: runs the core (runtime-core.ts) behind IPC, so the server can restart it alone when code or dependencies change,
// and kill it if a call hangs.
import { serializeError } from "./executor";
import type { Batch, HostEvent, HostMessage, HttpResponseMessage, RuntimeMessage } from "./protocol";
import { startCore } from "./runtime-core";

// One IPC write per turn of the event loop instead of one per message.
const outbox: RuntimeMessage[] = [];
const flush = () => {
  const messages = outbox.splice(0);
  process.send!(messages.length === 1 ? messages[0] : ({ t: "batch", messages } satisfies Batch<RuntimeMessage>));
};
const send = (msg: RuntimeMessage) => {
  if (outbox.push(msg) === 1) setImmediate(flush);
};
process.on("disconnect", () => process.exit(0)); // the server is gone

async function main() {
  const core = await startCore({
    forgeDir: process.env.ARCHLAST_FORGE_DIR!,
    env: process.env,
    worker: Number(process.env.ARCHLAST_WORKER ?? 0),
    serverId: process.env.ARCHLAST_SERVER_ID ?? "local",
    dev: process.env.ARCHLAST_DEV === "1",
    send,
  });

  async function answer(msg: HostMessage) {
    try {
      const value = await core.handle(msg);
      const res = value as HttpResponseMessage;
      if (res?.stream && res.body instanceof ReadableStream) {
        // A stream can't cross IPC: the result goes now, the bytes follow as they are written.
        send({ t: "result", id: msg.id, ok: true, value: { ...res, body: new ArrayBuffer(0) } });
        void pump(msg.id, res.body);
      } else send({ t: "result", id: msg.id, ok: true, value });
    } catch (e) {
      send({ t: "result", id: msg.id, ok: false, error: serializeError(e) });
    }
  }

  /** Streamed bodies being sent, so the server can stop one when its client leaves. */
  const pumps = new Map<number, ReadableStreamDefaultReader<Uint8Array>>();
  async function pump(id: number, body: ReadableStream<Uint8Array>) {
    const reader = body.getReader();
    pumps.set(id, reader);
    try {
      for (let r = await reader.read(); !r.done; r = await reader.read()) send({ t: "chunk", id, data: r.value.buffer.slice(r.value.byteOffset, r.value.byteOffset + r.value.byteLength) as ArrayBuffer });
      send({ t: "chunk", id, end: true });
    } catch (e) {
      send({ t: "chunk", id, error: (e as Error)?.message ?? String(e) });
    } finally {
      pumps.delete(id);
    }
  }

  // Cancelling the reader cancels the body, which is how the handler hears that its client left (`res` and `req` emit "close").
  const take = (m: HostMessage | HostEvent) => (m.t === "cancel" ? void pumps.get(m.id)?.cancel().catch(() => {}) : m.t === "ws" || m.t === "relay" ? core.event(m) : void answer(m));
  process.on("message", async (msg: HostMessage | HostEvent | Batch<HostMessage | HostEvent> | { t: "shutdown" }) => {
    if (msg.t === "shutdown") {
      await core.shutdown();
      process.exit(0);
    }
    if (msg.t === "batch") for (const m of msg.messages) take(m);
    else take(msg);
  });
  send({ t: "ready", manifest: core.manifest });
}

main().catch((e) => {
  send({ t: "fatal", error: (e as Error)?.message ?? String(e) });
  setTimeout(() => process.exit(1), 50); // let the IPC message flush
});
