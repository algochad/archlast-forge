# Clients: React, Vue, Svelte

Every client is a thin layer over `ArchlastForgeClient` from `@archlast/forge-client`. It talks to the engine in two ways: **one HTTP request per call** (`POST /rpc/<name>`) for queries, mutations and actions, and **one WebSocket** (`/rpc`) for live queries. The framework packages add hooks or stores on top.

| Package | Gives you |
|---|---|
| `@archlast/forge-client` | `ArchlastForgeClient`, `ForgeError`, `queryKey` and `syncQuery` (TanStack Query), `windowArgs` |
| `@archlast/forge-react` | The client re-exported, `ArchlastForgeProvider`, `useQuery`, `usePaginatedQuery`, `useMutation`, `useAction`, `useUploadFile`, `useAuth`, `useSession`, `useArchlastForge` |
| `@archlast/forge-vue` | `archlastForge` plugin, `useQuery`, `useMutation`, `useAction`, `useSession`, `useArchlastForge` |
| `@archlast/forge-svelte` | `query` and `session` stores |

References come from the generated `api` (`import { api } from "../forge/_generated/api"`). The types only accept **public** functions: an `internal*` reference is a type error, and the server answers 404 for it anyway.

## The core client

```ts
import { ArchlastForgeClient } from "@archlast/forge-client";
import { api } from "../forge/_generated/api";

const client = new ArchlastForgeClient({ url: "https://app.example.com" });

const lists = await client.query(api.lists.all);                       // one-off read
const id = await client.mutation(api.lists.create, { name: "Groceries" });
await client.action(api.billing.sync, { customerId });                  // actions work the same way

const stop = client.watch(api.lists.all, {}, (update) => {              // live query
  if ("value" in update) console.log(update.value);
  else console.error(update.error, update.requestId);
});
stop();
```

### Constructor

`new ArchlastForgeClient(options?)`

| Option | Meaning |
|---|---|
| `url` | The server's origin. Defaults to `location.origin`, so a page served by the engine (or behind a dev proxy that forwards `/rpc` and `/api/auth`) needs no option. A trailing slash is removed. Required outside a browser. |
| `WebSocket` | A WebSocket constructor to use instead of the global one. See [outside the browser](#using-the-client-outside-the-browser). |

Nothing connects until you use it: creating a client does no network I/O, which makes it safe to build on the server.

### Methods

| Method | What it does |
|---|---|
| `query(ref, args?)` | Runs a query once over HTTP and resolves to its result. It isn't live. |
| `mutation(ref, args?)` | Runs a mutation. Resolves to its return value. |
| `action(ref, args?)` | Runs an action. |
| `watch(ref, args, listener)` | Subscribes to a live query. Calls `listener` with a `QueryUpdate` now (if a result is already known) and after every change. Returns an unsubscribe function. |
| `uploadFile(generateUploadUrl, file)` | Uploads a `Blob` or `File` through your upload mutation and resolves to the new `_storage` id. See [storage](storage.html). |
| `auth` | The [Better Auth](auth.html) client for this server. |
| `onSessionChange(listener)` | Called with the user (or `null`) whenever the browser learns the session. Returns an unsubscribe function. |
| `reconnect()` | Closes the WebSocket and opens a new one at once, re-subscribing everything. |
| `close()` | Stops every watch and closes the socket for good. The client can't be reopened; make a new one. HTTP calls still work. |

Arguments may be omitted when the function takes none. A `QueryUpdate` is `{ value }` or `{ error, data?, requestId? }`.

### Watching

`watch` is what the hooks use.

- **Identical subscriptions are shared.** Two `watch` calls with the same function and arguments (compared as `JSON.stringify`, so key order matters) use one server subscription, and a late listener gets the latest value at once. The server subscription ends when the last listener leaves.
- **The first message is the current result**; after that, one message after each write that affects the query. See [reactivity](reactivity.html).
- **A failing query is an update, not an exception**: `{ error, data?, requestId? }` is delivered to the listener, and the subscription stays active. A later successful run delivers a `value` again.
- **A refused subscription** (an unknown query, or more than `MAX_SUBSCRIPTIONS_PER_CONNECTION`, 200 by default) delivers one error update and ends. It is not retried; unsubscribe and watch again.
- **Arguments are validated on the server** with the same rules as a call.

### Connection behavior

- The socket opens when the first subscription starts and stays open while subscriptions exist.
- **A dropped connection** is retried with exponential backoff and jitter: about 0.25 s, 0.5 s, 1 s, 2 s, up to a ceiling of 10 s, each randomized between 50% and 100% of that value. A successful connection resets the count. (Measured against a closed port: attempts at 0, 0.2, 0.5, 1.5, 3.4 and 5.7 seconds.)
- **After reconnecting**, every active subscription is sent again, and the first message of each is a fresh result. A reconnect therefore refetches; you never see stale data resume silently. While disconnected, watchers keep their last value.
- **A restarting server** closes sockets with code 1012; the client reconnects, behind a load balancer possibly to another server.
- **A rate-limited connection** is closed with code 1008 (`RATE_LIMIT_PER_MINUTE` counts WebSocket messages too) and reconnects with the usual backoff.
- There is no connection-state API and no queue for offline calls. A mutation made while offline fails with the browser's network error (`TypeError`) and isn't retried. If you need offline support, build it above the client.
- **Signing in or out** reconnects the socket by itself, because cookies travel only on the handshake. See [authentication](auth.html#live-queries-and-sign-in).

### Error handling

A failed call rejects. What you get depends on who failed:

```ts
import { ForgeError } from "@archlast/forge-client";

try {
  await client.mutation(api.messages.send, { body });
} catch (e) {
  if (e instanceof ForgeError) {
    // the function threw new ForgeError(data): e.data is exactly that value, e.message is data (or JSON of it)
    showToast(String(e.data));
  } else {
    // validation error, server error, rate limit or network failure
    console.error((e as Error).message, (e as { code?: string; requestId?: string }).requestId);
  }
}
```

| Cause | You get | `code` | HTTP status |
|---|---|---|---|
| The function threw `ForgeError` | `ForgeError`, `data` is your payload | `BAD_REQUEST` | 400 |
| Arguments failed validation | `Error`: `args.body must be a string, got 5` | `BAD_REQUEST` | 400 |
| Unknown function (or an `internal*` one) | `Error`: `No function "x:y"` | `NOT_FOUND` | 404 |
| The function timed out | `Error` | `TIMEOUT` | 408 |
| Any other error in the function | `Error` with a generic message outside dev: `Server error (request <id>)`. The real error is in the server log under that id | `INTERNAL_SERVER_ERROR` | 500 |
| The runtime is overloaded | `Error` | `SERVICE_UNAVAILABLE` | 503 |
| Rate limited | `Error("Too many requests")` with `code` `TOO_MANY_REQUESTS` and `retryAfter` (seconds, from `Retry-After`) | | 429 |
| Server unreachable | The browser's `TypeError` (`Failed to fetch`) | none | none |

Every error from the server carries `requestId`; log it or show it to users, since it's the key to the server's log (and the dashboard's [Logs](dashboard.html#logs)). Failures of live queries arrive as `{ error, data?, requestId }` updates; the hooks turn them into the same `ForgeError`/`Error` shapes. See [errors](errors.html) for how functions raise them.

### Using the client outside the browser

The client needs only `fetch` and a `WebSocket`. Bun, Deno and Node 22+ have both. Where there's no global `WebSocket`, pass one in (for example the `ws` package):

```ts
import WebSocket from "ws";
const client = new ArchlastForgeClient({ url: "http://localhost:3000", WebSocket: WebSocket as unknown as typeof globalThis.WebSocket });
```

Two things to know:

1. **There is no cookie jar.** In a browser, `fetch` and the WebSocket send the session cookie for you. Elsewhere nothing does, so `client.query/mutation/action` run **anonymously**. For a signed-in service account, either call `/rpc/<name>` with your own `fetch` and a `Cookie` header, or use the `bearer()` plugin and send `Authorization: Bearer …` yourself (see [authentication](auth.html#bearer-tokens-for-non-browser-callers)). `client.auth`'s session store also stays "pending" outside a browser.
2. **Live queries as a user** work if the WebSocket sends the cookie on its handshake. Bun's WebSocket accepts a `headers` option:

```ts
const cookie = "better-auth.session_token=…"; // from a sign-in response's set-cookie

class AuthedSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, { headers: { cookie } } as never); // Bun; the `ws` package takes the same option
  }
}

const client = new ArchlastForgeClient({ url: "http://localhost:3000", WebSocket: AuthedSocket });
const stop = client.watch(api.me.whoami, {}, (u) => console.log(u)); // { value: { userId, email, … } }
```

The same works for React Native and other runtimes that have `fetch` and `WebSocket`: pass `{ url }`, since there is no `location`.

## React

```tsx
import { ArchlastForgeClient, ArchlastForgeProvider } from "@archlast/forge-react";

const client = new ArchlastForgeClient(); // same origin; or { url: "https://api.example.com" }

createRoot(document.getElementById("root")!).render(
  <ArchlastForgeProvider client={client}>
    <App />
  </ArchlastForgeProvider>,
);
```

In a [full-stack app](framework.html) the provider is already in place, along with server-rendered data; just use the hooks. Create a client in one place and share it. `ArchlastForgeProvider` also provides a TanStack `QueryClient` (pass your own with `queryClient`), and `useArchlastForge()` returns the client from context.

### `useQuery`

```tsx
const todos = useQuery(api.todos.listByList, { listId });            // undefined until loaded, then live
const none = useQuery(api.todos.count);                              // no arguments
const maybe = useQuery(api.todos.listByList, listId ? { listId } : "skip");
```

- It returns `undefined` until the first result, then the value, re-rendering on every change. Check `=== undefined` for loading: a query can legitimately return `null` or `[]`.
- **`"skip"`** as the arguments doesn't subscribe and returns `undefined`. Use it for queries that depend on something you don't have yet.
- **New arguments** (compared by value) subscribe to the new query and release the old one.
- **Errors throw** to the nearest error boundary: a `ForgeError` when the function threw one, otherwise an `Error` with `requestId`. Wrap pages in a boundary, or use the framework's `ErrorBoundary` route export.
- Unmounting releases the subscription.

### `usePaginatedQuery`

For a query that takes `paginationOpts` and returns `ctx.db.query(...).paginate(paginationOpts)`:

```tsx
const { results, status, isLoading, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 30 });
// status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
{status === "CanLoadMore" && <button onClick={() => loadMore(30)}>More</button>}
```

`loadMore(n)` doesn't fetch another page: it **widens one live window** by `n` items, so every loaded item stays live and nothing is skipped or duplicated when items are inserted or removed. Cost grows with the window, so don't load thousands. New arguments reset the window to `initialNumItems`; `"skip"` is accepted in place of the arguments. While a wider window loads, the previous results stay visible.

### `useMutation` and optimistic updates

```tsx
const add = useMutation(api.todos.add);
await add({ listId, title: "milk" });                     // resolves to the mutation's result, rejects like client.mutation

const addOptimistic = useMutation(api.todos.add).withOptimisticUpdate((store, { listId, title }) => {
  const current = store.getQuery(api.todos.listByList, { listId });
  if (current) store.setQuery(api.todos.listByList, { listId }, [...current, { _id: "todos:optimistic" as Id<"todos">, _creationTime: Date.now(), listId, title, done: false }]);
});
```

`withOptimisticUpdate` returns a function you call like the mutation. The update changes the **local copy** of live query results right away; if the mutation fails, those copies are restored, and when the server's live result arrives it replaces your guess either way. `getQuery` and `setQuery` take the same function and arguments you pass to `useQuery`, and work on results the client already holds locally (a query you haven't loaded returns `undefined` from `getQuery`, so guard for it, as above). Paginated hooks don't offer optimistic updates. The `Id` type comes from `../forge/_generated/dataModel`.

### `useAction`, `useUploadFile`

```tsx
const sync = useAction(api.billing.sync);            // (args) => Promise<result>
const upload = useUploadFile(api.files.generateUploadUrl);
const storageId = await upload(file);                // PUTs to storage, resolves to the _storage id
```

### `useAuth`, `useSession`

```tsx
const auth = useAuth();                  // the Better Auth client: signIn.email, signUp.email, signOut, ...
const { data, isPending } = useSession(); // data: { user: { id, email, name, … }, session } | null
```

`useSession` is `isPending: true` on the server and during hydration, then fills in. Signing in or out reconnects the live-query socket. See [authentication](auth.html#in-the-browser).

### A complete React example

```tsx
import { ArchlastForgeClient, ArchlastForgeProvider, ForgeError, useAuth, useMutation, usePaginatedQuery, useSession } from "@archlast/forge-react";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { api } from "../forge/_generated/api";

const client = new ArchlastForgeClient();

function SignIn() {
  const auth = useAuth();
  const [error, setError] = useState<string>();
  return (
    <form
      onSubmit={async (e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const { error } = await auth.signIn.email({ email: String(form.get("email")), password: String(form.get("password")) });
        setError(error?.message);
      }}
    >
      <input name="email" type="email" />
      <input name="password" type="password" />
      <button>Sign in</button>
      {error && <p role="alert">{error}</p>}
    </form>
  );
}

function Messages() {
  const { results, status, loadMore } = usePaginatedQuery(api.messages.list, {}, { initialNumItems: 20 });
  const send = useMutation(api.messages.send);
  const [body, setBody] = useState("");
  const [error, setError] = useState<string>();
  return (
    <>
      <ul>{results.map((m) => <li key={m._id}>{m.authorName}: {m.body}</li>)}</ul>
      {status === "CanLoadMore" && <button onClick={() => loadMore(20)}>More</button>}
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            await send({ body });
            setBody("");
          } catch (err) {
            setError(err instanceof ForgeError ? String(err.data) : "Couldn't send that");
          }
        }}
      >
        <input value={body} onChange={(e) => setBody(e.target.value)} />
        <button>Send</button>
        {error}
      </form>
    </>
  );
}

function App() {
  const { data, isPending } = useSession();
  if (isPending) return <p>Loading…</p>;
  return data ? <Messages /> : <SignIn />;
}

createRoot(document.getElementById("root")!).render(
  <ArchlastForgeProvider client={client}>
    <App />
  </ArchlastForgeProvider>,
);
```

### Server rendering

A [full-stack app](framework.html) renders pages on the server. Its route `loader`s run queries with `ctx.query(api.x.y, args)`, which keeps the result in the page's live cache; a component's `useQuery(api.x.y, args)` with the same function and arguments has its data on the first render, in the server's HTML, and stays live afterwards. `useSession()` is pending in the server HTML; use `useViewer()` from `@archlast/forge-framework` when the HTML must already know who is signed in.

Without the framework there is no server rendering: `useQuery` returns `undefined` on the server, because subscriptions start in effects. If you render React on a server yourself, pass an explicit `url` to the client there (there is no `location`), and treat `undefined` as "loading".

### TanStack Query

Live results are stored in a TanStack `QueryClient` under a key from `queryKey(ref, args)` (`["archlast-forge", "<module>:<function>", args]`). That makes the devtools work and lets you read results outside hooks:

```ts
import { queryKey } from "@archlast/forge-client";
import { useQueryClient } from "@tanstack/react-query";

const queryClient = useQueryClient();
const todos = queryClient.getQueryData(queryKey(api.todos.listByList, { listId }));
```

`useQuery` never makes TanStack fetch: results arrive over the subscription. Don't also run `useQuery` from `@tanstack/react-query` against the same key. To keep a `QueryClient` in sync outside the React hooks, `syncQuery(queryClient, client, ref, args)` subscribes and writes updates (errors included) into it, and returns the unsubscribe function.

## Vue

```ts
// main.ts
import { ArchlastForgeClient, archlastForge } from "@archlast/forge-vue";
createApp(App).use(archlastForge(new ArchlastForgeClient())).mount("#app");
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import { ForgeError, useMutation, useQuery, useSession } from "@archlast/forge-vue";
import { api } from "../forge/_generated/api";

const session = useSession(); // a ref: session.value.data?.user
const { data: messages, error, isLoading } = useQuery(api.messages.recent);
const send = useMutation(api.messages.send);
const body = ref("");
const failure = ref<string>();

async function submit() {
  failure.value = undefined;
  try {
    await send({ body: body.value });
    body.value = "";
  } catch (e) {
    failure.value = e instanceof ForgeError ? String(e.data) : "Couldn't send that";
  }
}

// args can be a getter: it re-subscribes when what it returns changes, and "skip" pauses it
const term = ref("");
const { data: found } = useQuery(api.messages.search, () => (term.value ? { text: term.value } : "skip"));
</script>

<template>
  <p v-if="error">{{ error.message }}</p>
  <p v-else-if="isLoading">Loading…</p>
  <ul v-else>
    <li v-for="m in messages" :key="m._id">{{ m.authorName }}: {{ m.body }}</li>
  </ul>
  <form @submit.prevent="submit"><input v-model="body" /><button>Send</button></form>
</template>
```

- `useQuery(ref, args?)` returns `{ data, error, isLoading }`. `data`, `error` and `isLoading` are refs (`isLoading` is `true` until the first result or error; templates unwrap it, scripts read `.value`). On `0.1.0` `isLoading` was a function you called, `isLoading()`. `args` can be a plain object, a ref or a getter, or `"skip"`. It re-subscribes when the arguments change and stops when the component or effect scope is disposed.
- A failing query sets `error` and keeps the last `data`; a later good result clears `error`.
- `useMutation(ref)` and `useAction(ref)` return plain functions. There are no optimistic updates, pagination hook or upload hook in the Vue package: for those, call `useArchlastForge()` for the client and use `client.uploadFile(...)`, or build a window with `windowArgs` from `@archlast/forge-client`.
- Auth: `useSession()` is a ref of Better Auth's session state, and `useArchlastForge().auth` is the Better Auth client (`.signIn.email(...)`).
- `useArchlastForge()` throws `Install the plugin first: app.use(archlastForge(client))` when the plugin is missing.

## Svelte

```svelte
<script lang="ts">
  import { ArchlastForgeClient, query, session } from "@archlast/forge-svelte";
  import { api } from "../forge/_generated/api";

  const client = new ArchlastForgeClient();
  const messages = query(client, api.messages.recent); // $messages.data, $messages.error, $messages.isLoading
  const me = session(client);                          // $me.data?.user
  let body = "";

  async function send() {
    await client.mutation(api.messages.send, { body });
    body = "";
  }
</script>

{#if $messages.error}<p>{$messages.error.message}</p>{/if}
{#each $messages.data ?? [] as m (m._id)}<li>{m.authorName}: {m.body}</li>{/each}
<form on:submit|preventDefault={send}><input bind:value={body} /><button>Send</button></form>
```

- `query(client, ref, args?)` is a store of `{ data, error, isLoading }`. The server subscription opens with the first subscriber and closes with the last, so unused stores cost nothing. Arguments are fixed for a store: for different arguments make a new store (for example inside a `$:` statement or keyed block).
- `session(client)` is a store of Better Auth's session state.
- Mutations and actions are `client.mutation(...)` and `client.action(...)`; the Svelte package has no wrappers for them, and no optimistic updates.
- The stores only use the standard store contract (`subscribe`), so they work with `$store` syntax in Svelte 4 and 5 without depending on Svelte.
- Share one client across components (create it in a module and import it).

## Calling the engine without the client

The wire protocol is plain JSON, so any language can use it.

```bash
# a mutation or action: POST, JSON arguments in the body
curl -X POST localhost:3000/rpc/todos:add -H 'content-type: application/json' -d '{"listId":"lists:…","title":"milk"}'
# a query: POST the same way, or GET with ?args=<json>
curl 'localhost:3000/rpc/todos:listByList?args=%7B%22listId%22%3A%22lists%3A%E2%80%A6%22%7D'
```

A call answers `{ "result": … }`. A failure answers `{ "error": { "message", "code", "data"?, "requestId" } }` with the matching HTTP status: 400 for bad arguments, invalid JSON or a `ForgeError` (its payload is `data`), 404 for an unknown or internal function, 405 for the wrong method (a mutation or action with `GET`), 408 for a timeout, 415 for a POST that isn't `application/json`, 429 when rate limited (a plain `{ "message" }` body with `Retry-After`), 500 for a server error (the message is generic in production; look up `requestId` in the logs), 503 when overloaded. Send the session cookie, or with the `bearer()` plugin an `authorization` header, to call as a user. Every response carries `x-request-id`, and you may send your own (1 to 64 letters, digits, `.`, `_`, `-`) to trace a call.

Live queries use a WebSocket at `/rpc` (send the same cookie on the handshake). Messages are JSON:

| Direction | Message |
|---|---|
| to server | `{ "type": "subscribe", "id": "1", "name": "todos:listByList", "args": {…} }` |
| to server | `{ "type": "unsubscribe", "id": "1" }` |
| to client | `{ "type": "data", "id": "1", "data": { "value": … } }`, or `{ "error": "…", "requestId": "…" }` in place of `value` when the query fails |
| to client | `{ "type": "error", "id": "1", "error": { "message", "code" } }` when the subscription itself is refused (unknown query, too many subscriptions); it ends there |

Ids are strings of up to 64 characters that you choose. The first `data` message is the current result, then one arrives after each write that changes it. After a dropped connection, connect again and subscribe again: the first message of each is a fresh result. The server closes sockets with code 1012 when it restarts, 1008 for a protocol violation or when rate limited, and 1003 for a message that isn't JSON.
