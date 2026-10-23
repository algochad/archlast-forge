# Configuration

Environment variables, read at startup. Invalid or contradictory values fail fast with a message.

| Variable | Default | |
|---|---|---|
| `PORT`, `HOST` | `3000`, `0.0.0.0` | |
| `DATABASE_URL` | bun:sqlite at `DATA_DIR/app.db` | `postgres://…` for Postgres |
| `DATA_DIR` | `./data` (`/data` in the engine image) | |
| `REDIS_URL` | in-memory bus, cache, rate limits | required when `REPLICAS > 1` |
| `REPLICAS` | `1` | |
| `S3_ENDPOINT`, `S3_BUCKET`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`, `S3_REGION` | storage off | |
| `S3_PUBLIC_ENDPOINT` | `S3_ENDPOINT` | Where browsers reach storage. Upload and download URLs are signed for it. |
| `BETTER_AUTH_SECRET` | generated in dev | required in production |
| `BETTER_AUTH_URL` | the server's URL | must be `https://` in production (`ALLOW_INSECURE_HTTP=1` to override for local testing) |
| `TRUSTED_ORIGINS` | none | comma-separated browser origins |
| `DASHBOARD` | on in dev, off in production | |
| `ADMIN_KEY` | generated in dev | owner access to the dashboard and `/metrics` |
| `CACHE_TTL_MS` | `60000` (`0` in dev) | query result cache |
| `RUNTIME_WORKERS` | `1` | function runtime processes per server |
| `FUNCTION_TIMEOUT_MS`, `ACTION_TIMEOUT_MS` | `10000`, `600000` | |
| `MAX_RESULT_BYTES`, `MAX_DOCUMENT_BYTES`, `MAX_REQUEST_BYTES` | 8 MiB, 1 MiB, 8 MiB | |
| `RATE_LIMIT_PER_MINUTE` | `1200` (`0`, off, in dev) | per client IP |
| `MAX_SUBSCRIPTIONS_PER_CONNECTION` | `200` | |
| `TRUST_PROXY` | off | use `X-Forwarded-For` for client IPs |
| `LOG_FORMAT` | `pretty` in dev, `json` in production | |
| `LOG_RETENTION_DAYS` | `7` | function logs kept in the database |
| `SCHEMA_CHECK` | on in production | refuse to start when stored documents don't match the schema |
| `METRICS_TOKEN` | `ADMIN_KEY` | bearer token for `/metrics` |
| `OTEL_EXPORTER_OTLP_ENDPOINT` (or `…_TRACES_ENDPOINT`), `OTEL_SERVICE_NAME` | tracing off | export a span per function call over OTLP/HTTP JSON; incoming `traceparent` headers are continued |

Variables set with `archlast-forge env set` are stored in the database and loaded into the function runtime. The process environment wins over them.
