# Caching

Query results are cached, so a query that many clients ask for runs once instead of once per client. Nothing to configure and nothing to change in your functions.

A cached result is never stale. It is evicted the moment a mutation commits a write that touches anything the query read (the same [topics](reactivity.html) that drive live updates), and a query that is woken by a write never reuses a result computed before that write.

## What is cached

- **Key:** the function, its arguments, and for queries that read `ctx.auth`, the signed-in user. Each user gets their own entry, and a signed-out caller gets another. The first time a query reads `ctx.auth` it runs uncached; from then on it is keyed by user. A revoked or expired session stops matching straight away, because who is calling is resolved on every request.
- **Shared runs:** if identical calls arrive while one is already running, they share its result instead of each running the function. A call that arrives after a write the running one overlapped runs again.
- **Not cached:** mutations and actions, failed queries, and results larger than a quarter of `CACHE_MAX_MB`.
- **Reloads:** changing your `forge/` code (or reloading the runtime) empties the cache, since the old code's results are no longer right.

Queries are expected to depend only on their arguments, the caller and the database. A query that also reads the clock or calls something external can serve a result up to `CACHE_TTL_MS` old.

## Where it lives

In memory by default, limited by `CACHE_MAX_MB`; the least recently used entries go first. With `REDIS_URL` the cache is shared by every server, and writes on any server evict entries on all of them.

| Setting | Default | |
|---|---|---|
| `CACHE_TTL_MS` | `60000` | longest an entry lives. `0` turns the cache off. |
| `CACHE_MAX_MB` | `64` | in-process memory limit |

## Measuring it

The dashboard has a **Cache** page: hit rate, entries and memory, hits and function runs over time (across all servers), and for each function its hits, shared runs, runs, average time for each, and an estimate of the time saved. Admins can clear the cache there; that is recorded in the audit log. The Overview page shows the hit rate.

The same numbers are on `/metrics`:

| Metric | |
|---|---|
| `forge_cache_hits_total{function}` | calls answered from the cache |
| `forge_cache_misses_total{function}` | calls that ran the function |
| `forge_cache_coalesced_total{function}` | calls that shared a run already in flight |
| `forge_cache_skipped_total{function}` | runs whose result couldn't be kept |
| `forge_cache_invalidated_entries_total` | entries evicted by writes |
| `forge_cache_evictions_total` | entries evicted to stay within memory |
| `forge_cache_entries`, `forge_cache_bytes` | what is cached now (in-process cache only) |

The hit rate is `(hits + coalesced) / (hits + coalesced + misses)`. Calls answered from the cache don't appear in the function call logs or `forge_function_*` metrics, since no function ran.
