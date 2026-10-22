# Limits and security

| Limit | Default | What happens |
|---|---|---|
| Query and mutation time | 10 s | `TIMEOUT`; a mutation rolls back, and later database use by its handler is refused |
| Action time | 10 min | `TIMEOUT` |
| A call that blocks the process | timeout + 5 s | the function-runtime process is killed and restarted; other calls are unaffected after the restart |
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
