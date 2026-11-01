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
    sample: true,
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

  /**
   * Queries wait here and start a few per turn of the event loop. Against SQLite they never wait for I/O, so started all at once a
   * burst finishes as one long run of microtasks: no answer is sent and no message is read until the last call is done, and the server, which
   * has heard nothing, takes a long queue for a hang. A turn starts as many as fit in TURN_MS at the pace queries have been taking (cheap
   * ones go together, a heavy one alone), so answers go out as they are ready. Up to MAX_ACTIVE overlap when they really wait (Postgres). Mutations bypass it: the one writer already runs them in turn, and mutations that start together are committed together
   * (group commit), which one start per turn would undo. Actions, HTTP routes and the rest may run for minutes, so they never hold a place in it either.
   */
  const MAX_ACTIVE = 32;
  const TURN_MS = 4;
  const queue: HostMessage[] = [];
  let active = 0;
  let pumping = false;
  /** What a query has taken lately, per query started: the time from one turn to the next over the number started in it. */
  let perQueryMs = 1;
  let lastTurn = { at: 0, started: 0 };
  const schedule = () => {
    if (pumping || !queue.length || active >= MAX_ACTIVE) return;
    pumping = true;
    setImmediate(startNext);
  };
  function startNext() {
    pumping = false;
    const now = performance.now();
    // The turns ran back to back only while the queue stayed full; a gap says nothing about how long a query takes.
    if (lastTurn.started && now - lastTurn.at < 100) perQueryMs = perQueryMs * 0.7 + ((now - lastTurn.at) / lastTurn.started) * 0.3;
    let started = 0;
    for (const room = Math.min(MAX_ACTIVE - active, Math.max(1, Math.floor(TURN_MS / perQueryMs))); started < room && queue.length; started++) {
      const m = queue.shift()!;
      active++;
      // A call that waited past a function's whole time limit would have timed out: refuse it, retryably, instead of running it for nobody.
      const done = m.deadline !== undefined && Date.now() > m.deadline ? Promise.resolve(send({ t: "result", id: m.id, ok: false, error: { kind: "overloaded", message: "Server is busy, try again" } })) : answer(m);
      void done.finally(() => {
        active--;
        schedule();
      });
    }
    lastTurn = { at: now, started };
    schedule();
  }
  const short = (m: HostMessage) => (m.t === "call" && m.kind === "query") || m.t === "identity";

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
  const take = (m: HostMessage | HostEvent) => {
    if (m.t === "cancel") return void pumps.get(m.id)?.cancel().catch(() => {});
    if (m.t === "ws" || m.t === "relay") return core.event(m);
    if (!short(m)) return void answer(m);
    queue.push(m);
    schedule();
  };
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
