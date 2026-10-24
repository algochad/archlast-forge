# Scheduling and crons

## Scheduled functions

```ts
await ctx.scheduler.runAfter(60_000, internal.emails.send, { to });   // in a minute
await ctx.scheduler.runAt(Date.parse("2027-01-01"), api.reports.yearly);
await ctx.scheduler.cancel(jobId);
```

From a mutation, the job is scheduled only if the mutation commits.

- **Scheduled mutations run exactly once.** The job is claimed inside the mutation's own transaction.
- **Scheduled actions run at most once and are never retried automatically.** If the server running an action dies, the job is marked failed once its lease, the action timeout plus a minute, expires.

You can retry failed jobs from the dashboard.

## Crons

```ts
// forge/crons.ts
import { cronJobs } from "@archlast/forge-runtime";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge done todos", { hours: 1 }, internal.todos.purgeDone);
crons.cron("weekly digest", "0 9 * * MON", internal.digest.send); // UTC
export default crons;
```

Every server computes the same id for each run, so each run happens once, however many servers you have.
