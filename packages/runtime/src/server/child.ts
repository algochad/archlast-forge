// Function runtime process: runs the core (runtime-core.ts) behind IPC, so the server can restart it alone when code or dependencies change,
// and kill it if a call hangs.
import { serializeError } from "./executor";
import type { Batch, HostMessage, RuntimeMessage } from "./protocol";
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
      send({ t: "result", id: msg.id, ok: true, value: await core.handle(msg) });
    } catch (e) {
      send({ t: "result", id: msg.id, ok: false, error: serializeError(e) });
    }
  }

  process.on("message", async (msg: HostMessage | Batch<HostMessage> | { t: "shutdown" }) => {
    if (msg.t === "shutdown") {
      await core.shutdown();
      process.exit(0);
    }
    if (msg.t === "batch") for (const m of msg.messages) void answer(m);
    else await answer(msg);
  });
  send({ t: "ready", manifest: core.manifest });
}

main().catch((e) => {
  send({ t: "fatal", error: (e as Error)?.message ?? String(e) });
  setTimeout(() => process.exit(1), 50); // let the IPC message flush
});
