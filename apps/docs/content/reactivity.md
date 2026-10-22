# Reactivity

When a client subscribes to a query, the engine runs it and records what it read. Each read becomes a topic:

| Read | Topic |
|---|---|
| a full scan of `todos` | `todos` |
| `withIndex("by_list", q => q.eq("listId", x))` | `todos:by_list:["x"]` |
| a range or page under that equality | the equality prefix (`todos:by_list:["x"]`, or `todos` with none) |
| `ctx.db.get(id)` | `todos:by_id:["id"]` |
| a search | `todos` |

A mutation publishes the topics its writes touch, covering both the old and new values of every index, but only after it commits. Subscribed queries whose topics match re-run (debounced by about 50 ms). The client receives a new result only if it changed.

- **Consistency:** each query run reads one snapshot. Separate queries don't share a snapshot.
- **Multiple servers:** with `REDIS_URL`, writes on one server reach subscribers on every server. Each server subscribes only to the topics its clients need.
- **Reconnects:** pub/sub is fire-and-forget, so a client that reconnects gets fresh results for all its subscriptions.
- **Caching:** with `CACHE_TTL_MS` (on by default outside dev), results of queries that don't read `ctx.auth` are cached per (function, args) and evicted by the same topics.
