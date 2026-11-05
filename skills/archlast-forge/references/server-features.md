# Server features: auth, storage, scheduling, HTTP endpoints, API docs, limits, telemetry hooks

Read this when you add sign-in or roles, file uploads, delayed or recurring work, webhooks or plain HTTP routes, or when a call is refused by a limit. Config and deployment of the same features: [operations.md](operations.md). Dashboard and the Observe pages: [dashboard-and-observability.md](dashboard-and-observability.md).

> **Examples here call `ctx.auth`, `ctx.storage` and `ctx.scheduler` inline to stay short.** In a project that code belongs in the feature's services in `forge/_modules/<feature>/` (an `ActionCtx` service for storage and other I/O), with thin handlers: see [feature-blueprint.md](feature-blueprint.md).

All of this lives in `forge/` (server only). Special modules, skipped when functions are listed: `schema.ts`, `auth.ts`, `crons.ts`, `http.ts`. Files or folders starting with `_` are never function modules. A function is named `<file path>:<export>` (`files:generateUploadUrl`, `admin/users:list`).

| Need                             | File                       | API                                               |
| -------------------------------- | -------------------------- | ------------------------------------------------- |
| Sign-in, sessions, roles         | `forge/auth.ts` (optional) | `defineAuth`, `ctx.auth.getUserIdentity()`        |
| Files                            | any module                 | `ctx.storage.generateUploadUrl / getUrl / delete` |
| Run later                        | any mutation or action     | `ctx.scheduler.runAfter / runAt / cancel`         |
| Run repeatedly                   | `forge/crons.ts`           | `cronJobs()`                                      |
| Webhooks, public JSON, downloads | `forge/http.ts`            | `httpRouter`, `httpAction`                        |
| Spans and metrics                | any function               | `trace`, `metrics`                                |

## Authentication (Better Auth, inside your database)

Email + password works with no setup, at `/api/auth/*` (e.g. `POST /api/auth/sign-up/email` with `origin` header and `{ email, password, name }`). Data lives in `users`, `sessions`, `accounts`, `verifications`: reactive, in backups, visible in the dashboard.

**The moment `forge/auth.ts` exists, nothing is on by default.** Omit `emailAndPassword: { enabled: true }` and sign-up answers `EMAIL_PASSWORD_SIGN_UP_DISABLED`.

```ts
// forge/auth.ts
import { defineAuth } from "@archlast/forge-runtime";

export default defineAuth({
  emailAndPassword: { enabled: true, minPasswordLength: 10 },
  socialProviders: {
    github: {
      clientId: process.env.GITHUB_CLIENT_ID!,
      clientSecret: process.env.GITHUB_CLIENT_SECRET!,
    },
  },
  session: { expiresIn: 60 * 60 * 24 * 14, updateAge: 60 * 60 * 24 },
});
```

Options are Better Auth's own (the engine pins `better-auth` 1.7.x; check its docs for names). The engine owns these, whatever you pass:

| Option                                | Behavior                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `database`                            | Always the engine's document-store adapter. Cannot be changed.                                     |
| `secret`, `baseURL`                   | From `BETTER_AUTH_SECRET`, `BETTER_AUTH_URL`.                                                      |
| `trustedOrigins`                      | Your **array** plus `TRUSTED_ORIGINS`. A function is ignored.                                      |
| `rateLimit`                           | `enabled` outside dev only; your options win. With `REDIS_URL` counters are shared across servers. |
| `databaseHooks`                       | Yours, plus a `session.create.before` that refuses banned users first.                             |
| `advanced.ipAddress.ipAddressHeaders` | Forced to the engine's trusted client IP (honors `TRUST_PROXY`).                                   |

Better Auth's own limits (outside dev): sign-in, sign-up, change-password, change-email allow 3 requests per 10 s per address; password-reset and verification-email requests 3 per 60 s. Tests that sign in repeatedly against a production-mode server get `429`.

### Reading the caller

```ts
import {
  ForgeError,
  mutation,
  v,
  type MutationCtx,
  type QueryCtx,
} from "@archlast/forge-runtime";

export async function requireUser(ctx: QueryCtx | MutationCtx) {
  const me = await ctx.auth.getUserIdentity(); // { userId, sessionId, email, name } | null
  if (!me) throw new ForgeError("Sign in");
  return me;
}

export const send = mutation({
  args: { body: v.string() },
  handler: async (ctx, { body }) => {
    const me = await requireUser(ctx);
    return ctx.db.insert("messages", {
      body,
      authorId: me.userId,
      authorName: me.name,
    });
  },
});
```

- `getUserIdentity()` works in queries, mutations, actions and HTTP handlers. `null` for anonymous, and also for a forged, expired or revoked cookie. Only those four fields exist: for `emailVerified`, `image`, `role` call `ctx.db.get(me.userId)`.
- **Authorize inside every public function.** Hiding UI protects nothing; anyone can `POST /rpc/<name>`. Never accept a `userId` argument and trust it: use `me.userId`. Compare the row's owner with the caller before patching or deleting.
- Helpers and admin-only work: `internalQuery/internalMutation/internalAction` (not in `api`, answer as if missing to clients).
- A query that reads `ctx.auth` is cached **per user**. If `ctx.auth` is only used to decide who may call, put that check in the query's `access: (ctx, args) => …` option (throw a `ForgeError` to refuse); the handler then cannot read `ctx.auth` and its one result is shared by every caller who passes.
- Identity is resolved once per request from the `cookie` and `authorization` headers. `Authorization: Bearer` is ignored unless you add Better Auth's `bearer()` plugin. Cookies: `better-auth.session_token` (`__Secure-` prefix and `Secure` when `BETTER_AUTH_URL` is https), `HttpOnly`, `SameSite=Lax`, 7 days by default.
- Adding **any** plugin switches off the engine's fast cookie path (a millisecond slower per call); behavior is the same.
- A scheduled function runs anonymously: `getUserIdentity()` is `null`. Pass `userId` as an argument.

### Roles, plugins, hooks

```ts
export default defineAuth({
  emailAndPassword: { enabled: true },
  user: {
    additionalFields: {
      role: { type: "string", defaultValue: "member", input: false },
    },
  },
});
```

`input: false` stops a client choosing its own role at sign-up (verified: a `role: "admin"` in the sign-up body is ignored). `role` is not in the generated `Doc<"users">`, so read it with a cast: `(await ctx.db.get(me.userId) as { role?: string } | null)?.role`. Promote users from the dashboard Data page, or with Better Auth's admin plugin (adds `role`, `banned`).

- **Reserved table names** `users`, `sessions`, `accounts`, `verifications`: `defineSchema` throws. Keep your per-user data in your own table with `userId: v.id("users")` and an index. Never write the auth tables yourself and never return `accounts` rows to clients (password hash, OAuth tokens).
- **Plugins** that only add fields to users/sessions work as is. Plugins that add **tables** (two-factor, organization, passkey) need those tables in `schema.ts` with every field the plugin writes, else `Unknown table "twoFactors"` or `<table>.<field> is not in the validator`. Expect to iterate. `import { bearer } from "better-auth/plugins"` resolves with nothing to install.
- **`databaseHooks`** run outside any function call: no `ctx`. Use them to refuse (`before` returns `false`; the client gets 400 `FAILED_TO_CREATE_USER`) or adjust (`return { data }`). Do app setup (create a `profiles` row) in a mutation the user calls afterwards.
- **Email:** the engine sends nothing. Provide `emailAndPassword.sendResetPassword`, `emailVerification.sendVerificationEmail`, etc. and call your mail provider with `fetch` inside them. Reset flow verified end to end: request, link token, `reset-password` works once, a second use answers 400 `INVALID_TOKEN`. Put provider keys in `archlast-forge env set` or the server environment, read them with `process.env`.
- **Banned users:** the dashboard's Ban sets `banned: true`, deletes their sessions, and new sign-ins fail.
- **Dashboard accounts are a different system** (`_admins`, `archlast-forge admin add`). App users cannot reach the dashboard.

### Browser side, origins, cookies

```tsx
import { useAuth, useSession } from "@archlast/forge-react";

const auth = useAuth(); // Better Auth client: signIn.email, signUp.email, signOut, signIn.social, ...
const { data, isPending } = useSession(); // data: { user, session } | null; isPending on the server and while hydrating
const { error } = await auth.signIn.email({ email, password }); // returns { data, error }, never throws
```

The client reconnects its live-query socket when the session changes, so subscriptions rerun as the new user. In a full-stack app use `useViewer()` and `ctx.viewer()` in loaders (see the full-stack reference); a loader guard is a convenience, not security.

| Variable             | Rule                                                                                                                                                                                                                                          |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` | Required outside dev (32+ random chars). Changing it signs everyone out. Dev: generated into `DATA_DIR/.dev-secrets.json`.                                                                                                                    |
| `BETTER_AUTH_URL`    | Public address; must be `https://` outside dev unless `ALLOW_INSECURE_HTTP=1`. Builds email links and OAuth callbacks (`<url>/api/auth/callback/<provider>`).                                                                                 |
| `TRUSTED_ORIGINS`    | Comma list of other browser origins (`https://app.example.com`, no path, no trailing slash). Adds CORS headers on `/rpc` and `/api/auth` and passes Better Auth's origin check. `trustedOrigins` in `auth.ts` only passes the check, no CORS. |

Same origin (default) needs none of it. Different origin: list it in `TRUSTED_ORIGINS` and create the client with `{ url }`. Different **site**: cookies are `SameSite=Lax` and are not sent; proxy through the frontend's origin instead. A 403 `INVALID_ORIGIN` means the `Origin` header is not trusted (`127.0.0.1` is not `localhost`). Native apps: see the mobile docs (`expo()` plugin, `init --mobile`).

## File storage (`ctx.storage`)

Backends: S3-compatible (`S3_ENDPOINT` + `S3_BUCKET` both or neither; keys `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION`; path-style URLs; the bucket must exist), or the engine's own disk. `STORAGE` is `s3` (default when `S3_ENDPOINT` is set), `local` (default in dev without S3: `DATA_DIR/storage`, served at `/_storage/<key>`), `off` (default in production without S3). With storage off any `ctx.storage` call throws `Storage is not configured: set S3_ENDPOINT and S3_BUCKET, or STORAGE=local to keep files on this server` (a generic "Server error" to clients outside dev). Function code is identical across backends.

**Upload flow: three steps, you write steps 1 and 3.**

```ts
// forge/files.ts
import { ForgeError, mutation, query, v } from "@archlast/forge-runtime";

export const generateUploadUrl = mutation({
  args: { contentType: v.optional(v.string()) }, // the helpers pass { contentType }
  handler: async (ctx, args) => {
    if (!(await ctx.auth.getUserIdentity()))
      throw new ForgeError("Sign in to upload");
    if (args.contentType && !args.contentType.startsWith("image/"))
      throw new ForgeError("Only images");
    return ctx.storage.generateUploadUrl(args); // { uploadUrl, storageId }
  },
});

export const setAvatar = mutation({
  args: { storageId: v.id("_storage") },
  handler: async (ctx, { storageId }) => {
    const me = await ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in first");
    // save storageId on the document that owns the file; see "claim" below
  },
});
```

```tsx
import { useMutation, useUploadFile } from "@archlast/forge-react";
const upload = useUploadFile(api.files.generateUploadUrl); // asks for the URL, PUTs the file with its content-type
const save = useMutation(api.files.setAvatar);
await save({ storageId: await upload(file) });
```

Outside React: `client.uploadFile(api.files.generateUploadUrl, file)`. Plain `fetch`: call the mutation, `fetch(uploadUrl, { method: "PUT", body: file, headers: { "content-type": file.type } })`, then your save mutation. The helpers throw `Upload failed (<status>)` on a non-2xx PUT.

- The engine ships no default `generateUploadUrl` (`init` with `s3` writes `forge/files.ts` with one): **you decide who may upload and what types**.
- A `_storage` row (`{ _id, _creationTime, key, contentType? }`) is created when the URL is issued, not when the upload finishes. It has no size, name or owner: store those on your own documents. Reference files with `v.id("_storage")`; that validator accepts **any** file's id, so check ownership (store pending ids per user when issuing, delete the pending row when claiming) or a user can attach someone else's file.
- `await ctx.storage.getUrl(id)` (queries, mutations, actions) returns a presigned GET URL or `null` (no row). Valid **1 hour**, not configurable. **There is no public mode**: anyone with the URL reads the file until expiry, so only return it to people who may see the file, and never store URLs, store `storageId`. A query returning `getUrl` is live; each rerun signs a fresh URL.
- Login-protected download: an HTTP route that checks `ctx.auth` and answers `Response.redirect(url, 302)` (below). Truly public files: serve from a public bucket or CDN using `(await ctx.db.get(storageId))?.key`.
- `await ctx.storage.delete(id)` removes the row inside your transaction and the object **after commit**; unknown id is a no-op. Deleting the owning document does not delete the file: do both in one mutation, and clear dangling ids.
- **No limits are enforced by the engine**: not size (bytes bypass the engine with S3), not type (the signature covers URL and host only). Check `file.size`/`file.type` in the browser, refuse types in `generateUploadUrl`, add bucket-side policy. Orphans (URL issued, never claimed) need your own sweep: record pending ids, delete stale ones from an `internalMutation` run by a cron.
- No way to read an object's size or type from a function; no resumable/multipart upload; one bucket per deployment.

**S3 specifics:** browsers PUT to `S3_PUBLIC_ENDPOINT` (defaults to `S3_ENDPOINT`). When the engine reaches storage by an internal name (`http://rustfs:9000`), set `S3_PUBLIC_ENDPOINT` to the address browsers use, and pass the `Host` header through any proxy unchanged or signatures break. The bucket needs CORS: your origin (or `*` in dev), method `PUT` (+`GET` for `fetch`), header `content-type`. Dev: `archlast-forge dev --with s3` starts RustFS on `localhost:9000` (`forgeadmin`/`forgeadmin`, bucket `forge`, CORS `*`).

**Built-in storage (`STORAGE=local`):** the engine signs the URLs (HMAC over method, key, expiry), bytes pass through it, `MAX_UPLOAD_MB` (default 5120) caps a file, `STORAGE_PUBLIC_URL` (default `BETTER_AUTH_URL`) is the address in URLs, files are served sandboxed (`Content-Security-Policy: sandbox`, `nosniff`). One server only (`REPLICAS > 1` refuses to start). Switching `local` <-> `s3` moves nothing: back up with files, switch, restore.

## Scheduling and crons

Only **mutations and actions** can be scheduled (`ctx.scheduler` exists in mutation and action contexts, not in queries). Arguments are validated when you schedule; a wrong argument throws at the scheduling call, and so does a query or unknown function.

```ts
import { internal } from "./_generated/api";

const id = await ctx.scheduler.runAfter(60_000, internal.reminders.send, {
  todoId,
}); // ms from now
await ctx.scheduler.runAt(
  Date.parse("2027-01-01T00:00:00Z"),
  internal.reports.yearly,
); // epoch ms; the past runs at the next poll
await ctx.scheduler.cancel(id); // only if still pending; no-op otherwise
```

- Returns the job id (`_scheduled_functions:…`). From a **mutation** the job exists only if the mutation commits. From an **action** each call is its own write, kept even if the action later fails.
- Prefer `internal.*` targets. The job holds only the arguments given at scheduling time ("frozen": a changed `args` validator makes old jobs fail). **Re-check state when it runs** (the todo may be done or deleted). To cancel on change, store the job id on the document.
- If the function is renamed or removed first, the job fails with `Unknown function "…"`.

|              | Scheduled mutation                                   | Scheduled action                                                                  |
| ------------ | ---------------------------------------------------- | --------------------------------------------------------------------------------- |
| Guarantee    | **exactly once**: claimed inside its own transaction | **at most once**: marked `running`, then run, **never retried**                   |
| Throws       | rolls back, job `failed` with the message            | job `failed`                                                                      |
| Process dies | job still `pending`, runs again                      | stays `running`, then `failed` ("Interrupted…") after `ACTION_TIMEOUT_MS` + 1 min |
| Time limit   | `FUNCTION_TIMEOUT_MS` (10 s)                         | `ACTION_TIMEOUT_MS` (10 min)                                                      |

Do database work in a scheduled **mutation**. An action that sends email or charges a card may have done it and still report failure: record intent in a mutation first, send with an idempotency key, and let a cron find unfinished records. Retry a failed or canceled job from the dashboard Jobs page (creates a new job; the old row stays failed).

States: `pending`, `running` (actions only), `success`, `failed`, `canceled`; finished rows are deleted after `LOG_RETENTION_DAYS` (7). Scheduler facts: every server polls every 500 ms (a job runs within about half a second of its time, so no sub-second timing); claims are atomic, so servers never double-run; up to 50 jobs at once per server; jobs due while the server was down run when it returns; use NTP with several servers.

```ts
// forge/crons.ts: must default-export what cronJobs() returns
import { cronJobs } from "@archlast/forge-runtime";
import { internal } from "./_generated/api";

const crons = cronJobs();
crons.interval("purge done todos", { hours: 1 }, internal.todos.purgeDone); // seconds / minutes / hours, at least 1 s
crons.cron("weekday digest", "0 9 * * 1-5", internal.digest.send); // 5 fields, 09:00 UTC; `@daily` and `MON` work, no seconds field
crons.interval("sync prices", { minutes: 15 }, internal.prices.sync, {
  currency: "usd",
}); // args last
export default crons;
```

- **Everything is UTC.** No time-zone option.
- Intervals follow the epoch grid (`{ hours: 1 }` runs at the top of each hour, not N after boot); an interval that does not divide an hour (`{ minutes: 7 }`) drifts across hours. Use a cron expression for a time of day.
- Names are unique (`Duplicate cron job "x"` when `forge/` loads; renaming = a new cron). The target must be a mutation or action that exists (`Cron "x" targets unknown function "y"` / `a query`). An invalid expression stops loading (`Invalid cron expression: expected 5 space-separated fields …`): `dev` keeps retrying until fixed, production refuses to start.
- One run per slot across servers (deterministic id `cron:<name>:<time>`), but slots can overlap between servers: make the work safe to repeat. **No catch-up**: slots missed while every server was down are skipped.
- **Bound each run.** A huge delete in one transaction holds SQLite's single write lock. Do a batch (`.take(100)`), and have the job `runAfter(0, …)` itself until empty (annotate its return type, since it references its own module).
- An action that calls functions from its own module needs an explicit return type (`handler: async (ctx): Promise<void> => …`) or TypeScript reports an implicit-any cycle.
- `createTestBackend` runs scheduled jobs (`await t.finishScheduledFunctions()`) but not crons; call the cron's function directly in tests ([testing.md](testing.md)).

## HTTP endpoints (`forge/http.ts`)

For things that cannot be a function call: webhooks, public JSON, downloads, health checks. Routes live under the prefix **`/http`**: `path: "/lists"` answers at `/http/lists` and the handler sees `/lists`. **`httpRouter({ root: true })`** also serves every route at its own path (`/lists`, `/api/v1/...`, `/webhooks/stripe`), after the engine's paths and, in a full-stack app, before the pages; a route inside an engine path (`/rpc`, `/api/auth`, `/_admin`, ...) fails at load. See [nest-services.md](nest-services.md) for Nest under a root prefix.

```ts
// forge/http.ts
import { httpAction, httpRouter, v } from "@archlast/forge-runtime";
import { api, internal } from "./_generated/api";

const http = httpRouter();

http.route({
  method: "POST", // GET POST PUT PATCH DELETE OPTIONS. HEAD is not supported (405).
  path: "/orders", // exact; or pathPrefix: "/files/" (starts and ends with "/")
  summary: "Place an order",
  tags: ["Orders"], // OpenAPI only
  query: { dryRun: v.optional(v.boolean()), limit: v.optional(v.number()) }, // checked before the handler; text is converted
  body: v.object({ sku: v.string(), qty: v.number() }), // JSON body, checked before the handler
  returns: v.object({ id: v.string() }), // OpenAPI only
  handler: httpAction(async (ctx, request) => {
    const input = (await request.json()) as { sku: string; qty: number };
    const id = await ctx.runMutation(internal.orders.place, input);
    return Response.json({ id });
  }),
});

export default http; // a bare function as handler is rejected: always httpAction()
```

- **Routing:** exact `path` wins, then the longest matching `pathPrefix`; the path exists under other methods -> 405 with `Allow`; nothing -> 404 `Not found`. **No path parameters** (`/orders/:id` matches the literal text): register `pathPrefix: "/orders/"` and parse `new URL(request.url).pathname`. Trailing slash is a different path. Mistakes (bad method, both/neither of `path` and `pathPrefix`, duplicate route, missing `httpAction`) throw when the file loads.
- **Validators:** a mismatch answers 400 `{ "error": { "code": "BAD_REQUEST", "message": "body.qty must be a finite number, got \"two\"", "requestId" } }` and the handler never runs; a non-JSON body gives `The body must be JSON`. The handler still receives the unread request. `v.number()`/`v.boolean()` query values are converted, `v.array` takes repeated params. Validation that function `args` give you does not apply to query-string values you read yourself: cap `limit` yourself.
- **Handler = an action** with a `Request` and a `Response`, same `ctx` as an action: `runQuery`, `runMutation`, `runAction`, `auth`, `storage`, `scheduler`, and **no `ctx.db`**. Everything runs as the caller. Each `runMutation` is its own transaction; put all-or-nothing writes in one mutation. Time limit `ACTION_TIMEOUT_MS`, so acknowledge a webhook fast and `ctx.scheduler.runAfter(0, internal.x.y, args)` the slow part.
- **Bodies are bytes and buffered**: `await request.text()` (exact bytes), `arrayBuffer()`, `json()`. Over `MAX_REQUEST_BYTES` (8 MiB) is a 413 before your code. Responses are buffered too, **except** `content-type: text/event-stream`, which streams (verified inline and with child-process runtimes). For big files redirect to a presigned URL.
- **Return a `Response`**; anything else is a 500. Status and headers pass through (multiple `set-cookie` survive); 204/304 have no body; `Response.redirect(url, 302)` works. `x-request-id` is added (a caller's own, 1-64 chars of `[A-Za-z0-9._-]`, is reused).
- **Errors:** throw `ForgeError` -> 400 `{ error: { message, code: "BAD_REQUEST", data, requestId } }`; any other throw -> 500 `Server error (request <id>)` outside dev (log has the real error); a malformed id passed to a storage call -> 400; past the timeout -> 408 `TIMEOUT`; runtime queue full -> 503 `Retry-After: 1`. A `Response` you return is sent exactly as is.
- **Caller identity:** the session cookie works on your own origin. Webhooks and server-to-server callers send neither cookie nor bearer, so they are anonymous: authenticate with a signature or shared secret.
- **CORS is entirely yours.** The engine adds no CORS headers to `/http` and `TRUSTED_ORIGINS` does not apply. Without an `OPTIONS` route a browser preflight gets 405 and the real request is never sent. Add an `OPTIONS` route (`pathPrefix: "/api/"` covers many) returning 204 with `access-control-allow-origin: <the allowed origin>`, `-methods`, `-headers`, and `vary: origin`; set the same origin header on the real responses. Never combine credentials with `*`.
- **Rate limit:** `/http/*` counts against `RATE_LIMIT_PER_MINUTE` per client IP (429 `{"message":"Too many requests"}`, `Retry-After`). A provider sending from few IPs, or a proxy without `TRUST_PROXY=1`, trips it.
- The engine already answers `GET /health` (liveness) and `GET /ready` (functions loaded); a route of yours at `/http/health` can additionally check the database.
- Not supported: path params, `HEAD`, WebSockets here (use Nest gateways, see [nest-services.md](nest-services.md)), a route list in the dashboard, `createTestBackend` (test with a real server and `fetch`). Nest controllers mount on the same router via `nest(http, …)`.

**Webhook, the pattern to copy** (verify over the exact bytes, constant-time compare, dedupe by event id, acknowledge fast):

```ts
import { timingSafeEqual } from "node:crypto";

http.route({
  method: "POST",
  path: "/webhooks/acme",
  handler: httpAction(async (ctx, request) => {
    const secret = process.env.ACME_WEBHOOK_SECRET;
    if (!secret) return new Response("Webhook not configured", { status: 503 });
    const body = await request.text(); // not request.json(): re-serializing changes the bytes
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const mac = Buffer.from(
      await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body)),
    ).toString("hex");
    const given = Buffer.from(request.headers.get("x-acme-signature") ?? "");
    if (
      given.length !== mac.length ||
      !timingSafeEqual(given, Buffer.from(mac))
    )
      return new Response("Bad signature", { status: 401 });
    const event = JSON.parse(body) as { id: string };
    const { duplicate } = await ctx.runMutation(internal.webhooks.record, {
      source: "acme",
      eventId: event.id,
      payload: body,
    });
    if (!duplicate)
      await ctx.scheduler.runAfter(0, internal.webhooks.handle, {
        source: "acme",
        eventId: event.id,
      });
    return Response.json({ received: true, duplicate });
  }),
});
```

`internal.webhooks.record` is an `internalMutation` that looks the event up by an index and inserts if absent. Add a timestamp check if the provider signs one. **Download behind login:** `if (!(await ctx.auth.getUserIdentity())) return new Response("Sign in", { status: 401 }); const url = await ctx.storage.getUrl(id as Id<"_storage">); return url ? Response.redirect(url, 302) : new Response("No such file", { status: 404 });`

## API docs and OpenAPI

The engine builds an OpenAPI 3.1 document from what runs: every **public** function (`POST /rpc/<module>:<name>`, internal ones left out), every `http.route()` (validators `query`/`body`/`returns` become the schemas, with their constraints, enums, descriptions and examples), and Nest controllers (`@Contract`). Nothing to write by hand. It serves the document and one docs page where each operation can be tried ("Try it", loaded only when pressed).

Configure them **in code**, once, in `forge/http.ts`:

```ts
const http = httpRouter({ root: true });
http.docs({
  path: "/docs", // the page; default /_api
  openapi: "/openapi.json", // default <path>/openapi.json
  production: true, // serve in production too (default: dev only)
  include: ["/api/v1"], // the public audience: only these prefixes
  functions: false, // leave /rpc out of a REST API's docs
  info: { title: "Acme API", version: "v1", description: "..." },
  securitySchemes: { oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "/api/auth/oauth2/token", scopes: { "orders:read": "Read orders" } } } } },
  security: [{ oauth: [] }],
  errors: { schema: Problem, contentType: "application/problem+json", common: { 401: "unauthorized" } }, // Problem: a named v.object
  parameters: { idempotencyKey: { in: "header", name: "Idempotency-Key", schema: v.string() } },
  tags: [{ name: "Orders", description: "..." }],
  webhooks: { events: { "order.paid": { summary: "...", data: Order } } },
  page: { title: "Acme", theme: { accent: "#6d28d9" } },
});
```

Per route (`http.route({...})` or `@Contract({...})`): `summary`, `tags`, `security: [{ oauth: ["orders:write"] }]`, `errors: { 404: "order_not_found" }`, `parameters: ["idempotencyKey"]`, `responseHeaders`, `status`, `codeSamples`, `hidden: true` (served, not documented), `deprecated`. On Nest: `@ApiSecurity("oauth", scopes)` (put it in your scope guard's decorator so it documents itself) and `@ApiHidden()` (inbound webhooks).

| Setting         | Default                                                                                          |
| --------------- | ------------------------------------------------------------------------------------------------ |
| `API_DOCS`      | unset: the code decides (on in dev; in production with `production: true`); set, it wins        |
| `API_DOCS_PATH` | unset: `http.docs({ path })`, else `/_api`; cannot be under an engine path (`/rpc`, `/http`, ...) |

The docs own only their page, `<path>/_docs/*`, the explorer path and the document: the app's own pages under the same prefix (`/docs/guides`) keep working, and a page or root route at one of the docs' paths is reported (production refuses to start). In dev `openapi.json?audience=all` is the complete document. Put prose in `forge/docs/*.mdx` (front matter `title`, `group`, `order`) and slots in `forge/docs/_slots/` (`header.mdx`, `sidebar-footer.mdx`, `operation-before.mdx`, `operation-after.mdx`). A full-stack app can render the reference in its own layout with `ApiReference` from `@archlast/forge-dashboard/api-docs/react`. Give every documented route `summary`, `tags` and `returns`: dev warns when one is missing.

## Limits you will meet

Checked by the engine whatever your code does. Defaults, variable, what the caller sees:

| Limit                           | Default               | Variable                           | Result                                                                                        |
| ------------------------------- | --------------------- | ---------------------------------- | --------------------------------------------------------------------------------------------- |
| Query/mutation time             | 10 s                  | `FUNCTION_TIMEOUT_MS`              | 408 `TIMEOUT`; a mutation rolls back                                                          |
| Action / HTTP handler time      | 10 min                | `ACTION_TIMEOUT_MS`                | 408 `TIMEOUT`; `ctx.runMutation` work already done stays                                      |
| Request body, WebSocket message | 8 MiB                 | `MAX_REQUEST_BYTES`                | 413; socket closed                                                                            |
| Result size                     | 8 MiB                 | `MAX_RESULT_BYTES`                 | server error: paginate                                                                        |
| Document size                   | 1 MiB                 | `MAX_DOCUMENT_BYTES`               | 400 validation error: keep blobs in storage                                                   |
| Requests per client IP          | 1200/min (off in dev) | `RATE_LIMIT_PER_MINUTE`            | 429 `{"message":"Too many requests"}` + `Retry-After`; sockets close with 1008                |
| Subscriptions per socket        | 200                   | `MAX_SUBSCRIPTIONS_PER_CONNECTION` | extra one refused (query once per list, not per row)                                          |
| Waiting calls per runtime       | 1000                  | `MAX_PENDING_CALLS`                | 503 `Server is busy, try again`, `Retry-After: 1`; retry with jitter (the function never ran) |
| Documents scanned by `filter`   | 100,000               | none                               | query fails: add `withIndex`                                                                  |

A function that never yields (`while (true)`) is killed after timeout + 5 s; in production inline mode that takes the whole process down, so it must run under a restarting supervisor (the generated compose has one). Rate limiting is per IP, not per user: limit expensive mutations per user in code. Counters are per process unless `REDIS_URL` is set. Behind a proxy set `TRUST_PROXY=1` (last `X-Forwarded-For` entry is used; only when the proxy overwrites that header), else all visitors share the proxy's budget. `POST /rpc/*` needs `content-type: application/json` (415 otherwise).

**Security rules for app code:** authorize and check row ownership in every public function; helpers `internal*`; bound string/array args yourself (`v.string()` accepts 5 MiB); a `ForgeError` message goes to the browser, keep internals out; never `fetch` a user-supplied URL; verify webhook senders; every function can read the whole environment (`process.env`); actions are at-most-once so a charge needs an idempotency key. Only `ForgeError` and validation errors reach callers with their text, everything else becomes `Server error (request <id>)`.

## Web application firewall (opt-in)

`WAF=on` runs every request through the OWASP Core Rule Set (Coraza) before it reaches a function: SQL injection, script injection, path traversal and the like get `403` (`code: "FORBIDDEN"`). Off by default; do not turn it on for an app that did not ask for it, since it costs about a millisecond a request and over 100 MB of memory per thread.

| Variable             | Default | Effect                                                                                  |
| -------------------- | ------- | --------------------------------------------------------------------------------------- |
| `WAF`                | off     | Turns it on                                                                             |
| `WAF_MODE`           | `block` | `detect` only logs what it would stop: start there on a live app                        |
| `WAF_PARANOIA`       | `1`     | 1 to 4; higher flags more legitimate requests                                           |
| `WAF_WORKERS`        | `1`     | Threads, each with its own copy of the rules in memory                                  |
| `WAF_MAX_BODY_KB`    | `512`   | Larger bodies are not inspected (URL and headers still are)                             |
| `WAF_IGNORE_PATHS`   | none    | Path prefixes that are not inspected, like `/http/stripe`                               |
| `WAF_DISABLED_RULES` | none    | CRS rule ids to switch off, like `942100`; the log names the rules that blocked a call |

It does not look at the dashboard, storage, `/_app` or static files. Bodies that are not a form, multipart, XML or JSON are refused (rule 920420), and a plain-text body with a line break is too (921150): a route that takes binary or text bodies, such as a webhook from a provider that sends `text/plain`, goes in `WAF_IGNORE_PATHS`. If sign-in blocks a strong password, add `/api/auth` there or switch off the rule the log names. It is a layer, not a substitute for authorizing in every function.

The dashboard's **Firewall** page (admin group) watches it (counters, charts, the latest events, the rules, paths and clients that matched most, thread health) and, for owners, runs it with no restart: Off, Detect or Block, paranoia, threads, ignored paths and switched-off rules, saved as the `WAF_*` settings (a value the environment sets is shown locked). An event opens to switch off its rule or ignore its path, and **Try a request** shows what the live rules make of a described request. Roll out by turning it on in Detect, reading the events over real traffic, tuning, then Block. Its numbers are per server and start at zero with it; `/metrics` has `forge_waf_requests_total` and `forge_waf_rule_matches_total`.

## Telemetry hooks from app code

Every request is recorded automatically (functions, DB statements, outbound `fetch`, jobs, HTTP routes). Add your own:

```ts
import { action, metrics, trace, v } from "@archlast/forge-runtime";

const placed = metrics.counter("orders.placed");
const basket = metrics.histogram("orders.basket_size", { unit: "items" });
const depth = metrics.gauge("queue.depth");

export const checkout = action({
  args: { cartId: v.id("carts") },
  handler: async (ctx, { cartId }) => {
    const quote = await trace.span("pricing.quote", async () => {
      // nests everything awaited inside
      trace.annotate({ cartId }); // attributes on this span; { request: true } for the request
      return price(cartId);
    });
    placed.add(1, { plan: quote.plan });
    basket.record(quote.items.length);
    depth.set(await pending(ctx));
  },
});
```

- `trace.span(name, fn, attrs?)`, `trace.annotate(attrs, { request?: true })`, `metrics.counter(name, { unit? }).add(n?, attrs?)`, `.gauge(...).set(n, attrs?)`, `.histogram(...).record(n, attrs?)`. Attribute values: string, number, boolean. Names start with a letter and use letters, digits, `.`, `_`, `-`, `/`; at most 200 series per metric per minute, so never put ids in attributes.
- Outside the engine (`createTestBackend`, a browser) spans just run `fn` and metrics do nothing. `console.log` in functions is stored with its trace. `TELEMETRY=off` disables recording.
- Reading the results (Spans, Hotspots, Errors, request ids, alerts) is in [dashboard-and-observability.md](dashboard-and-observability.md).

## Common mistakes

- Creating `forge/auth.ts` without `emailAndPassword: { enabled: true }` (sign-up dies with `EMAIL_PASSWORD_SIGN_UP_DISABLED`).
- Trusting a `userId` argument, or checking auth only in the UI or a loader.
- Declaring a table named `users`/`sessions`/`accounts`/`verifications`; writing those tables directly; returning `accounts` docs to clients.
- Adding a Better Auth plugin that needs tables without adding them (all fields) to `schema.ts`.
- Reading `role`/`emailVerified` off `getUserIdentity()` (only `userId`, `sessionId`, `email`, `name`).
- Expecting identity in a scheduled function or cron (anonymous; pass ids).
- Scheduling a query, or calling `ctx.scheduler` from a query; doing non-idempotent side effects in a scheduled action and assuming a retry; assuming a failed action reruns.
- Cron expressions written in local time (they are UTC); forgetting `export default crons`; an interval of `{ minutes: 7 }` expecting fixed minutes of the hour; unbounded cleanup in one transaction.
- Storing presigned URLs (they expire in 1 hour) instead of `storageId`; returning URLs to people who may not see the file; trusting `contentType` or size; letting `v.id("_storage")` args attach other users' files.
- Using S3 in Docker without `S3_PUBLIC_ENDPOINT` (browser cannot reach `rustfs:9000`) or without bucket CORS.
- Forgetting the `/http` prefix in URLs; using `:id` path params; adding a `HEAD` route; calling `ctx.db` in an HTTP handler; returning a string instead of a `Response`; expecting CORS headers from the engine on `/http`; verifying a webhook against `JSON.stringify(await request.json())` instead of the raw text.
- Streaming a large download through a handler (buffered): redirect to a presigned URL.
- Leaving `TRUST_PROXY` unset behind a proxy (everyone shares one rate-limit budget), or setting it when the proxy does not overwrite `X-Forwarded-For`.
- Reading secrets from the client or `src/`: they belong in `process.env` of `forge/` (`archlast-forge env set` or the server environment).

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                                  | Read it for                                               |
| --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| [auth](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/auth.mdx)                   | Better Auth, sessions, roles, plugins, dashboard accounts |
| [storage](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/storage.mdx)             | uploads, downloads, S3 and built-in storage               |
| [scheduling](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/scheduling.mdx)       | scheduled functions and crons                             |
| [http](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/http.mdx)                   | HTTP endpoints, validators, CORS, rate limits, streaming  |
| [api-docs](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/api-docs.mdx)           | OpenAPI and the API docs page                             |
| [limits](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/limits.mdx)               | every limit and the security model                        |
| [configuration](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/configuration.mdx) | the variables behind these features                       |
| [recipes](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/recipes.mdx)             | webhooks, cron cleanup, email, rate limits, uploads       |
