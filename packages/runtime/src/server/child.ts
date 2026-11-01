// Function runtime process: runs the core (runtime-core.ts) behind IPC, so the server can restart it alone when code or dependencies change,
// and kill it if a call hangs.
import { serializeError, type CallResult } from "./executor";
import type { Batch, HostEvent, HostMessage, HttpResponseMessage, RuntimeMessage } from "./protocol";
import { startCore } from "./runtime-core";
import { toWire } from "./wire";

// One IPC write per turn of the event loop instead of one per message.
const outbox: RuntimeMessage[] = [];
/**
 * Bytes of results handed to the pipe whose write isn't done yet (`process.send` calls back when a message has been written), and when the last
 * write finished. A busy process only gets to write between its own turns, so a large result can wait seconds in the pipe; the queue of
 * queries holds back while too much is waiting there (see MAX_IN_FLIGHT), instead of running ahead of what can be delivered.
 */
let inFlight = 0;
let lastWritten = performance.now();
let written: () => void = () => {};
const weight = (m: RuntimeMessage) => (m.t === "result" && m.ok ? ((m.value as { json?: string } | undefined)?.json?.length ?? 0) : 0);
/** A result this big is written as a message of its own, so the pipe reports each one as it is done (a batch reports once, when all of it is). */
const OWN_MESSAGE = 64 << 10;
const flush = () => {
  const messages = outbox.splice(0);
  let batch: RuntimeMessage[] = [];
  const emit = () => {
    if (batch.length) process.send!(batch.length === 1 ? batch[0] : ({ t: "batch", messages: batch } satisfies Batch<RuntimeMessage>));
    batch = [];
  };
  // In the order they were made: a write's publish must reach the server before its result.
  for (const m of messages) {
    const bytes = weight(m);
    if (bytes < OWN_MESSAGE) {
      batch.push(m);
      continue;
    }
    emit();
    inFlight += bytes;
    (process.send as (message: unknown, callback: () => void) => boolean)(m, () => {
      inFlight -= bytes;
      lastWritten = performance.now();
      written();
    });
  }
  emit();
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
      } else send({ t: "result", id: msg.id, ok: true, value: msg.t === "call" ? toWire(value as CallResult) : value });
    } catch (e) {
      send({ t: "result", id: msg.id, ok: false, error: serializeError(e) });
    }
  }

  /**
   * Queries wait here and start a few per turn of the event loop. Against SQLite they never wait for I/O, so started all at once a burst
   * finishes as one long run of microtasks: no answer is sent and no message is read until the last call is done, and the server, which has
   * heard nothing, takes a long queue for a hang. A turn starts as many as fit in TURN_MS at the pace queries have been taking (cheap ones go
   * together, a heavy one alone), so answers go out as they are ready. Up to MAX_ACTIVE overlap when they really wait (Postgres), and none
   * starts while more than MAX_IN_FLIGHT bytes of results are still waiting to be written: the wait then happens here, where a deadline can
   * refuse a call, instead of in the pipe. Mutations bypass the queue: the one writer already runs them in turn, and mutations that start
   * together are committed together (group commit), which one start per turn would undo. Actions, HTTP routes and the rest may run for
   * minutes, so they never hold a place in it either.
   */
  const MAX_ACTIVE = 32;
  const TURN_MS = 4;
  const MAX_IN_FLIGHT = 4 << 20;
  const queue: HostMessage[] = [];
  let active = 0;
  let pumping = false;
  /** What a query has taken lately, per query started: the time from one turn to the next over the number started in it. */
  let perQueryMs = 1;
  let lastTurn = { at: 0, started: 0 };
  const refuse = (m: HostMessage) => send({ t: "result", id: m.id, ok: false, error: { kind: "overloaded", message: "Server is busy, try again" } });
  /**
   * A queued call that waited past a function's whole time limit would have timed out: it is refused, retryably, at that moment (the queue is in
   * order of arrival, so its oldest call is the first due), whatever the process is busy with, and never run for a caller who has gone.
   */
  const dropStale = () => {
    while (queue.length && queue[0]!.deadline !== undefined && Date.now() > queue[0]!.deadline!) refuse(queue.shift()!);
  };
  let purging: Timer | undefined;
  const purge = () => {
    clearTimeout(purging);
    purging = undefined;
    dropStale();
    const head = queue[0];
    if (head?.deadline !== undefined) purging = setTimeout(purge, Math.max(1, head.deadline - Date.now() + 1));
  };
  let waiting: Timer | undefined;
  const schedule = () => {
    dropStale();
    if (pumping || !queue.length || active >= MAX_ACTIVE) return;
    // Held back by results still in the pipe, unless nothing has been written for 5 s (then the pipe is not draining and waiting would only add to it).
    if (inFlight > MAX_IN_FLIGHT && performance.now() - lastWritten < 5000) {
      waiting ??= setTimeout(() => ((waiting = undefined), schedule()), 250);
      return;
    }
    pumping = true;
    setImmediate(startNext);
  };
  written = schedule;
  function startNext() {
    pumping = false;
    dropStale();
    const now = performance.now();
    // The turns ran back to back only while the queue stayed full; a gap says nothing about how long a query takes.
    if (lastTurn.started && now - lastTurn.at < 100) perQueryMs = perQueryMs * 0.7 + ((now - lastTurn.at) / lastTurn.started) * 0.3;
    let started = 0;
    for (const room = Math.min(MAX_ACTIVE - active, Math.max(1, Math.floor(TURN_MS / perQueryMs))); started < room && queue.length; started++) {
      const m = queue.shift()!;
      active++;
      void answer(m).finally(() => {
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
    if (!purging) purge();
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
