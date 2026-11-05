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
import { gunzipSync, inflateSync } from "node:zlib";

declare const self: Worker;
/** The most an OTLP body may decompress to. */
const MAX_DECOMPRESSED = 32 * 1024 * 1024;

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
  writing = writing.then(() => store.write(batch)).catch((e) => failed("write", e));
  return writing;
};

/** Settings operations that change something take the dashboard user who asked. */
const ACTOR_OPS = new Set(["saveSlo", "saveAlertRule", "createKey"]);

async function call(op: string, args: Record<string, unknown>, actor = "system"): Promise<unknown> {
  if (op === "ingest") {
    const { signal, body, contentType, service, encoding } = args as { signal: Signal; body: ArrayBuffer; contentType: string; service?: string | null; encoding?: "gzip" | "deflate" };
    // Here, not on the server's thread; and capped, because a few KB of gzip can expand to gigabytes.
    const opts = { maxOutputLength: MAX_DECOMPRESSED };
    const bytes = encoding === "gzip" ? gunzipSync(body, opts) : encoding === "deflate" ? inflateSync(body, opts) : new Uint8Array(body);
    const payload = parse(signal, bytes, contentType);
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

/**
 * The store's background work failing (a write each second, alert checks each minute): one line a minute for each kind, with how many were
 * left out, so a database that refuses connections doesn't fill the log with the same message.
 */
const failures = new Map<string, { at: number; skipped: number }>();
function failed(what: string, e: unknown) {
  const now = Date.now();
  const last = failures.get(what);
  if (last && now - last.at < 60_000) return void last.skipped++;
  const more = last?.skipped ? ` (and ${last.skipped} more in the last minute)` : "";
  failures.set(what, { at: now, skipped: 0 });
  console.error(`[telemetry] ${what} failed: ${(e as Error).message}${more}`);
}

const reply = (msg: WorkerReply) => self.postMessage(msg);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  if (msg.t === "init") {
    try {
      db = msg.databaseUrl ? createPostgresDb(msg.databaseUrl, 2, 1) /* TELEMETRY_CONNECTIONS: Bun opens a pool's connections at once, and the default write pool would be twice the reads */ : createSqliteDb(msg.path!, 2, undefined, "NORMAL");
      await migrateTelemetry(db);
      store = new TelemetryStore(db);
      queries = buildQueries(db);
      settings = buildSettings(db);
      const retention = msg.retentionDays;
      // Hourly upkeep, the first a minute after start so a restart loop can't spend its life compacting.
      setTimeout(function upkeep() {
        store.compact(retention).catch((e) => failed("compaction", e));
        setTimeout(upkeep, 3600_000);
      }, 60_000);
      setInterval(() => {
        const batch = ingest.drain();
        if (Object.keys(batch).length) void write(batch);
      }, 5000);
      if (msg.alerts) setInterval(() => void settings.evaluate().catch((e) => failed("alert evaluation", e)), 60_000);
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
