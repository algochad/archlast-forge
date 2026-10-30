# Errors

A call can fail in four ways, and the engine treats them differently:

| Failure | Who sees what |
|---|---|
| You throw a `ForgeError` | the caller gets the message and the data |
| Arguments (or a document) don't match their validators | the caller gets the validation message |
| The call times out or the server is overloaded | the caller gets a short, fixed message |
| Anything else: a bug, a failed `fetch`, a database error | in dev, the message. Elsewhere, only `Server error (request <id>)`; the details stay in the server log |

## ForgeError

Throw `ForgeError` for errors meant for the caller. Its message and data reach the client unchanged.

```ts
import { ForgeError } from "@archlast/forge-runtime";

if (!identity) throw new ForgeError("Sign in to post");
if (count >= limit) throw new ForgeError({ code: "LIMIT", max: limit });
```

`new ForgeError(data)` takes a string or any JSON value. With a string, `message` and `data` are both that string. With an object, `data` is the object and `message` is its JSON text (`{"code":"LIMIT","max":3}`), so read `data`, not `message`, for structured errors.

On the wire, both arrive as:

```json
{ "error": { "message": "{\"code\":\"LIMIT\",\"max\":3}", "code": "BAD_REQUEST", "data": { "code": "LIMIT", "max": 3 }, "requestId": "7c6d2958-g" } }
```

- **A `ForgeError` is always `400 BAD_REQUEST`.** There is no custom status or code on the error itself. Put your own machine-readable code in `data` (`{ code: "LIMIT" }`) and let the client branch on it. "Not signed in" is also a 400: the `401` and `403` codes belong to the dashboard's own API, not to your functions.
- **Throwing rolls back.** An error thrown in a mutation rolls back everything it wrote, including jobs it scheduled.
- **Where you can throw it:** queries, mutations, actions and HTTP actions. In a query, the error is what a live subscription reports (see below).
- **Keep data small and safe.** Everything in it goes to the caller. Don't put ids of other users' documents, internal paths or stack traces in it.

On the client the same error comes back as a `ForgeError` with the same `data`, and with `code` and `requestId` attached:

```ts
import { ForgeError } from "@archlast/forge-react"; // also exported by @archlast/forge-client

try {
  await send({ body });
} catch (e) {
  if (e instanceof ForgeError) {
    showToast(typeof e.data === "object" && e.data.code === "LIMIT" ? "Too many" : e.message);
  } else {
    showToast("Something went wrong");
    console.error(e, (e as { requestId?: string }).requestId);
  }
}
```

Validation errors and server errors come back as a plain `Error` (not a `ForgeError`), also with `code` and `requestId`.

## What reaches clients, and what doesn't

| Thrown | `code` | Message the caller sees |
|---|---|---|
| `ForgeError` | `BAD_REQUEST` | its message, plus `data` |
| Argument or document validation | `BAD_REQUEST` | the validation message |
| Function took too long | `TIMEOUT` | `todos:slow timed out after 10000 ms` |
| Too many calls waiting | `SERVICE_UNAVAILABLE` | `Server is busy, try again` |
| Any other `Error` | `INTERNAL_SERVER_ERROR` | in dev, its message. Elsewhere, `Server error (request 7c6d2958-3)` |

"Elsewhere" means anything not started with `archlast-forge dev`. The raw error is logged with the same request id, so a bug never leaks a connection string, a query or a stack trace to a browser. Examples that become `Server error` in production: a `TypeError` in your handler, a `fetch` that rejects, a failed `ctx.storage` call (storage isn't configured), a return value that doesn't match `returns` (`Invalid return value: …`, treated as a server bug), and a result bigger than `MAX_RESULT_BYTES`.

The same rules apply in WebSocket subscriptions, [HTTP actions](http.html) and the page loaders of a [full-stack app](framework.html).

### Validation errors

Arguments are checked before your handler runs, and documents when they are written. The message names the path:

| Message | When |
|---|---|
| `args.listId is required` | a required field is missing |
| `args.title must be a string, got 5` | wrong type |
| `args.listId must be an Id<"lists">, got "nope"` | an id of another table, or not an id |
| `args.extra is not in the validator` | an argument you didn't declare |
| `todos.priority is required` | a write whose document lacks a required field |
| `Document in "todos" is 1048700 bytes; the limit is 1048576 (MAX_DOCUMENT_BYTES)` | a document over the size limit |

Validators are strict: unknown fields are errors. The messages are made for developers and are shown to callers as they are, so don't put anything secret in a validator's field names. The same text shows when `archlast-forge migrate` lists documents that don't match the schema (see [Migrations](migrations.html)).

## Request ids and logs

Every response carries an `x-request-id` header and, when it is an error, the same value as `requestId` in the body. A server error shows it in the message: `Server error (request 7c6d2958-3)`.

- A client can send its own `x-request-id` (letters, digits, `_`, `.` and `-`, up to 64 characters). The server echoes it, so you can tag a call with an id from your own tracing. Anything else is replaced by a generated one.
- With `OTEL_EXPORTER_OTLP_ENDPOINT` set, an incoming `traceparent` is continued and each call is a span. See [Configuration](configuration.html).

To find what happened, search for the id:

- **Production logs** are JSON, one line per event, so you can `grep` them. The record has the id, the function and the stack:

  ```json
  {"time":"2026-10-24T13:58:03.110Z","level":"error","msg":"secret detail: db password is hunter2","requestId":"d2469220-1","function":"todos:boom","stack":"Error: secret detail: …\n    at handler (…/forge/todos.ts:69:15)\n …"}
  ```

- **The dashboard's Logs page** filters by request id, function, level and time across all servers. The call's `console.log` lines and a `call` entry (with its duration and whether it succeeded) carry the same id.
- **In dev**, the terminal prints the error with its `requestId` and `function`, and the client sees the real message.

Timeouts are logged as warnings, with the same id.

## HTTP status and code

For calls to `/rpc/<name>` (and `/http/*` routes that throw), the error envelope is `{ "error": { "message", "code", "data"?, "requestId" } }` with these statuses:

| Status | `code` | When | Example message |
|---|---|---|---|
| 400 | `BAD_REQUEST` | `ForgeError`; invalid arguments; a body that isn't JSON; a malformed function name | `The request must be valid JSON` |
| 404 | `NOT_FOUND` | no public function with that name. Internal functions look the same on purpose | `No function "todos:nothing"` |
| 405 | `METHOD_NOT_ALLOWED` | `GET` on a mutation or an action | `Call todos:add with POST` |
| 408 | `TIMEOUT` | a query or mutation took longer than `FUNCTION_TIMEOUT_MS` (10 s), an action longer than `ACTION_TIMEOUT_MS` (10 min), or a call missed the server's hard deadline | `todos:slow timed out after 10000 ms` |
| 415 | `UNSUPPORTED_MEDIA_TYPE` | a `POST` without `content-type: application/json` | `Send application/json` |
| 500 | `INTERNAL_SERVER_ERROR` | everything else | `Server error (request d2469220-1)` |
| 503 | `SERVICE_UNAVAILABLE` | more than `MAX_PENDING_CALLS` calls waiting; sends `Retry-After: 1` | `Server is busy, try again` |

Some responses don't use the envelope, because they are produced before a function is involved:

| Status | Body | When |
|---|---|---|
| 429 | `{ "message": "Too many requests" }` and `Retry-After: <seconds>` | the per-IP rate limit (`RATE_LIMIT_PER_MINUTE`). A WebSocket that is over it is closed with code 1008 |
| 503 | `{ "message": "Server is shutting down" }` and `Retry-After: 1` | the server is draining before a stop |
| 404 | `Not found` | a path the engine doesn't serve |

On the WebSocket, a refused subscription is `{ "type": "error", "id", "error": { "message", "code", "requestId" } }` with the codes `NOT_FOUND` (`No query "x"`), `BAD_REQUEST` (`Subscription 1 already exists`) or `TOO_MANY_REQUESTS` (`At most 200 subscriptions per connection`). A query that throws while running is not an `error` message: it is a `data` message with an `error` field, and the subscription keeps going. See [Reactivity](reactivity.html#the-websocket-protocol).

## Errors in React

**Queries.** `useQuery` and `usePaginatedQuery` throw an error to the nearest error boundary, as React expects for data a component can't render without. The error is a `ForgeError` when the function threw one, otherwise an `Error`, with `requestId` attached. Loading isn't an error: `useQuery` returns `undefined` until the first result.

```tsx
import { Component, type ReactNode } from "react";
import { ForgeError } from "@archlast/forge-react";

export class QueryBoundary extends Component<{ children: ReactNode }, { error?: Error & { requestId?: string } }> {
  state: { error?: Error & { requestId?: string } } = {};
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  reset = () => this.setState({ error: undefined }); // see below for clearing the query cache too
  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    return (
      <div role="alert">
        <p>{error instanceof ForgeError ? error.message : "Something went wrong."}</p>
        {error.requestId && <small>Reference: {error.requestId}</small>}
        <button onClick={this.reset}>Try again</button>
      </div>
    );
  }
}
```

When the boundary catches the error, the component unmounts and its subscription closes. Pressing "Try again" mounts it afresh, and it subscribes again from scratch: a query that fails now and works later recovers on the retry. (On `0.1.0` the failed state stayed in the query cache, so a retry met the same error again until the entry expired, five minutes later. If you are on that version, create your own `QueryClient`, pass it to the provider and drop the failed queries when you reset:

```tsx
const queryClient = new QueryClient();

<ArchlastForgeProvider client={client} queryClient={queryClient}>…</ArchlastForgeProvider>;

// in the boundary's reset
queryClient.removeQueries({ queryKey: ["archlast-forge"] });
this.setState({ error: undefined });
```

`QueryClient` comes from `@tanstack/react-query`.) A boundary with a `key` that changes with the arguments also starts fresh, because a different key is a different query.

For a query that is allowed to fail without breaking the page (a "related items" list), put its component in its own boundary rather than wrapping the page.

**Mutations and actions.** `useMutation` and `useAction` return functions that reject on failure; catch them where you call them. State (a toast, an inline message) belongs to the component, not to a boundary.

```tsx
const add = useMutation(api.todos.add);

async function onSubmit() {
  try {
    await add({ listId, title });
  } catch (e) {
    if (e instanceof ForgeError && typeof e.data === "object" && e.data.code === "LIMIT") setError(`At most ${e.data.max} items`);
    else if (e instanceof ForgeError) setError(e.message);
    else setError("Couldn't save. Try again."); // validation, timeout, server error, network
  }
}
```

- A mutation with `withOptimisticUpdate` undoes its local update when it rejects.
- A network failure (offline, DNS, a reset connection) rejects with the browser's `TypeError`, with no `code` and no `requestId`. When a request fails without an answer you can't know whether a mutation ran. Design retried mutations to be safe to repeat (use a client-generated key, or check first).
- The client doesn't retry on its own. A `429` rejects with an `Error` whose message is `Too many requests`, whose `code` is `TOO_MANY_REQUESTS` and which has a `retryAfter` property (seconds, from the `Retry-After` header); a `503` while the server is shutting down has `code` `SERVICE_UNAVAILABLE` and the same property. To back off, wait `retryAfter` seconds. (On `0.1.0` these answers surfaced as `429 Too Many Requests` with `code` `INTERNAL_SERVER_ERROR` and no `retryAfter`, so match on the message there.) A `503` from an overloaded engine has the full error envelope: its `code` is `SERVICE_UNAVAILABLE`, and a retry after a second or two is the right response.

## Errors in loaders and pages

In a [full-stack app](framework.html), a loader can fail in three ways, and each renders the nearest `ErrorBoundary` (a route's own, then `app/root.tsx`'s, then the built-in one) inside your `Layout`:

| In the loader | Status of the page | The boundary sees |
|---|---|---|
| `throw data("No such post", { status: 404 })` | the status you give | a route error response: `isRouteErrorResponse(error)` is true, with `status` and `data` |
| `throw redirect("/sign-in")` | 302 | nothing (the visitor goes elsewhere) |
| any other thrown error, including a failed `ctx.query` | 500 | the error. Outside dev its message is the `ForgeError`'s message, or `Server error (request <id>)` for everything else |

A failed `ctx.query` therefore gives a 500 page even when the function threw a `ForgeError`. To give it a better status, catch it and rethrow a response:

```tsx
import { data, type LoaderArgs } from "@archlast/forge-framework";
import { isForgeError } from "@archlast/forge-runtime";
import { api } from "../../forge/_generated/api";

export const loader = async ({ params, ctx }: LoaderArgs) => {
  try {
    await ctx.query(api.posts.get, { slug: params.slug! });
  } catch (e) {
    if (isForgeError(e)) throw data(e.message, { status: 404 });
    throw e;
  }
  return null;
};
```

Use `isForgeError` here and not `instanceof ForgeError`. In a loader on the server the error is created by the engine's copy of the class, which is not the one your route imports, so `instanceof` is false there. In the browser and in event handlers `instanceof` works. `isForgeError` checks the error's name and works in both.

An `ErrorBoundary` export in a route replaces the built-in page:

```tsx
import { isRouteErrorResponse, useRouteError } from "@archlast/forge-framework";

export function ErrorBoundary() {
  const error = useRouteError();
  if (isRouteErrorResponse(error)) return <p>{error.status}: {String(error.data)}</p>;
  return <p>{(error as Error).message}</p>;
}
```

The page response carries `x-request-id`. If a page fails to render at all outside dev, the visitor gets a plain `Server error (request <id>)` with status 500, and the stack is in the server log under that id.

## Timeouts and overload

- **Soft timeout, in the function runtime.** A query or mutation gets `FUNCTION_TIMEOUT_MS` (10 s by default), an action `ACTION_TIMEOUT_MS` (10 minutes). When it passes, the caller gets `TIMEOUT` (408). A mutation's transaction rolls back, and the handler can't use the database after that. The handler's code may still be running; don't depend on it stopping.
- **Hard deadline, in the server.** The timeout plus 5 seconds. A process that misses it is presumed stuck in synchronous code (`while (true) {}`) and is killed. With separate runtime processes the call gets `TIMEOUT` and the process is restarted alone; with `RUNTIME_MODE=inline` (the production default) the whole server is killed and your supervisor must restart it. See [Limits](limits.html).
- **Overload.** The function runtime is single-threaded, so past its capacity, calls queue. More than `MAX_PENDING_CALLS` (1000) waiting calls are refused at once with `503 SERVICE_UNAVAILABLE` and `Retry-After: 1`, instead of queueing until they time out. A refused call hasn't run, so it is safe to retry.
- **A timeout isn't a retry signal for mutations.** The transaction was rolled back, so repeating it is safe, but if it timed out because it is too slow, it will do it again. Find the slow query (the **Metrics** page has p50 and p95 per function) before adding retries.

Scheduled functions don't have a caller: when one fails, the job is marked `failed` with the message, and you can look at it on the dashboard's **Scheduled** page or retry it. See [Scheduling](scheduling.html).

See [Limits](limits.html) for every limit and what happens when it is hit, and [Troubleshooting](troubleshooting.html) for common messages.
