// The telemetry store's own thread: it holds the store's database connections, writes what the server sends, answers the dashboard's
// queries, decodes OTLP payloads, compacts and expires old data, and evaluates alert rules. A slow analytical query here never delays a
// request.
import { createPostgresDb } from "../db/postgres";
import { createSqliteDb } from "../db/sqlite";
import type { Db } from "../db/types";
import { OtlpIngest, parse, type Signal } from "./otlp";
import { buildQueries } from "./queries";
import { buildSettings } from "./settings";
import { migrateTelemetry, TelemetryStore } from "./store";
import type { TelemetryBatch } from "./types";

declare const self: Worker;

export type WorkerInit = { t: "init"; databaseUrl?: string; path?: string; retentionDays: number; alerts: boolean };
export type WorkerRequest = WorkerInit | { t: "write"; batch: TelemetryBatch } | { t: "call"; id: number; op: string; args: Record<string, unknown>; actor?: string };
export type WorkerReply = { t: "ready" } | { t: "fatal"; error: string } | { t: "result"; id: number; ok: true; value: unknown } | { t: "result"; id: number; ok: false; error: string };

let db: Db;
let store: TelemetryStore;
let queries: ReturnType<typeof buildQueries>;
let settings: ReturnType<typeof buildSettings>;
const ingest = new OtlpIngest();
/** Settled once the store is open: batches the server sends before then wait for it. */
const opened = Promise.withResolvers<void>();
opened.promise.catch(() => {});
/** Writes one after another, so a burst of batches doesn't open a transaction each at once. */
let writing: Promise<unknown> = opened.promise;
const write = (batch: TelemetryBatch) => {
  writing = writing.then(() => store.write(batch)).catch((e) => console.error("[telemetry] write failed:", (e as Error).message));
  return writing;
};

/** Settings operations that change something take the dashboard user who asked. */
const ACTOR_OPS = new Set(["saveSlo", "saveAlertRule", "createKey"]);

async function call(op: string, args: Record<string, unknown>, actor = "system"): Promise<unknown> {
  if (op === "ingest") {
    const { signal, body, contentType, service } = args as { signal: Signal; body: ArrayBuffer; contentType: string; service?: string | null };
    const payload = parse(signal, new Uint8Array(body), contentType);
    const batch = signal === "traces" ? ingest.traces(payload, service) : signal === "logs" ? ingest.logs(payload, service) : ingest.metrics(payload, service);
    await write(batch);
    return { traces: batch.traces?.length ?? 0, spans: (batch.traces ?? []).reduce((n, t) => n + t.spans.length, 0) + (batch.spans?.length ?? 0), logs: batch.logs?.length ?? 0, metrics: batch.metrics?.length ?? 0 };
  }
  if (op === "flush") return writing.then(() => true);
  if (op === "compact") return store.compact(Number(args.retentionDays) || 7, Number(args.now) || Date.now()).then(() => true);
  if (op === "evaluateAlerts") return settings.evaluate(Number(args.now) || Date.now()).then(() => true);
  const fn = (Object.hasOwn(queries, op) ? (queries as Record<string, Function>)[op] : Object.hasOwn(settings, op) ? (settings as Record<string, Function>)[op] : undefined) as
    | ((args: unknown, actor?: string) => Promise<unknown>)
    | undefined;
  if (!fn) throw new Error(`Unknown telemetry operation "${op}"`);
  await writing; // reads see what was sent before them
  return ACTOR_OPS.has(op) ? fn(args, actor) : fn(args);
}

const reply = (msg: WorkerReply) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.t === "init") {
    try {
      db = msg.databaseUrl ? createPostgresDb(msg.databaseUrl, 3) : createSqliteDb(msg.path!, 2);
      await migrateTelemetry(db);
      store = new TelemetryStore(db);
      queries = buildQueries(db);
      settings = buildSettings(db);
      const retention = msg.retentionDays;
      // Hourly upkeep, the first a minute after start so a restart loop can't spend its life compacting.
      setTimeout(function upkeep() {
        store.compact(retention).catch((e) => console.error("[telemetry] compaction failed:", (e as Error).message));
        setTimeout(upkeep, 3600_000);
      }, 60_000);
      setInterval(() => {
        const batch = ingest.drain();
        if (Object.keys(batch).length) void write(batch);
      }, 5000);
      if (msg.alerts) setInterval(() => void settings.evaluate().catch((e) => console.error("[telemetry] alert evaluation failed:", (e as Error).message)), 60_000);
      opened.resolve();
      reply({ t: "ready" });
    } catch (e) {
      opened.reject(e);
      reply({ t: "fatal", error: (e as Error).message });
    }
    return;
  }
  if (msg.t === "write") return void write(msg.batch);
  try {
    reply({ t: "result", id: msg.id, ok: true, value: await call(msg.op, msg.args ?? {}, msg.actor) });
  } catch (e) {
    reply({ t: "result", id: msg.id, ok: false, error: (e as Error).message });
  }
};
