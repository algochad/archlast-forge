# Limits and security

| Limit | Default | What happens |
|---|---|---|
| Query and mutation time | 10 s | `TIMEOUT`; a mutation rolls back, and later database use by its handler is refused |
| Action time | 10 min | `TIMEOUT` |
| A call that blocks the process | timeout + 5 s | `RUNTIME_MODE=process`: the function-runtime process is killed and restarted, but only if it has answered nothing since the call went in (one that is merely behind keeps its work). `inline` (the production default): a watchdog thread kills the whole server process, so run it under something that restarts it (the engine container does) |
| Calls waiting for the function runtime | 1000 (`MAX_PENDING_CALLS`) | the call is refused at once with `503` and `Retry-After: 1`, instead of queueing until it times out |
| Result size | 8 MiB | the call fails |
| Document size | 1 MiB | the write fails |
| Request body / WebSocket message | 8 MiB | rejected |
| Requests per IP | 1200 per minute | `429` with `Retry-After`; WebSocket closed with 1008 |
| Subscriptions per connection | 200 | the extra subscription fails |
| Slow WebSocket clients | 4 MiB buffered | disconnected; they reconnect and refetch |

## Security checklist for production

- Set `BETTER_AUTH_SECRET` and an `https://` `BETTER_AUTH_URL`. Startup enforces both.
- Keep the dashboard off, or behind your VPN, unless you need it. Use admin accounts rather than sharing `ADMIN_KEY`.
- Make anything clients shouldn't call an `internal*` function.
- Validate everything with `args`. Authorize in the function, with `ctx.auth.getUserIdentity()`.
- Set `TRUST_PROXY=1` only behind a proxy you control, or clients can spoof their IP.
- Server dependencies don't run install scripts unless listed in `trustedDependencies`.

## Custom functions in the dashboard

The dashboard can run code its owner types in (see [Dashboard](dashboard.html#running-your-own-code)). That code runs in the function runtime with the server's environment and network access, which is far more than an admin can otherwise do. It is limited to the `owner` role, off in production unless `ALLOW_CUSTOM_FUNCTIONS=on`, subject to the same time and result limits as any query or mutation, and audited. Leave it off on deployments where owner sessions are shared widely, and keep `DASHBOARD` off on a server you don't need to inspect.
