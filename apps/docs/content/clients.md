# Clients: React, Vue, Svelte

All clients share `ArchlastForgeClient` from `@archlast-forge/client`. It sends calls over HTTP (batched) and subscriptions over one WebSocket, deduplicates identical subscriptions, reconnects with backoff, and refetches after reconnecting. Clients can only call public functions: the types reject `internal` references.

## React

```tsx
import { ArchlastForgeClient, ArchlastForgeProvider, useMutation, usePaginatedQuery, useQuery } from "@archlast-forge/react";

const client = new ArchlastForgeClient(); // same origin, or { url: "https://api.example.com" }
<ArchlastForgeProvider client={client}><App /></ArchlastForgeProvider>;

const todos = useQuery(api.todos.listByList, { listId });            // undefined until loaded, then live
const maybe = useQuery(api.todos.listByList, listId ? { listId } : "skip");
const { results, status, loadMore } = usePaginatedQuery(api.todos.page, { listId }, { initialNumItems: 20 });

const add = useMutation(api.todos.add).withOptimisticUpdate((store, { listId, title }) => {
  const current = store.getQuery(api.todos.listByList, { listId });
  if (current) store.setQuery(api.todos.listByList, { listId }, [...current, { _id: "optimistic" as any, _creationTime: Date.now(), listId, title, done: false }]);
});
```

- **Optimistic updates** apply right away. They're undone if the mutation fails, and replaced by the live result either way.
- **Other hooks:** `useAction`, `useUploadFile`, `useAuth` (the Better Auth client) and `useSession`.
- **Errors:** `useQuery` throws errors to the nearest error boundary.
- **TanStack Query:** live results land in a TanStack `QueryClient`, so devtools and `queryClient.getQueryData` work.

## Vue

```ts
import { ArchlastForgeClient, archlastForge, useMutation, useQuery } from "@archlast-forge/vue";
app.use(archlastForge(new ArchlastForgeClient()));

const { data: todos, error } = useQuery(api.todos.listByList, () => ({ listId: props.listId })); // refs; re-subscribes when args change
const add = useMutation(api.todos.add);
```

## Svelte

```svelte
<script>
  import { ArchlastForgeClient, query } from "@archlast-forge/svelte";
  const client = new ArchlastForgeClient();
  const todos = query(client, api.todos.listByList, { listId });
</script>
{#each $todos.data ?? [] as todo}<li>{todo.title}</li>{/each}
```

## React Native and others

`ArchlastForgeClient` uses only `fetch` and `WebSocket`, so it works anywhere those exist. Pass `{ url }` when the backend isn't on the same origin.

## Calling the engine without the client

The wire protocol is plain JSON, so any language can use it.

```bash
# a mutation or action: POST, JSON arguments in the body
curl -X POST localhost:3000/rpc/todos:add -H 'content-type: application/json' -d '{"listId":"lists:…","title":"milk"}'
# a query: POST the same way, or GET with ?args=<json>
curl 'localhost:3000/rpc/todos:listByList?args=%7B%22listId%22%3A%22lists%3A%E2%80%A6%22%7D'
```

A call answers `{ "result": … }`. A failure answers `{ "error": { "message", "code", "data"?, "requestId" } }` with the matching HTTP status: 400 for bad arguments or a `ForgeError` (its payload is `data`), 404 for an unknown or internal function, 405 for the wrong method, 408 for a timeout, 415 for a POST that isn't `application/json`, 429 when rate limited, 500 for a server error (the message is generic in production; look up `requestId` in the logs). Send the session cookie, or an `authorization` header, to call as a user.

Live queries use a WebSocket at `/rpc` (send the same cookie on the handshake). Messages are JSON:

| Direction | Message |
|---|---|
| to server | `{ "type": "subscribe", "id": "1", "name": "todos:listByList", "args": {…} }` |
| to server | `{ "type": "unsubscribe", "id": "1" }` |
| to client | `{ "type": "data", "id": "1", "data": { "value": … } }`, or `{ "error": "…", "requestId": "…" }` when the query fails |
| to client | `{ "type": "error", "id": "1", "error": { "message", "code" } }` when the subscription itself is refused (unknown query, too many subscriptions); it ends there |

The first `data` message is the current result, then one arrives after each write that changes it. After a dropped connection, connect again and subscribe again: the first message of each is a fresh result. The server closes sockets with code 1012 when it restarts.
