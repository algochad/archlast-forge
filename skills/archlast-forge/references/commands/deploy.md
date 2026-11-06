# Command: `deploy [check]`

Gets an app ready for real users and deploys it: a preflight of every production setting, a backup, the build, `archlast-forge up` (or the project's own path), and checks on the running app. `check` stops after the preflight and changes nothing. Example: `/archlast-forge deploy check`.

Deploying is outward-facing and hard to undo: **ask before** `up`, `down`, `restore`, `migrate --run`, `env set` or anything that publishes, every time.

## 1. Find out where it runs

Read `archlast-forge.json`, `compose.yaml`, `.env` (never print secret values: say set / missing / weak), `Dockerfile`, and ask if unclear: a Docker host with `archlast-forge up` (the tested path), an image for an orchestrator (`build --tag`), `--no-docker` under systemd, or a platform (Coolify, Fly, Kubernetes). Then read [operations.md](../operations.md) "Deployment" and the matching path.

## 2. Preflight

Go through the list in operations.md "Before real users arrive" plus these, and mark each pass / fail / unknown:

| Check                                                                                      | How                                                                                          |
| ------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `BETTER_AUTH_SECRET` set, random, 32+ chars; `ADMIN_KEY` set, random                       | `.env` / the platform's store; length only                                                    |
| `BETTER_AUTH_URL` is the public `https://` address; no `ALLOW_INSECURE_HTTP`               | `.env`                                                                                       |
| TLS in front (Caddy in the stack, or the platform's proxy); `TRUST_PROXY=1` behind one     | `archlast-forge.json` services, `.env`                                                       |
| `TRUSTED_ORIGINS` only the origins that need it, never `*`                                  | `.env`                                                                                       |
| Dashboard off or fenced (`DASHBOARD`), `ALLOW_CUSTOM_FUNCTIONS` off                         | `compose.yaml` (`DASHBOARD: ${DASHBOARD:-on}` means on), `.env`                               |
| Database: SQLite on a persistent volume and one server, or Postgres; Postgres and Redis not published | `compose.yaml` ports                                                              |
| Pool sizes unset unless other apps share the database                                       | `.env` (`DATABASE_POOL_SIZE`, `DATABASE_WRITE_POOL_SIZE`)                                     |
| Backups scheduled to somewhere off the server (`BACKUP_SCHEDULE`, `BACKUP_S3_*`), and one restored once | `.env`; ask                                                                       |
| Every variable the code reads is passed by `compose.yaml`                                   | `grep -rhoE "process\.env\.[A-Z_]+" forge --exclude-dir=node_modules | sort -u` against `app.environment`                         |
| The WAF, if wanted: `WAF=on` with `WAF_MODE=detect` first                                   | `.env`; never switch it to block on a live app unasked                                        |
| Code: `bun run codegen` leaves `forge/_generated` unchanged, `bun run typecheck` and the tests pass, a clean tree | run them                                                          |
| Schema: stored documents fit it (production refuses to start otherwise)                     | `archlast-forge migrate` against the running server, or a staging copy                        |

Stop on any **fail** in the first five rows: explain and offer the fix (most are a line in `.env`). With `check`, end here with the table.

## 3. Deploy (after a yes)

1. A backup of the running deployment, if there is one: `archlast-forge backup before-deploy-<date>.tar.gz`.
2. The path from section 1: `archlast-forge up` (it builds the image and starts the stack, then waits for health); or `build --tag <image>` and the orchestrator's rollout; or `build --no-docker` and a service restart.
3. Migrations, if the schema changed in steps ([operations.md](../operations.md) "Upgrades and deploying changes"): `archlast-forge migrate --run-migrations` (ask first).

## 4. Verify

- `GET /health` is `200`, `GET /ready` is `200 {"ready":true}` (its `error` says why when not).
- `archlast-forge logs app`: no `✗` line, the `Postgres connections:` line within limits, no WAF or Helmet configuration errors.
- Through the public URL: the page or API answers over https, sign-in works, a live query updates (WebSocket through the proxy), an upload works if the app has them.
- `/_dashboard` answers only as intended (404 when off, fenced otherwise).

## 5. Report

```
Deploy: <app> → <where> (<path>)
Preflight: N pass · M fail · K unknown   (the table)
Backup: <file> · Deployed: <image/tag> at <time>
Live checks: health · ready · https · sign-in · live updates · uploads · dashboard fenced
Follow-ups: … (restore a backup once, monitoring, …)
```

## Full documentation

| Page                                                                                                                | Read it for                                                         |
| ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [deployment](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/deployment.mdx)     | the paths, proxies, health and shutdown, the image                  |
| [backend](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/backend.mdx)           | the generated stack file by file, HTTPS, secrets rotation           |
| [configuration](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/configuration.mdx) | every variable and its production default                         |
| [backups](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/backups.mdx)           | scheduling, where backups go, restoring                             |
