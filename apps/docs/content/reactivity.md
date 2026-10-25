# Reactivity

A client that subscribes to a query keeps getting its result for as long as it stays subscribed. You don't write any invalidation code: the engine records what each query read, and a write that touches any of it runs the query again. This page explains how that works, what makes a query re-run and what doesn't, and how to find out why a query updates too often or not at all.

## The pieces

1. **Subscribe.** The client sends `subscribe` over the WebSocket. The server runs the query and sends the result.
2. **Record the read set.** While the query ran, every database read added a *topic* to its read set. The server listens for those topics.
3. **Write.** A mutation records a topic for every write it makes. When the mutation commits, it publishes them. A mutation that fails or rolls back publishes nothing.
4. **Re-run.** A subscription whose topics were published runs its query again, after a short debounce.
5. **Send if changed.** The server compares the new result with the last one it sent. Only a different result goes to the client.

The read set is recorded again on every run, so a query whose reads depend on its data (it follows an id it just read) always listens for the right things.

## Topics

| What the query reads | Topic |
|---|---|
| a full scan, or any query without an equality prefix | `lists` (the table name) |
| `withIndex("by_list", q => q.eq("listId", x))` | `todos:by_list:["x"]` |
| `withIndex("by_list_done", q => q.eq("listId", x).eq("done", false))` | `todos:by_list_done:["x",false]` |
| a range or a page under an equality prefix | the equality prefix, e.g. `todos:by_list:["x"]` |
| `ctx.db.get(id)` | `todos:by_id:["todos:…"]` |
| a search | the table name |
| `include` of a field | `by_id` of each document it follows |
| `include` of a reverse relation (`count: true` or a list) | the index prefix of each parent, e.g. `todos:by_list:["lists:…"]` |

These are real values. Subscribing to `byList`, `open`, `get` and a page of the `todos` table from the [Queries](queries.html) examples gives:

```
todos:lists      ["lists"]
todos:byList     ["todos:by_list:[\"lists:f11a…\"]"]
todos:open       ["todos:by_list_done:[\"lists:f11a…\",false]"]
todos:get        ["todos:by_id:[\"todos:679e…\"]"]
todos:page       ["todos:by_list:[\"lists:f11a…\"]"]
```

A write publishes topics for the old and the new version of the document. Patching a todo from `done: false` to `done: true` publishes:

- the table, `todos`
- `todos:by_id:[<id>]`
- for every index, every prefix of its fields, with the old and the new values: `todos:by_list:[<list>]`, `todos:by_list_done:[<list>]`, `todos:by_list_done:[<list>,false]` and `todos:by_list_done:[<list>,true]`

That is why a query on `by_list_done` with `done = false` sees the todo leave, and one with `done = true` sees it arrive. An insert publishes the new document's topics and a delete the old ones.

### What re-runs a query, and what doesn't

A query re-runs when a published topic is in its read set. So:

- **A write in another list doesn't wake a query on `by_list` for this list.** Index-prefix topics are what make this cheap.
- **A query with no index prefix wakes on every write to its table.** `ctx.db.query("todos").collect()` listens for `todos`, which every insert, patch and delete of any todo publishes. Add `withIndex` with an `eq` to narrow it.
- **A range or page is tracked at the equality prefix, not the range.** `withIndex("by_time", q => q.gte("at", start))` has no equality, so it listens for the whole table. `q.eq("userId", u).gte("at", start)` listens for `events:by_user_time:["u"]`, so a write to a document outside the range but inside the prefix re-runs the query too. The result is correct and, if unchanged, never sent. Coarser tracking can cost a re-run; it can't miss an update.
- **`take(10)` still listens for the whole prefix.** A write that lands beyond the tenth document re-runs the query.
- **`filter` doesn't narrow topics.** It runs on the scanned range, so the query wakes for any change in that range, including documents the filter skips.
- **A write that changes nothing still re-runs subscribers.** `patch(id, { done: false })` on a document that already has `done: false` publishes topics, the query runs again, and the unchanged result is dropped. Nothing reaches the client.
- **A re-run that gives the same result sends nothing.** The comparison is on the serialized result.
- **Reads of anything but the database aren't tracked.** `Date.now()`, `fetch`, `Math.random()` and environment variables aren't topics. A query that returns `Date.now()` changes only when something it read changes.
- **Actions aren't reactive.** `ctx.runQuery` inside an action returns a value once; it doesn't subscribe.

Within one run, the query reads from a single snapshot. Two different queries don't share one: a client showing two subscriptions can briefly see one updated and the other not.

## Timing

The server debounces by 50 ms per subscription: the first published topic starts a timer, topics that arrive during it are folded in, and the query runs once when it fires. A burst of writes costs one re-run, not one per write. The update reaches the client after the debounce plus the query's own run time.

There is no per-client delta. A changed result is sent whole, so a query that returns a large array sends the whole array each time anything in it changes. See [Performance](#performance).

## The WebSocket protocol

The client opens one WebSocket at `/rpc` and multiplexes every live query over it. Messages are JSON.

| Direction | Message |
|---|---|
| client to server | `{ "type": "subscribe", "id": "1", "name": "todos:byList", "args": { … } }` |
| client to server | `{ "type": "unsubscribe", "id": "1" }` |
| server to client | `{ "type": "data", "id": "1", "data": { "value": … } }` |
| server to client | `{ "type": "data", "id": "1", "data": { "error": "message", "data": …, "requestId": "…" } }` |
| server to client | `{ "type": "error", "id": "1", "error": { "message", "code", "requestId" } }` |

- **The first message is the current result.** It arrives once the first run finishes, whether the result is empty or not. Every later `data` message is a new, different result for the same `id`.
- **A failing query is a `data` message with an `error`.** The subscription stays open. If the query succeeds on a later run, a `value` replaces the error. `data` holds a `ForgeError`'s structured data, and `requestId` is what you search for in the logs. See [Errors](errors.html).
- **An `error` message ends the subscription.** It means the subscription itself was refused: the name isn't a public query (`NOT_FOUND`), the `id` is already in use (`BAD_REQUEST`), or the connection has too many subscriptions (`TOO_MANY_REQUESTS`).
- **`id` is a string of up to 64 characters** chosen by the client. A message that isn't JSON, has no string `id`, or has an unknown `type` closes the socket (1003 or 1008).
- **Authentication happens at the handshake.** The socket carries the `cookie` and `authorization` headers of the upgrade request. The caller is resolved again on every run, so a revoked session stops matching on the next re-run. The client library reconnects when the session changes so a new sign-in is picked up.

You rarely write this by hand. `ArchlastForgeClient.watch` and the React, Vue and Svelte hooks do it for you (see [Clients](clients.html)); identical `(function, args)` pairs in one client share a single server subscription, and a new listener immediately gets the last result.

## Reconnects

The socket can drop: a deploy, a proxy timeout, a laptop waking up. The client reconnects with jittered exponential backoff (about 250 ms, doubling up to 10 s), then sends every subscription again. Each first message is a fresh result, so a reconnect refetches and the UI converges on the current state without extra code. Publishing is fire-and-forget, so there's no replay of what was missed.

A server that shuts down gracefully closes sockets with code 1012 so clients reconnect (to another server, behind a load balancer). In development, a code change restarts the function runtime without dropping sockets and re-runs every subscription.

## Pagination windows

`usePaginatedQuery` doesn't stack pages. It keeps **one live window**: the query for the first `n` items, with `paginationOpts: { numItems: n, cursor: null }`. `loadMore(m)` widens the window to `n + m`, which is a new subscription with the same prefix topic. Because every loaded item is part of one query, nothing is duplicated or skipped when items are inserted or removed, and every loaded item stays live.

The cost is that each change re-runs and re-sends the whole window. Keep windows to what a screen shows (20 to 100 items) and use `loadMore` for the rest rather than loading thousands. For plain, non-live paging, call the query with a `cursor` yourself (see [Queries](queries.html#pagination)); each page is then its own subscription or request.

## Search and joins

- **Search** (`withSearchIndex`) listens for the whole table, because any write may change the ranking. A hot table with a live search re-runs it often; the result is only sent when it changes.
- **`include`** adds the joined documents to the read set: `by_id` for each followed field, and the child index prefix for each reverse relation. A `count: true` include for 10 parents listens for 10 prefixes, so a new todo in one list re-runs the query but only that list's count changes. See [Joins](queries.html#joins).

## Several servers

With one server, topics are delivered in memory. With `REPLICAS > 1` you need Postgres and `REDIS_URL`, and the bus becomes Redis pub/sub:

- A server subscribes to a Redis channel per topic its subscriptions need (`archlast-forge:t:<topic>`), so it receives only topics somebody connected to it cares about.
- When the [query cache](caching.html) is on, every server also listens on one all-topics channel to evict cache entries. That channel is only published when `CACHE_TTL_MS` is above `0`.
- A mutation publishes after it commits, from the server that ran it. Every server filters locally.
- **Delivery isn't guaranteed.** Pub/sub drops messages while a server is disconnected from Redis, and a failed publish is logged (`publish failed`) and not retried. A subscriber that missed a topic stays out of date until the next relevant write or until its client reconnects. If Redis can be down, expect that.
- A subscription is bound to the server its WebSocket connected to. Load balance WebSockets across servers freely; they don't need sticky sessions.

Startup refuses `REPLICAS > 1` without Redis and Postgres. See [Deployment](deployment.html).

## Limits and slow clients

| Limit | Default | When it's hit |
|---|---|---|
| Subscriptions per connection (`MAX_SUBSCRIPTIONS_PER_CONNECTION`) | 200 | the extra `subscribe` gets an `error` message |
| Result size (`MAX_RESULT_BYTES`) | 8 MiB | the query fails with an error update |
| WebSocket message size (`MAX_REQUEST_BYTES`) | 8 MiB | rejected |
| Requests per IP (`RATE_LIMIT_PER_MINUTE`) | 1200 | counted per WebSocket message (every `subscribe` and `unsubscribe`) as well as per HTTP call; over the limit, the socket closes with 1008 |
| Unsent data per socket | 4 MiB | the server closes the socket; the client reconnects and refetches |

A client that can't keep up isn't buffered without bound. It is disconnected and reconnects with a fresh state. See [Limits](limits.html) and [Configuration](configuration.html).

## Performance

- **Index every live query.** A query with `withIndex(…eq…)` listens for a narrow prefix and scans a small range. One without listens for the table and re-runs on every write to it.
- **Keep results small.** Each change re-sends the full result. Return the fields a screen shows, paginate, and use `take`.
- **Share work by sharing arguments.** With the query cache on, identical `(function, args)` subscriptions run once per change and share the result. A query that takes the viewer's id as an argument can't be shared. A query that reads `ctx.auth` is cached per user. See [Caching](caching.html).
- **Don't put changing noise in the result.** A `lastSeen: Date.now()` in the return value makes every re-run a different result, so every re-run is sent.
- **Split hot and cold data.** A single query that joins a rarely-changing list with a counter that changes every second re-runs every second. Two queries re-run independently.
- **Debounce your own writes.** The server batches re-runs per subscription, but a client that writes on every keystroke still produces a commit per keystroke.

## Debugging

**A query never updates.**

1. Open the dashboard, **Settings**, **Live subscriptions on this server**. Find your query and look at its topics. The write you expect must publish one of them. If the list shows `todos:by_list:["lists:a"]` and your mutation edits a todo of `lists:b`, it's working as designed.
2. Check that the mutation commits. A thrown error rolls the whole mutation back and publishes nothing.
3. Check that the read is a database read. A value that comes from `Date.now()`, `fetch`, an environment variable or a module-level variable isn't tracked.
4. Check that the write goes through the engine. Rows changed with a separate database client, or written by `archlast-forge import` while no server is running, publish nothing.
5. With several servers, check `REDIS_URL` on each of them and the logs for `publish failed`.
6. In the browser, check that the hook isn't passed `"skip"` and that you haven't built a one-off `client.query` call where you meant a subscription.
7. A query that threw sends an error update and then waits for the next change. Look for the error (the hook throws it to the nearest error boundary) and the `requestId` in the **Logs** page.

**A query updates too often.**

1. Look at its topics in **Live subscriptions**. A bare table name means a full scan: add an index with an `eq`.
2. Count runs in the **Cache** page and on `/metrics` (`forge_cache_hits_total`, `forge_cache_misses_total` and `forge_function_calls_total` per function). Hits plus misses is how many times subscriptions asked for the query.
3. Check the result for noise (timestamps, random order, a counter you don't show). The comparison is on the whole serialized result.
4. Check for a writer you forgot: a cron, a scheduled function or a client that writes in a loop. The **Logs** page filters by function and shows the callers.

**A query returns old data.** Results are never stale with respect to committed writes, but they can be stale with respect to things that aren't tracked. Check for `Date.now()` in a cached query (see [Caching](caching.html#gotchas)).
