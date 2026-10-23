# Dashboard

`/_dashboard` is on in dev and off in production unless `DASHBOARD=on`.

Sign in with an admin account (`archlast-forge admin add you@example.com --role admin`) or with `ADMIN_KEY`. Roles:

- **viewer:** read everything.
- **admin:** also edit data, run functions, cancel and retry jobs, delete files, revoke sessions and ban users.
- **owner:** everything.

Every change is recorded in the audit log.

| Page | What's there |
|---|---|
| Data | Tables with counts. Filter by index, sort, page through documents; edit (patch or replace), insert and delete with validation. |
| Functions | An argument form generated from each function's validators. Run as any user, including internal functions; recent runs are kept per function. |
| Logs | Live stream from this server, or history across all servers filtered by function, level, time and request id. |
| Metrics | Calls, errors, p50/p95 latency, subscriptions and connections over 1h, 24h or 7d. |
| Cache | Hit rate, entries and memory, hits and misses over time, and per-function counters with the time saved. Admins can clear the cache. |
| Scheduled | Crons with their next run; jobs with cancel and retry. |
| Files | Uploaded files with type and size; open or delete. |
| Users | Find by email; sessions with revoke; ban and unban. |
| Audit | Who changed what, with which arguments. |
| Settings | Schema, environment variable names, live subscriptions and their topics, runtime reload. |

`Alt+1` through `Alt+9` and `Alt+0` switch between the first ten pages. The theme follows your system, or pick light or dark.
