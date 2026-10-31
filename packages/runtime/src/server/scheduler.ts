import { getFunctionName, type CronJob, type CronSchedule, type RegisteredFunction } from "../functions";
import { validateFields, ValidationError } from "../values";
import type { Db, DbTx } from "./db/types";
export { migrateSystem as migrateScheduler } from "./system";
import type { Executor } from "./executor";
import { now, telemetryOf, traced, type CallTelemetry } from "./telemetry/context";
import { spanId, traceId } from "./telemetry/ids";
import { handledKind, statusOf } from "./telemetry/recorder";
import type { TraceRecord } from "./telemetry/types";
import { serializeError } from "./executor";

const T = `"_scheduled_functions"`;
const COLS = `("_id", "_creationTime", "name", "args", "scheduledTime", "state")`;


/** Inserts a job in the caller's transaction, so it exists only if that transaction commits. */
export async function schedule(tx: DbTx, functions: Map<string, RegisteredFunction>, at: number, ref: unknown, args: object = {}) {
  const name = getFunctionName(ref as any);
  const fn = functions.get(name);
  if (!fn || fn.kind === "query") throw new ValidationError(`Only mutations and actions can be scheduled; "${name}" is ${fn ? "a query" : "unknown"}`);
  validateFields(fn.args, args as Record<string, unknown>, "args");
  const id = `_scheduled_functions:${crypto.randomUUID().replaceAll("-", "")}`;
  await tx.execute(`INSERT INTO ${T} ${COLS} VALUES (?, ?, ?, ?, ?, 'pending')`, [id, Date.now(), name, JSON.stringify(args), at]);
  return id;
}

export const cancelScheduled = (tx: DbTx, id: string) =>
  tx.execute(`UPDATE ${T} SET "state" = 'canceled', "completedTime" = ? WHERE "_id" = ? AND "state" = 'pending'`, [Date.now(), id]);

/** Schedules a failed or canceled job again, now. */
export async function retryScheduled(tx: DbTx, id: string) {
  const [job] = await tx.query<{ name: string; args: string; state: string }>(`SELECT "name", "args", "state" FROM ${T} WHERE "_id" = ?`, [id]);
  if (!job || !["failed", "canceled"].includes(job.state)) throw new ValidationError("Only failed or canceled jobs can be retried");
  const newId = `_scheduled_functions:${crypto.randomUUID().replaceAll("-", "")}`;
  await tx.execute(`INSERT INTO ${T} ${COLS} VALUES (?, ?, ?, ?, ?, 'pending')`, [newId, Date.now(), job.name, job.args, Date.now()]);
  return newId;
}

export const nextRun = (s: CronSchedule, after: number): number =>
  s.kind === "interval" ? (Math.floor(after / s.ms) + 1) * s.ms : (Bun.cron.parse(s.expression, after, { tz: "UTC" })?.getTime() ?? Infinity);

/**
 * Polls for due jobs. Mutations are exactly-once: the job is claimed in the mutation's own transaction.
 * Actions are at-most-once: claimed as "running" first, never retried automatically. A running claim is a lease:
 * once it's older than the action timeout plus a grace period, the server that held it is presumed dead and the job fails.
 */
export class SchedulerLoop {
  private timer?: Timer;
  private stopped = false;
  private crons: { job: CronJob; next: number }[];

  constructor(
    private exec: Executor,
    private db: Db,
    private functions: Map<string, RegisteredFunction>,
    crons: CronJob[],
    private actionLeaseMs = 600_000 + 60_000,
    private pollMs = 500,
    /** How long finished jobs are kept for the dashboard. */
    private retentionMs = 7 * 86_400_000,
    /** Each job that ran, as a trace. */
    private onTrace?: (trace: TraceRecord) => void,
  ) {
    const now = Date.now();
    this.crons = crons.map((job) => ({ job, next: nextRun(job.schedule, now) }));
  }

  start() {
    const loop = async () => {
      try {
        // Jobs start and the loop moves on: a slow action must not hold up the others, or the crons behind it.
        for (const job of await this.poll()) job.catch((e) => console.error("[scheduler]", e));
      } catch (e) {
        console.error("[scheduler]", e);
      }
      if (!this.stopped) this.timer = setTimeout(loop, this.pollMs);
    };
    this.timer = setTimeout(loop, 0);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }

  /** Next run time of each cron, for the dashboard. */
  nextRuns() {
    return Object.fromEntries(this.crons.map((c) => [c.job.name, c.next]));
  }

  private lastSweep = 0;

  private inflight = new Set<string>();
  /** Most jobs running at once on this server. */
  private static readonly MAX_RUNNING = 50;

  /** Finds the due jobs and starts them; resolves when they are all running, with a promise for each job. */
  async tick(now = Date.now()) {
    await Promise.all(await this.poll(now));
  }

  private async poll(now = Date.now()): Promise<Promise<void>[]> {
    if (now - this.lastSweep > 30_000) {
      this.lastSweep = now;
      await this.sweep(now);
      await this.prune(now);
    }
    for (const c of this.crons) {
      for (; c.next <= now; c.next = nextRun(c.job.schedule, c.next)) {
        // Deterministic id: every server computes the same one, so each run is inserted once.
        await this.exec.mutate((_s, tx) =>
          tx.execute(`INSERT INTO ${T} ${COLS} VALUES (?, ?, ?, ?, ?, 'pending') ON CONFLICT ("_id") DO NOTHING`, [
            `_scheduled_functions:cron:${c.job.name}:${c.next}`,
            now,
            c.job.fn,
            JSON.stringify(c.job.args),
            c.next,
          ]),
        );
      }
    }
    const room = SchedulerLoop.MAX_RUNNING - this.inflight.size;
    if (room <= 0) return [];
    const due = await this.db.query<{ _id: string; name: string; args: string; scheduledTime: number }>(
      `SELECT "_id", "name", "args", "scheduledTime" FROM ${T} WHERE "state" = 'pending' AND "scheduledTime" <= ? ORDER BY "scheduledTime" LIMIT ?`,
      [now, room + this.inflight.size],
    );
    return due
      .filter((job) => !this.inflight.has(job._id))
      .slice(0, room)
      .map((job) => {
        this.inflight.add(job._id);
        return this.runJob(job).finally(() => this.inflight.delete(job._id));
      });
  }

  /** Deletes jobs that finished long ago, so the table doesn't grow for ever. */
  prune(now = Date.now()) {
    return this.exec.mutate((_s, tx) => tx.execute(`DELETE FROM ${T} WHERE "state" IN ('success', 'failed', 'canceled') AND "completedTime" < ?`, [now - this.retentionMs]));
  }

  /** Fails actions whose lease expired: the server running them died. */
  sweep(now = Date.now()) {
    return this.exec.mutate((_s, tx) =>
      tx.execute(`UPDATE ${T} SET "state" = 'failed', "error" = ?, "completedTime" = ? WHERE "state" = 'running' AND "completedTime" < ?`, [
        "Interrupted: the server running this action stopped",
        now,
        now - this.actionLeaseMs,
      ]),
    );
  }

  private finish(id: string, state: string, error: string | null, from: string) {
    return this.exec.mutate((_s, tx) =>
      tx.execute(`UPDATE ${T} SET "state" = ?, "error" = ?, "completedTime" = ? WHERE "_id" = ? AND "state" = ?`, [state, error, Date.now(), id, from]),
    );
  }

  private claim = (tx: DbTx, id: string, to: string) =>
    tx.query(`UPDATE ${T} SET "state" = ?, "completedTime" = ? WHERE "_id" = ? AND "state" = 'pending' RETURNING "_id"`, [to, Date.now(), id]);

  private async runJob({ _id, name, args, scheduledTime }: { _id: string; name: string; args: string; scheduledTime: number }) {
    const fn = this.functions.get(name);
    const parsed = JSON.parse(args);
    // A job is a trace of its own: the scheduler's run of it is the root, the function's work nests under it.
    const parent = this.onTrace ? { traceId: traceId(), parentId: spanId() } : undefined;
    const start = now();
    let ran = false;
    let failure: unknown;
    let telemetry: CallTelemetry | undefined;
    const inTrace = async <T>(work: () => Promise<T>) => {
      try {
        const out = await traced(parent, name, work);
        telemetry = out.telemetry;
        return out.value;
      } catch (e) {
        telemetry = telemetryOf(e);
        throw e;
      }
    };
    try {
      if (!fn) throw new Error(`Unknown function "${name}"`);
      if (fn.kind === "mutation") {
        await inTrace(() =>
          this.exec.logged(name, undefined, undefined, () =>
            this.exec.mutate(async (store, tx, after) => {
              if (!(await this.claim(tx, _id, "success")).length) return;
              ran = true;
              validateFields(fn.args, parsed, "args");
              await this.exec.timed(this.exec.invokeMutation(fn, parsed, store, tx, after, null), name);
            }),
          ),
        );
      } else {
        if (!(await this.exec.mutate((_s, tx) => this.claim(tx, _id, "running"))).length) return;
        ran = true;
        try {
          await inTrace(() => this.exec.call(name, "action", parsed, null, `scheduled:${_id}`));
          await this.finish(_id, "success", null, "running");
        } catch (e) {
          failure = e;
          await this.finish(_id, "failed", (e as Error).message, "running");
        }
      }
    } catch (e) {
      ran = true;
      failure = e;
      // The failed mutation rolled back its claim, so the job is still pending.
      await this.finish(_id, "failed", (e as Error).message, "pending");
    }
    if (ran && parent) this.emit(_id, name, Number(scheduledTime), start, parent, failure, telemetry);
  }

  private emit(id: string, name: string, scheduledTime: number, start: number, parent: { traceId: string; parentId: string }, failure: unknown, telemetry?: CallTelemetry) {
    const err = failure === undefined ? undefined : serializeError(failure);
    const cron = id.startsWith("_scheduled_functions:cron:") ? id.slice("_scheduled_functions:cron:".length).replace(/:\d+$/, "") : undefined;
    const duration = now() - start;
    const status = statusOf(err?.kind);
    const attrs = { "job.id": id, "job.queue": cron ? `cron ${cron}` : "scheduler", ...(cron && { "job.cron": cron }) };
    this.onTrace!({
      request: {
        traceId: parent.traceId,
        spanId: parent.parentId,
        time: start,
        duration,
        service: "",
        kind: cron ? "cron" : "job",
        operation: name,
        method: cron ? "CRON" : "SCHEDULED",
        status,
        error: err && { type: err.type ?? "Error", message: err.message, stack: err.stack, handled: handledKind(err.kind) },
        weight: 1,
        queueWait: Math.max(0, start - scheduledTime),
        attrs,
      },
      spans: [
        { traceId: parent.traceId, spanId: parent.parentId, name, type: "job", kind: 5, start, duration, status: err ? 2 : 1, error: err?.message, attrs: { ...attrs, "forge.kind": cron ? "cron" : "job" } },
        ...(telemetry?.spans ?? []),
      ],
    });
  }
}
