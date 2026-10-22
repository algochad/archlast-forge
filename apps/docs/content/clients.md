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
