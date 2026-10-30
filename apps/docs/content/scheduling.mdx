# Scheduling and crons

Two tools run work later: **scheduled functions**, which you queue from a mutation or an action (a reminder in an hour, an email after sign-up), and **crons**, which run on a repeating schedule that you declare in `forge/crons.ts`. Both are stored in the database and are run by the engine's scheduler. Nothing else needs to run.

## Scheduled functions

```ts
// from a mutation or an action
const jobId = await ctx.scheduler.runAfter(60_000, internal.emails.send, { to });   // in a minute
await ctx.scheduler.runAt(Date.parse("2027-01-01T00:00:00Z"), api.reports.yearly);  // at a time
await ctx.scheduler.cancel(jobId);
```

| Call | Does |
|---|---|
| `runAfter(ms, ref, args?)` | runs `ref` once, `ms` milliseconds from now |
| `runAt(timestamp, ref, args?)` | runs `ref` at a time in milliseconds since the epoch. A time in the past runs at the next poll |
| `cancel(id)` | cancels a job that hasn't started. It does nothing for a job that is running, finished or already canceled |

`ref` can be a public or an internal mutation or action. Prefer `internal.*` for work that clients should not be able to trigger directly. The call returns the job id (a string like `_scheduled_functions:3d9c…`), which is what `cancel` takes.

- **Arguments are checked when you schedule.** A wrong argument throws a validation error from the scheduling call (`args.todoId must be an Id<"todos">, got 5`), so a typo fails in the request that made it and not later in the background.
- **Queries can't be scheduled.** Scheduling one throws `Only mutations and actions can be scheduled; "x" is a query`, and so does an unknown function.
- **From a mutation, the job exists only if the mutation commits.** A mutation that schedules a job and then throws schedules nothing.
- **From an action, scheduling is its own write.** The job is saved at once, whether or not the action goes on to succeed.
- **A scheduled function runs anonymously.** `ctx.auth.getUserIdentity()` returns `null`. Pass the ids it needs as arguments (`{ userId }`) and read the user in the function.

### A reminder

```ts
// forge/todos.ts
export const remind = mutation({
  args: { todoId: v.id("todos"), inMs: v.number() },
  handler: (ctx, { todoId, inMs }) => ctx.scheduler.runAfter(inMs, internal.reminders.send, { todoId }),
});

// forge/reminders.ts
export const send = internalMutation({
  args: { todoId: v.id("todos") },
  handler: async (ctx, { todoId }) => {
    const todo = await ctx.db.get(todoId);
    if (!todo || todo.done) return; // the todo was finished or deleted while we waited
    await ctx.db.insert("reminders", { todoId, sentAt: Date.now() });
  },
});
```

Re-check the state when the job runs. The world can have changed in the meantime, and the job holds only the arguments it was scheduled with. To cancel on change, save the job id on the document and call `cancel` from the mutation that completes the todo.

### Mutations and actions

| | Scheduled mutation | Scheduled action |
|---|---|---|
| Guarantee | **exactly once** | **at most once** |
| How | the job is claimed inside the mutation's own transaction, so the claim and the writes commit together | the job is marked `running` first, then the action runs; it is never retried |
| If the function throws | the transaction rolls back (the writes vanish), the job is marked `failed` with the message | the job is marked `failed` with the message |
| If the process dies mid-run | the transaction never committed, so the job is still `pending` and runs again | the job stays `running` until its lease expires, then it is marked `failed` |
| Time limit | `FUNCTION_TIMEOUT_MS` (10 seconds), like any mutation: past it the write is rolled back and the job is `failed` | `ACTION_TIMEOUT_MS` (10 minutes) |

Because actions are at-most-once, an action that sends an email, charges a card or calls an API may have done its side effect and then failed to say so. If that matters, make it idempotent: record intent in a mutation first, send with an idempotency key from that record, and let a retry from the dashboard (or a later cron) find unfinished records. Do the database work of a job in a scheduled *mutation* where you can: it gets the exactly-once guarantee for free.

A scheduled mutation is a normal write: its topics are published after it commits, so live queries and the [cache](caching.html) see it like any other write.

### Job states

Jobs live in the system table `_scheduled_functions`, which the dashboard's **Scheduled** page shows.

| State | Meaning |
|---|---|
| `pending` | waiting for its time, or for a free poll |
| `running` | an action has started (mutations skip this state) |
| `success` | finished |
| `failed` | threw, or was interrupted (the `error` column says why), or the function no longer exists (`Unknown function "…"`) |
| `canceled` | canceled before it started |

Each row also has `name`, `args` (as JSON text), `scheduledTime`, `completedTime` (when the job last changed state) and `error`.

**Retry.** On the **Scheduled** page, admins can retry a failed or canceled job. Retrying doesn't change the old row: it creates a new job with the same function and arguments, due now, and the old row stays `failed`. Only failed and canceled jobs can be retried.

## How the scheduler runs

- **Every server polls.** Each server's first runtime process checks the table every 500 ms for pending jobs that are due, oldest first, and runs up to 50 at a time. Several servers can poll the same table: claiming a job is one atomic update, so two servers can't both run it.
- **Restarts don't lose jobs.** Jobs are rows in the database. A job that became due while the server was down runs when it is back.
- **Leases and the sweep.** Every 30 seconds each server looks for actions that have been `running` for longer than `ACTION_TIMEOUT_MS` plus one minute. The server that was running them is presumed dead, and the job is marked `failed` with `Interrupted: the server running this action stopped`. Nothing runs them again.
- **Clocks.** `runAfter` is computed with the clock of the server that scheduled it, and a job is due when the polling server's clock reaches `scheduledTime`. With several servers, a clock that is wrong by a few seconds moves jobs by a few seconds. Keep servers on NTP.
- **Latency.** A job runs within about half a second of its time. Don't use the scheduler for sub-second timing.
- **A long action does not hold the poll.** Jobs start as they come due and the scheduler keeps looking, so a scheduled action that runs for a minute does not delay other jobs or cron slots on that server (while it runs it counts toward the 50 at a time). On `0.1.0` the scheduler waited for every job of a poll to finish before looking again, so one long action delayed everything behind it; upgrade if you schedule long actions.
- **Finished jobs are deleted after a week.** Rows in `success`, `failed` or `canceled` state are removed once they are older than `LOG_RETENTION_DAYS` (7 by default), checked every 30 seconds; `pending` and `running` rows are never removed. The dashboard's Scheduled page therefore shows a week of history. On `0.1.0` finished rows were kept for ever, so a cron that ran every second added 86,400 rows a day.

## Crons

```ts
// forge/crons.ts
import { cronJobs } from "@archlast/forge-runtime";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge done todos", { hours: 1 }, internal.todos.purgeDone);
crons.cron("weekday digest", "0 9 * * 1-5", internal.digest.send); // 09:00 UTC, Monday to Friday
crons.interval("sync prices", { minutes: 15 }, internal.prices.sync, { currency: "usd" });
export default crons;
```

`crons.ts` is a special module: it must default-export what `cronJobs()` returns, and codegen skips it when it lists your functions.

| Call | |
|---|---|
| `crons.interval(name, { seconds?, minutes?, hours? }, ref, args?)` | runs every so often. The interval must be at least one second |
| `crons.cron(name, expression, ref, args?)` | runs on a 5-field cron expression: minute, hour, day of month, month, day of week. Names such as `MON` and shortcuts like `@daily` work. A seconds field is not supported |

- **Everything is UTC.** `"0 9 * * 1-5"` is 09:00 UTC. There is no time zone option; subtract the offset, and expect it to move by an hour against local time when daylight saving changes.
- **Intervals are aligned to the clock, not to when the server started.** An interval runs at every multiple of its length since 1 January 1970 UTC. `{ hours: 1 }` runs at the top of every hour, `{ seconds: 5 }` at `:00`, `:05`, `:10`… An interval that doesn't divide an hour or a day evenly (`{ minutes: 7 }`) still follows the epoch grid, so its runs don't fall at the same minutes each hour. Use a cron expression when you want a particular time of day.
- **Names are unique.** A repeated name throws when `forge/` loads. The name is part of each run's job id, so renaming a cron is a new cron.
- **The target is a mutation or an action**, public or internal, with the arguments you pass as the last argument. They are checked when the job runs. Crons use `internal.*` functions in practice, so a client can't call the same code.
- **An invalid expression stops startup.** `crons.cron("bad", "bad", …)` makes the function runtime fail to load with `Invalid cron expression: expected 5 space-separated fields`. In dev the terminal shows `failed to restart` and the runtime retries until you fix the file; in production the server refuses to start.
- **One run per schedule across servers.** Each run is a job with a deterministic id (`cron:<name>:<time>`) inserted with `ON CONFLICT DO NOTHING`. Every server tries; exactly one row is created; any one server runs it. The runs are visible on the **Scheduled** page, which also lists each cron with its next run.
- **No catch-up for downtime.** When a server starts, each cron's next run is computed from the current time. Runs missed while every server was down are skipped. 
- **Runs can overlap across servers.** With one server, a cron's runs go one after another. With several, a second server can start the next slot while the first is still on the previous one. Make cron work safe to repeat, or take a lock in a mutation.

### A cleanup job

```ts
// forge/todos.ts
export const purgeDone = internalMutation({
  args: {},
  handler: async (ctx) => {
    // A batch per run keeps the transaction short; the next run takes the next batch.
    for (const todo of await ctx.db.query("todos").filter((t) => t.done).take(100)) await ctx.db.delete(todo._id);
  },
});
```

Bound each run. A cleanup that deletes a million rows in one transaction holds the write lock the whole time, and on SQLite (one writer) every other write waits for it. For more than a batch, have the job schedule its next batch with `ctx.scheduler.runAfter(0, …)` until the query comes back empty (annotate the handler's return type, because it refers to its own module).

### A digest email

A cron needs an action when the work calls another service. The action reads through queries, does the I/O, and records the result with a mutation:

```ts
// forge/digest.ts
export const send = internalAction({
  args: {},
  handler: async (ctx): Promise<void> => {
    const counts = await ctx.runQuery(internal.digest.openCounts, {});
    const body = counts.map((c) => `${c.name}: ${c.open} open`).join("\n");
    const res = await fetch("https://mail.example.com/send", { method: "POST", body: JSON.stringify({ to: "team@example.com", body }) });
    if (!res.ok) throw new Error(`Mail API answered ${res.status}`); // the job becomes "failed"; retry it from the dashboard
    await ctx.runMutation(internal.digest.markSent, { day: new Date().toISOString().slice(0, 10) });
  },
});
```

The action has an explicit return type (`Promise<void>`) because it calls functions from its own module; without it TypeScript can't infer the types in a cycle. Failed runs are not retried automatically: the next scheduled slot runs fresh, and you can retry the failed one by hand.

## Testing scheduled work

[`createTestBackend`](testing.html) runs scheduled functions in memory: `await t.finishScheduledFunctions()` runs every pending job as if time had passed. It doesn't run crons; test a cron's function by calling it directly, and check the schedule through the exported `crons.jobs`.

## Edge cases

- **Scheduling far ahead is fine.** A job is a row; there's no limit on how long it waits other than your own deploys. If the function is renamed or removed first, the job fails with `Unknown function`.
- **Arguments are frozen.** A job runs with the arguments saved when it was scheduled, even if you deploy new code. A changed `args` validator makes old jobs fail validation when they run.
- **Cancel is best effort.** A job that a server has already claimed can't be canceled. Check the state in the function itself if a late cancellation would be harmful.
- **Many jobs at once.** Up to 50 jobs run at the same time per server; the rest wait for a free slot, oldest first. A burst of thousands drains at no more than about 100 jobs a second per server, and slower when the functions are.
