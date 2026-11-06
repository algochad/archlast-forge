# Command: `auth <plugin> [details]`

Sets up one Better Auth feature end to end: the server plugin in `forge/auth.ts`, its tables, the client half, the pages or guards that use it, and tests. Examples: `/archlast-forge auth two-factor`, `/archlast-forge auth organization`, `/archlast-forge auth oauth-provider "partners call /api/v1/orders"`, `/archlast-forge auth social github`.

| `<plugin>`                                      | Better Auth plugin                          | Read                                         |
| ----------------------------------------------- | ------------------------------------------- | -------------------------------------------- |
| `two-factor`, `passkey`, `magic-link`, `admin`, `bearer`, `username`, `anonymous`, … | the plugin of that name                     | [auth-plugins.md](../auth-plugins.md) §1, §5 |
| `organization` (multi-tenant, teams, invitations) | `organization()` + a `TenantContext` service | [auth-plugins.md](../auth-plugins.md) §3     |
| `oauth-provider` (be an OAuth / OIDC provider)  | `@better-auth/oauth-provider` + `jwt()`     | [auth-plugins.md](../auth-plugins.md) §2     |
| `oauth-client` (sign in with another forge app, call its API) | `genericOAuth()`                  | [auth-plugins.md](../auth-plugins.md) §4     |
| `social <provider>` (GitHub, Google, …)          | `socialProviders` in `defineAuth`           | [server-features.md](../server-features.md) "Authentication" |

## 1. Before you write

1. Read [auth-plugins.md](../auth-plugins.md) §1 (the rules for every plugin) and the section for this plugin.
2. Read `forge/auth.ts` (plugins already there), `forge/schema.ts` (tables already declared) and, in a full-stack app, `app/root.tsx` (`authPlugins`).
3. Collect what only the user knows and ask for it in one message: provider client ids (never invent them; they go in `.env` and `.env.example`), who may administer, which scopes partners get, email sending for invitations or magic links.

## 2. Steps

1. **Server plugin** in `forge/auth.ts`. A plugin in its own package: `cd forge && bun add <package>@<the engine's Better Auth version>` (§1 rule 2), never the root.
2. **Tables**: generate them with `forge/_auth-tables.ts` (§1 rule 3), paste the output into `defineSchema`, never hand-write them, never declare the built-in `users`/`sessions`/`accounts`/`verifications`.
3. **Secrets and settings** in `.env` (and empty in `.env.example`); for Docker, pass them in `compose.yaml` under `app.environment`.
4. **Client half**: `export const authPlugins = [...]` in `app/root.tsx` (or the client's `authPlugins` option in a separate frontend), with the packages in the root `package.json` too.
5. **Your code**, by the blueprint ([feature.md](feature.md)): the guard, `TenantContext`, consent page, sign-in page or settings page in `_modules/<feature>/` and `app/routes/`. Tenant tables get `organizationId` with an index, read from the session, never from the client.
6. `bun run codegen && bun run typecheck`, tests ([test.md](test.md): `withIdentity`, and `session: { activeOrganizationId }` for tenant tests).

## 3. Verify

- `bun run dev` starts with no `Unknown table` or `… is not in the validator` error (the tables match the plugin).
- The flow works against the dev server: sign in, then the plugin's step (`curl` the plugin's `/api/auth/...` endpoint, or the page in a browser). For the OAuth provider: `/api/auth/.well-known/openid-configuration` answers, and a guarded route refuses a missing or wrong-scoped token.
- Tests pass, including the "not allowed" cases (another tenant, missing scope, second factor not given).

## 4. Report

```
Auth: <plugin>
  forge/auth.ts: plugin(...) · tables: … (generated) · env: NAME (in .env.example, compose.yaml)
  client: authPlugins += …     · pages/guards: …
Checks: dev starts · flow tried: … · tests: …
Needs from you: provider credentials in .env · email sending · …
```

## 5. Stop and ask when

- the plugin needs credentials, an email service or a domain you were not given;
- the plugin's package version would differ from the engine's Better Auth version;
- the change signs existing users out or changes who can see what (sessions, roles, tenant scoping on existing tables: data may need a migration, [data-and-functions.md](../data-and-functions.md)).

## Full documentation

| Page                                                                                                | Read it for                                                         |
| --------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| [auth](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/auth.mdx) | `defineAuth`, plugins, social providers, the viewer, client plugins |
| [migrations](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/migrations.mdx) | filling `organizationId` on existing documents             |
