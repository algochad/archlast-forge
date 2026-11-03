# Dashboard and observability

Read this when you must inspect or debug a running app (slow or failing functions), manage dashboard accounts, add custom spans or metrics, send another service's telemetry to the dashboard, or configure alerts. Written from the docs pages `dashboard.mdx` and `observability.mdx`; `trace` and `metrics` signatures are checked against `packages/runtime/src/telemetry.ts`. Settings and variables: [operations.md](operations.md). CLI: [cli.md](cli.md).

## The dashboard

- URL `/_dashboard` (`archlast-forge dashboard` prints it; `dev` prints it with the admin key). Its API is `/_admin/<op>`.
- **On in dev, off in production** until `DASHBOARD=on` (the backend/full-stack stack from `init` sets `DASHBOARD=${DASHBOARD:-on}` behind the admin key). Off means `/_dashboard` and `/_admin/*` answer 404, even with the key. Production advice: `DASHBOARD=off` unless used; if on, HTTPS and a VPN or IP allow-list, per-person accounts, `viewer` for most.
- **Sign in:** an admin **account** (`archlast-forge admin add you@example.com --role admin [--password …]`; password ≥ 12 characters; `admin list`, `admin remove`) or the **`ADMIN_KEY`** (acts as `owner`, logged as `admin-key`; unset in production = key sign-in off). Dashboard accounts are not app users.
- **Roles:** `viewer` reads everything (credentials in `accounts`, `sessions.token`, `verifications.value` show `[hidden]`); `admin` also writes documents, runs functions (including internal, as any user), cancels/retries jobs, deletes files, revokes sessions, bans users, clears cache, reloads the runtime, manages issues/SLOs/alerts/ingest keys, makes backups; `owner` also runs custom code (`ALLOW_CUSTOM_FUNCTIONS=on`; on in dev, off in production), manages backups/restores/schedule, edits engine settings, restarts, sets function env vars.
- **Pages:** Observe/Performance/Infrastructure (Overview, Requests, Errors, Logs, Users, Jobs, Spans, Hotspots, Services, Map, Runtime, Releases, SLOs, Metrics, Microservices, Nodes) and Backend/Admin (Data, Files, Functions, Cache, Alerts, Ingest keys, Backups, Audit, Settings). **Data** browses and edits documents (writes bypass your functions' checks, are schema-validated, publish to live queries; deleting a `_storage` doc deletes the object); **Functions** runs any function with "run as user"; **Settings** lists every engine variable with its source (environment wins over saved).
- **Scripting:** `GET /_admin/<op>?input=<json>`, `POST /_admin/<op>` with JSON. Auth: session cookie `afx_admin`, or `x-admin-key: $ADMIN_KEY` (owner). POSTs need the header `x-forge-admin: 1`. Errors are `{ error: { message, code, requestId } }` (401 not signed in, 403 role too low, 404 unknown op). The admin API shows real messages even in production.
- **Audit:** every dashboard write (document edits, runs, job actions, bans, settings, backups, key changes) is stored in `_audit` with its arguments (cut at 2,000 characters). Values typed into document edits are stored: never paste secrets into the Data page. Settings and env values are recorded without values.
- A removed or demoted account can keep working for about 10 seconds (session identity cache).

## What the engine records (no setup)

Every request is counted (totals, rates, percentiles). Detail is sampled: up to `TELEMETRY_DETAIL_PER_SECOND` (200) requests a second get every span; `TELEMETRY_TRACES_PER_SECOND` (25) ordinary traces a second are kept, plus as many for errors and slow requests (over 4× their Apdex threshold); a request with a sampled `traceparent` is always recorded. On a quiet app everything is recorded.

| Request kind                  | Source                                                                                         |
| ----------------------------- | ---------------------------------------------------------------------------------------------- |
| `query`, `mutation`, `action` | `/rpc` calls (a cache hit is marked); `live` = a live query re-running after a write           |
| `http`                        | `forge/http.ts` routes and Nest controllers, named by route pattern (`GET /users/:id`)         |
| `auth`, `page`                | `/api/auth`; full-stack pages (named by route)                                                 |
| `job`, `cron`                 | scheduled functions and cron runs, with queue wait                                             |
| `rpc`                         | Forge RPC calls and Nest microservice messages (a Forge RPC call continues the caller's trace) |
| `ws`                          | gateway messages (`Gateway:event`)                                                             |

Spans inside a request: each function (nested calls included), each database statement (SQL, rows returned), each outbound `fetch` (a W3C `traceparent` header is added), each method of `@Injectable`/`@Controller`/`@Resolver`/`@WebSocketGateway` classes imported from `@archlast/forge-runtime/nest` (`Class.method`), and your own spans. Errors: **handled** = `ForgeError` and validation failures; **unhandled** = crashes, timeouts, 5xx. A 4xx from an HTTP endpoint is a client error, not an error. Errors are grouped into **issues** by class and stack shape (resolve, ignore; reopen on recurrence), with source lines of your code. Releases are named by `FORGE_RELEASE` or a platform commit variable (`GIT_COMMIT`, `GITHUB_SHA`, `COOLIFY_GIT_COMMIT_SHA`, …), else a hash of `forge/`; the Releases page compares 30 minutes before and after each (verdict: Regression, Improvement, Stable, Measuring, Too little traffic).

Storage: SQLite `DATA_DIR/telemetry.db` (own file, not in `archlast-forge backup`) or `_otel_*` tables on Postgres. Retention: requests, traces, logs `LOG_RETENTION_DAYS` (7); statistics, metrics, issues 30 days. `TELEMETRY=off` records nothing and the observability pages answer 404.

## Your own spans and metrics

```ts
import { action, metrics, trace, v } from "@archlast/forge-runtime";

const placed = metrics.counter("orders.placed"); // sums per minute
const basket = metrics.histogram("orders.basket_size", { unit: "items" }); // count, sum, min, max
const depth = metrics.gauge("queue.depth"); // last reading per minute

export const checkout = action({
  args: { cartId: v.id("carts") },
  handler: async (ctx, { cartId }) => {
    const quote = await trace.span("pricing.quote", async () => {
      // what it calls nests under it
      trace.annotate({ cartId }); // attributes on the span; { request: true } = on the request
      return price(cartId);
    });
    placed.add(1, { plan: quote.plan });
    basket.record(quote.items.length);
    depth.set(await pending(ctx));
  },
});
```

- Span name's first word (before a `.`) is its "code unit" on Hotspots, so name spans `domain.operation`.
- Attributes split a metric into series (max 200 per metric and minute). Metric names start with a letter and use letters, digits, `.`, `_`, `-`, `/`. Keep attributes low-cardinality (plan, region), never ids.
- Outside the engine (`createTestBackend`, a browser) spans just run and metrics do nothing, so they are safe in code under test.
- Spans and metrics are useful in actions, controllers and services, not as a substitute for the automatic ones.

## Debugging playbook (use the dashboard, or the admin API)

1. **A user reports an error:** the caller sees "Server error (request <id>)". Search the id in the palette (Ctrl/Cmd+K) or Logs: it opens the trace, with the logs it wrote and the error's stack and source lines.
2. **Something is slow:** Requests → sort by impact/p95 → the operation page (latency shape, weekly rhythm) → open a slow trace → follow the **critical path**. A **repeated span** callout is an N+1: batch it or add an index (the Data page's Query/explain, and dev warnings from `devWarn`, show scans).
3. **Where does the time go in code:** Hotspots (own time by module/class) and Services (your Nest classes, method by method).
4. **Regression after a deploy:** Releases page.
5. **Live re-runs expensive:** Requests filtered to `live`; look for queries reading broad tables (add indexes, narrow queries).
6. **Process health:** Runtime (CPU, memory, heap, event-loop delay, connections, live queries, cache hit rate); Nodes for several servers.
7. **Jobs/crons:** Jobs and Queue & crons (retry failed ones).
8. Reproduce with Functions → run as the user, or Data → Run function (owner; `ALLOW_CUSTOM_FUNCTIONS`).

## SLOs and alerts

- **SLO:** latency (X% under T ms) or availability (X% without 5xx), per operation or overall, over 7/14/28/30/90 days; shows error budget and burn rate (1× spends the budget exactly by window end; at risk if < 25% left or burning ≥ 2×).
- **Alert rule:** one number over the last 1/5/10/15/30/60 minutes (server error rate, failure rate, p95/avg latency, request count, an SLO's burn rate, or a service's live nodes), checked every minute, with an optional webhook: it POSTs `{ text, state: "firing"|"resolved", value, time, rule }` (`text` works as is for Slack/Discord incoming webhooks). Use "Send a test" on the form.
- Changes need `admin` and are audited.

## Other services and exporting

- **Ingest:** any OpenTelemetry SDK can report to `POST /otlp/v1/traces|logs|metrics` (protobuf or JSON, gzip/deflate, ≤ 32 MiB). Create a key on **Ingest keys** (shown once; may be tied to a service name) and send `Authorization: Bearer <key>` (the admin key works; in dev no key is needed): `OTEL_EXPORTER_OTLP_ENDPOINT=https://app/otlp`, `OTEL_EXPORTER_OTLP_HEADERS=Authorization=Bearer%20afk_…`, `OTEL_SERVICE_NAME=billing-api`. SERVER spans become requests, CONSUMER spans jobs; `http.route` names them; `exception` events are errors; `enduser.id` is the user.
- **Export** the engine's own traces to your collector: `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`), `OTEL_EXPORTER_OTLP_HEADERS`, `OTEL_SERVICE_NAME` (default `archlast-forge`). That variable is for a collector, not this app: pointing it at the engine's own `/otlp` makes the engine ignore its own service and log once.
- **Prometheus:** `/metrics` with `Authorization: Bearer $METRICS_TOKEN` (the admin key unless set); `/health` and `/ready` for probes.

## One dashboard for a monorepo

| Where        | Variable            | Value                                                                                            |
| ------------ | ------------------- | ------------------------------------------------------------------------------------------------ |
| main app     | `MICROSERVICES`     | `orders=http://orders:3000,billing=http://billing:3000` (addresses the main app reaches them at) |
| each service | `DASHBOARD_URL`     | main app's address as the service reaches it                                                     |
| each service | `OTEL_SERVICE_NAME` | its name as `MICROSERVICES` lists it (required with `DASHBOARD_URL`)                             |
| both         | `DASHBOARD_TOKEN`   | shared secret, ≥ 16 characters                                                                   |

The CLI writes these for dev (`init --monorepo`, `add service`, `remove`, `workspace sync`); in production set real addresses. A service keeps no telemetry store, posts to the main app's `/_telemetry` once a second (buffers about a minute while the main app is away), serves no dashboard of its own, and the main app forwards Data/Functions/Settings calls to it (`?target=<name>`) with the user's role. Source lines in errors are not shown for services.

## Cost and tuning

Telemetry costs about 2 µs a cached request and 7 µs with three spans; writes happen on a thread of its own once a second. Keep `TELEMETRY` on. Lower `TELEMETRY_DETAIL_PER_SECOND` only for extreme load; raise `LOG_RETENTION_DAYS` knowing it costs disk. The telemetry thread answers one query at a time: any new telemetry read you add must be indexed and grouped, and tested on thousands of rows.

## Common mistakes

- Leaving the dashboard on in production without HTTPS, accounts and a network fence, or sharing `ADMIN_KEY` instead of accounts.
- Editing data on the Data page and expecting function checks to run (they do not), or pasting secrets into edits (audited verbatim).
- Using high-cardinality attributes (user ids, urls) on metrics.
- Pointing `OTEL_EXPORTER_OTLP_ENDPOINT` at the app itself.
- Expecting traces for every request on a busy server (sampled), or per-service source lines in a monorepo.
- Setting `MICROSERVICES` addresses to `localhost` in production, or a service's `OTEL_SERVICE_NAME` different from its name in `MICROSERVICES`.
- Searching by URL instead of by route pattern (`GET /users/:id`).
- Treating a 4xx from a controller as an error issue (it is a client error).

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                                  | Read it for                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [dashboard](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/dashboard.mdx)         | sign-in, roles, every page, the admin API, the audit log                              |
| [observability](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/observability.mdx) | what is recorded, sampling, spans and metrics, OTLP, SLOs, alerts, monorepo dashboard |
| [api-docs](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/api-docs.mdx)           | the API docs page the dashboard links                                                 |
| [configuration](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/configuration.mdx) | `DASHBOARD`, `TELEMETRY_*` and related settings                                       |
