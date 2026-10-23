import { getFunctionName, type CronJob, type CronSchedule, type RegisteredFunction } from "../functions";
import { validateFields, ValidationError } from "../values";
import type { Db, DbTx } from "./db/types";
export { migrateSystem as migrateScheduler } from "./system";
import type { Executor } from "./executor";

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
  ) {
    const now = Date.now();
    this.crons = crons.map((job) => ({ job, next: nextRun(job.schedule, now) }));
  }

  start() {
    const loop = async () => {
      try {
        await this.tick();
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

  async tick(now = Date.now()) {
    if (now - this.lastSweep > 30_000) {
      this.lastSweep = now;
      await this.sweep(now);
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
    const due = await this.db.query<{ _id: string; name: string; args: string }>(
      `SELECT "_id", "name", "args" FROM ${T} WHERE "state" = 'pending' AND "scheduledTime" <= ? ORDER BY "scheduledTime" LIMIT 50`,
      [now],
    );
    await Promise.all(due.map((job) => this.runJob(job)));
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

  private async runJob({ _id, name, args }: { _id: string; name: string; args: string }) {
    const fn = this.functions.get(name);
    const parsed = JSON.parse(args);
    try {
      if (!fn) throw new Error(`Unknown function "${name}"`);
      if (fn.kind === "mutation") {
        await this.exec.logged(name, undefined, undefined, () =>
          this.exec.mutate(async (store, tx, after) => {
            if (!(await this.claim(tx, _id, "success")).length) return;
            validateFields(fn.args, parsed, "args");
            await this.exec.invokeMutation(fn, parsed, store, tx, after, null);
          }),
        );
      } else {
        if (!(await this.exec.mutate((_s, tx) => this.claim(tx, _id, "running"))).length) return;
        try {
          await this.exec.call(name, "action", parsed, null, `scheduled:${_id}`);
          await this.finish(_id, "success", null, "running");
        } catch (e) {
          await this.finish(_id, "failed", (e as Error).message, "running");
        }
      }
    } catch (e) {
      // The failed mutation rolled back its claim, so the job is still pending.
      await this.finish(_id, "failed", (e as Error).message, "pending");
    }
  }
}
