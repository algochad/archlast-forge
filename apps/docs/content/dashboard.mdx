# Dashboard

The dashboard is a web console served by the engine itself. It shows your data, runs your functions, streams logs, charts the load and manages users, and everything on it is a call to the engine's admin API. There is nothing extra to install or deploy.

- **URL:** `/_dashboard` (for example `http://localhost:3000/_dashboard`). `archlast-forge dashboard` prints it, and `dev` prints it on startup.
- **API:** `/_admin/<op>`, used by the page itself (see [the admin API](#the-admin-api)).
- **Enabled:** on in dev; **off in production** until you set `DASHBOARD=on`. When it's off, `/_dashboard` and every `/_admin/*` path answer 404, even with the admin key. The backend stack (`archlast-forge up`) turns it on, behind the admin key; set `DASHBOARD=off` in `.env` to hide it.

## Signing in

There are two ways in, chosen on the sign-in screen.

| Method | What it gives you |
|---|---|
| **Admin account** | An email and password with a role: `owner`, `admin` or `viewer`. Create one with `archlast-forge admin add you@example.com --role admin` (`--password` to choose it; otherwise one is generated and printed). Passwords need at least 12 characters. `admin list` and `admin remove` manage the rest. The default role is `admin`. |
| **`ADMIN_KEY`** | The deployment's admin key, as an `owner`. In dev it is generated once and printed by `archlast-forge dev` (it's kept in `DATA_DIR/.dev-secrets.json`). In production, set it in the environment; if `ADMIN_KEY` isn't set, key sign-in is off. Actions are logged under the name `admin-key`. |

Dashboard accounts are their own thing. They are not the users of your app (those are Better Auth's `users`), and an app user can't sign in here. See [authentication](auth.html#dashboard-accounts-are-separate).

A successful sign-in sets an `afx_admin` cookie: `HttpOnly`, `SameSite=Strict`, valid for 12 hours, and `Secure` when `BETTER_AUTH_URL` is `https://`. The server keeps only a hash of the token. When the session ends or is revoked the page returns to the sign-in screen. Sign-in attempts are rate limited per IP, with their own counter next to the one for normal calls (`RATE_LIMIT_PER_MINUTE`).

## Roles

| Role | Can |
|---|---|
| **viewer** | Open every page and read everything: documents, logs, metrics, users, sessions, schema, the audit log. Cannot change anything. |
| **admin** | Everything a viewer can, and also: insert, patch, replace and delete documents; run functions (including internal ones) as any user; cancel and retry scheduled jobs; delete files; revoke sessions; ban and unban users; clear the cache; reload the function runtime. |
| **owner** | Everything, plus [run your own code](#running-your-own-code) (when `ALLOW_CUSTOM_FUNCTIONS` allows it). |

Buttons a role can't use are hidden, and the server enforces the same rules: a viewer's write answers 403 `Requires the admin role`.

**A viewer can read every table** in the Data page except the credentials in them: `accounts.password` and OAuth tokens, `sessions.token` and `verifications.value` show as `[hidden]` to every role, the owner included. Everything else in your data is visible, so give the role only to people you would trust with it. On `0.1.0` those fields were readable; upgrade if viewers are not fully trusted.

## The pages

The sidebar groups them as Forge, Data, Runtime and Admin. The top bar has a search box, the theme switch and who you are.

### Overview

How the forge is running right now: whether the function runtime loaded (a failed load shows its error), uptime, and whether storage is on. Stat tiles for the last hour: function runs, error rate, p95 latency, query cache hit rate and live queries (with open connections), then your tables, functions (public and internal), crons and runtime processes. Below them, recent activity from this server's log and the latest dashboard changes. It refreshes by itself every few seconds.

### Data

Browse and edit documents.

- **The table list** groups *Your tables* and *Built in* (Better Auth's tables, marked "Better Auth", and `_storage`), with a live document count for each. System tables like `_logs` and `_admins` aren't listed.
- **A table view** shows documents newest first, 50 to a page, refreshed every few seconds. Columns are `_id`, your fields in schema order, any fields not in the schema, and `_creationTime`. Pick an **index** and fill in values left to right to filter by equality on a prefix of its fields (values parse as JSON when they can: `5`, `true`, otherwise text); **Newest/Oldest** flips the order. **Previous/Next** page through results.
- **A document** opens in a drawer: its id and creation time, its [relationships](#relationships), and its fields as JSON. Admins can **Patch** (merge the fields you wrote), **Replace** (keep only what's there) or **Delete**; **Add document** inserts one. Every write is validated against the schema, like a write from a function (Better Auth's tables are the exception: they're loosely typed so plugins can add fields). Viewers see the JSON read-only.
- **Schema** (a toggle in the table header) lists the fields with their types and whether they're optional, which indexes use each field, the indexes (including search indexes), and the table's relations.
- Deleting a `_storage` document also deletes the object in storage.
- **Query** (owners) opens the code runner with a starting query for this table.

Writes made here publish to live queries and invalidate the [cache](caching.html) like any other write. They bypass your functions' checks, so be careful in tables Better Auth manages.

### Files

Appears when storage is on (`S3_ENDPOINT` and `S3_BUCKET`; otherwise it explains how to set it up). Lists `_storage` records newest first with the id, content type, **size** (read from the object itself) and upload time. **Open** gives a presigned link that lasts ten minutes; **Delete** (admins) removes the record and the object. Documents that referenced the file keep a dangling id. See [storage](storage.html).

### Users

Your app's users (Better Auth's `users` table), 50 to a page, with a status badge: *banned*, *verified* or *unverified*. **Find by email** is an exact match (case-insensitive: the address is lowercased). Click a user for their id, join date and **sessions** (device, IP address, when it started and when it expires). Admins can **Revoke** a session, which signs that device out, and **Ban user**, which sets `banned: true`, signs the user out everywhere and makes new sign-ins fail (see [banned users](auth.html#banned-users)). **Unban** reverses the flag.

### Functions

Every function in the manifest with a kind badge (query, mutation, action) and an `internal` mark, with a filter box. Select one to see its argument and return types and run it (admins):

- **Arguments** are a generated form when every argument is a string, number, boolean, id or null; otherwise a JSON editor. You can switch between them.
- **Run as user** takes an email or a `users:…` id so that `ctx.auth.getUserIdentity()` sees that user (the session id is `dashboard`). Empty runs anonymously.
- It runs the real function with the real database, queries included (not through the query cache). Internal functions can be run here too, which clients can't do.
- **Recent runs** keep the last ten per function, with arguments, result or error, and timing. They are stored in your browser (`localStorage`), not on the server.

### Scheduled

**Crons** from `forge/crons.ts` with their schedule (UTC) and next run. **Jobs** from the scheduler, filterable by state (`pending`, `running`, `success`, `failed`, `canceled`), with the function, arguments and error. Admins can **Cancel** a pending job and **Retry** a failed or canceled one. See [scheduling](scheduling.html).

### Logs

Two sources, switched at the top:

- **Live · this server** streams function calls and `console` output as they happen (server-sent events), up to the last 500 entries in view, with **Pause** and **Clear**.
- **History · all servers** reads the stored log, filtered by function, level (`call`, `log`, `info`, `warn`, `error`), time range (15 minutes to 7 days) or request id. Up to 500 rows. Logs are kept for `LOG_RETENTION_DAYS` (7 by default).

A `call` row says whether the function succeeded and how long it took; [HTTP endpoints](http.html#limits-rate-limiting-and-metrics) appear as `http GET /path`. Click a request id to see everything that request did. The request id is also what a caller sees in an error (`Server error (request …)`), and it's the `x-request-id` response header.

### Metrics

Over 1 hour, 24 hours or 7 days (30 buckets): function runs and errors, p50 and p95 latency, and subscriptions and connections summed over all servers. These come from the stored call log and from samples every 30 seconds, so a 7-day chart needs `LOG_RETENTION_DAYS` of at least 7. A table lists recent calls on this server by function (count, errors, average time). For scraping, use `/metrics` instead (bearer `METRICS_TOKEN`, or the admin key).

### Cache

Shown when the query cache is on (`CACHE_TTL_MS`; otherwise the page says how to turn it on). Hit rate, calls served from the cache or by sharing a run already in flight, function runs, entries and memory used, the time saved, entries evicted by writes and for space, and charts over time. A per-function table marks queries that are cached **per user** (they read `ctx.auth`). Admins can **Clear cache**, which empties this server's cache (or the shared Redis cache) and records it in the audit log. See [caching](caching.html).

### Audit

The audit log: when, who, what, which target and the arguments, newest first (300 entries). It records dashboard writes and the CLI's `import`, `env set`, `env rm`, `admin add`, `admin remove` and `migrate --run` (actor `cli`; never the secret values). Reads and sign-ins aren't in it (sign-ins are in the server log). See [audit log](#audit-log).

### Settings

The **schema** (every table with its fields and indexes), the names of **environment variables** set with `archlast-forge env set` (never the values) with a **Reload runtime** button for admins, and the **live subscriptions** on this server (query, arguments, the topics that will re-run it, and how long it has been open).

## Relationships

Fields declared with `v.id("…")` are links between tables, and the Data page follows them:

- **In the table,** a reference shows the document it points at by its name (or title, or email) instead of an id. Click it to open that document in its own table. A reference whose document was deleted shows as *missing*.
- **In a document's drawer,** **Relationships** lists what it points at, and what points at it (`todos.listId`, 9). **Browse** opens that table with the lookup already applied, using the index on the field.
- **A trail** at the top (*todos › lists · Forge launch › todos · listId = …*) shows how you got here. **Back**, or any step in it, returns you, with that document open again.
- **Where there is no index** on the referencing field, the count is found by scanning, and Browse is replaced by **Query**, which opens the function runner with a query for it (owners only). Adding an index to the field turns it into a normal lookup.
- **Relationships** in the Tools list draws every table with its references as an entity-relationship diagram, or as a list. Click a table to open it, hover to follow its connections. Your own tables are shown with the built-in ones they connect to.
- A table's **Schema** view has a **Relations** section with both directions.
- The function runner has join examples built from your schema.

## Running your own code

On the Data page, **Run function** opens an editor where you write a query or a mutation and run it against the live data, like a custom test query in Convex. Each table's **Query** button opens it with a starting query for that table, and the **Examples** menu has more: counting, filtering with an index, updating documents, logging, joins.

```ts
export default query({
  args: { listId: v.id("lists") },
  handler: async (ctx, { listId }) => {
    console.log("looking up", listId);
    return await ctx.db.query("todos").withIndex("by_list", (q) => q.eq("listId", listId)).collect();
  },
});
```

- **What's in scope:** `query`, `mutation`, `v` and `ForgeError`, so there is nothing to import (import lines are dropped). TypeScript works. `ctx` is what your own functions get; a bare `export default async (ctx) => …` counts as a query. It can't be an action or an `internal*` function.
- **Arguments** are JSON, checked against the `args` you declare. **Run as user** takes an email or `users:…` id, so `ctx.auth` sees that user.
- **Results** appear as a table when the function returns documents (or as JSON), with the time it took, what it wrote to the console, and a copy button. A syntax error shows its line.
- **Queries are read-only.** A mutation commits when it returns and rolls back if it throws; its writes reach live queries and invalidate the [cache](caching.html) like any other.
- **Cmd or Ctrl and Enter** runs it. The editor keeps your last draft in this browser.

This is arbitrary code running inside the function runtime, with its environment (database URL, secrets) and network access, so it is held to a higher bar than the rest of the dashboard:

- only the **owner** role can use it (an admin cannot; the page says so);
- it is **off in production** until you set `ALLOW_CUSTOM_FUNCTIONS=on` (on in dev). When it's off, owners see a notice and the API answers 403;
- every run, with its code and arguments (the first 2,000 characters of them), is in the audit log.

## Audit log

Every change made from the dashboard is recorded in the `_audit` table with the time, the actor (the account's email, or `admin-key`), the action, a target, and the arguments as JSON (cut at 2,000 characters):

| Action | Where it comes from |
|---|---|
| `insertDoc`, `patchDoc`, `replaceDoc`, `deleteDoc` | Data |
| `run` | Functions, Data → Run function |
| `runCustom` | Run function (owners) |
| `cancelJob`, `retryJob` | Scheduled |
| `deleteFile` | Files |
| `revokeSession`, `banUser` | Users |
| `clearCache` | Cache |

The log has no edit or delete in the UI. Because the arguments of data edits are recorded, **the values you type are stored there**, and every role can read the audit page: don't paste a secret into a document edit.

## Keyboard, search and theme

- **Ctrl or Cmd + K** opens a palette that jumps to a page, a table (in Data) or a function (in Functions).
- **Alt + 1 … 9 and Alt + 0** jump to the first ten pages in sidebar order: Overview, Data, Files, Users, Functions, Scheduled, Logs, Metrics, Cache and Audit. Settings has no shortcut.
- The address bar follows the page (`#Data`), so a page can be bookmarked.
- The theme follows your system, or switch it to light or dark from the top bar. It is remembered in your browser.

## The admin API

The dashboard is a plain client of `/_admin/<op>`, and you can script it. Reads are `GET /_admin/<op>?input=<json>`; changes are `POST /_admin/<op>` with a JSON body. Authenticate with the session cookie, or send `x-admin-key: <ADMIN_KEY>` to act as the owner.

```bash
curl "localhost:3000/_admin/counts?input=%7B%22tables%22:%5B%22todos%22%5D%7D" -H "x-admin-key: $ADMIN_KEY"

curl -X POST localhost:3000/_admin/banUser -H "x-admin-key: $ADMIN_KEY" -H 'x-forge-admin: 1' \
  -H 'content-type: application/json' -d '{"userId":"users:…","banned":true}'
```

- **POST requests need `x-forge-admin: 1`**, a custom header that a cross-site page can't send without a preflight the API never grants. Without it: 403. The sign-in (`POST /_admin/login` with `{ email, password }` or `{ key }`) needs it too.
- **Errors** are `{ "error": { "message", "code", "requestId" } }` with the matching status: 401 not signed in, 403 role too low, 404 unknown operation, 405 wrong method (`docs takes GET`).
- The admin API reports real error messages, even in production.

| Role | Operations |
|---|---|
| none needed | `login`, `logout`, `me` (who you are, or `null`) |
| viewer | `manifest`, `docs`, `docsByIds`, `references`, `counts`, `scheduled`, `crons`, `files`, `users`, `sessions`, `audit`, `env` (names only), `logs`, `recentLogs`, `metrics`, `subscriptions`, `server`, `cache` |
| admin | `insertDoc`, `patchDoc`, `replaceDoc`, `deleteDoc`, `run`, `cancelJob`, `retryJob`, `deleteFile`, `revokeSession`, `banUser`, `clearCache`, `reload` |
| owner | `runCustom` |

`/_admin/logs/stream` is the server-sent event stream behind Live logs. The shapes of each operation's input and output follow the dashboard's usage and may change between versions; treat this as a convenience, not a stable public API.

## Security notes

- **Turn it off, or fence it.** The dashboard can read and edit every document. Leave `DASHBOARD` off in production unless you need it, and when it is on, put it behind a VPN or an IP allow-list at your proxy. Serve it over HTTPS so the cookie is `Secure`.
- **Prefer accounts over the key.** `ADMIN_KEY` is a shared owner password: it also unlocks `/metrics` and the CLI's data commands (`import`, `env`, `admin`) over `POST /_cli`. Use per-person accounts for the dashboard, give most people `viewer`, and keep the key for automation. Rotate it by changing the variable and restarting.
- **Role changes take a few seconds.** The server caches a session's identity for 10 seconds, so a removed account or demoted role can keep working for that long.
- **Viewers see your data.** Credentials are hidden (`[hidden]`), but every document in every table is readable. Saving a document the Data page showed you never writes the placeholder back over a real credential: it is left as it was.
- **Custom code is remote code execution** by design. Keep `ALLOW_CUSTOM_FUNCTIONS` off wherever owner sessions are widely shared; see [limits](limits.html).
- **Audit entries hold the values written.** Don't edit secrets through the dashboard.
- **Writes are same-origin only.** The cookie is `SameSite=Strict` and every write needs the custom header, so another site can't drive an admin's session.
