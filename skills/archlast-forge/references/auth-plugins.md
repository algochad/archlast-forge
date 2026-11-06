# Better Auth plugins: OAuth provider, organizations (multi-tenant), and the rest

Read this when the user wants anything Better Auth has a plugin for. In particular:

- "we want to be an OAuth provider", "Sign in with <our app>", "let other apps access our API on a user's behalf", OIDC, SSO for partners: **the OAuth Provider plugin** (section 2).
- "multi-tenant SaaS", workspaces, teams, organizations, "invite members", per-customer data: **the organization plugin** (section 3).
- "connect our app to another forge app that is an OAuth provider", "Sign in with <their app>", "call their API for our users" or "as our server": **the `genericOAuth` plugin** (section 4).

**Use the plugin. Do not build an OAuth server, token tables, tenant tables, memberships or invitations yourself.** Better Auth is the engine's auth (`forge/auth.ts`, served at `/api/auth/*`), and its plugins run inside it. Everything below was run end to end in an archlast-forge app (better-auth 1.7.12).

## 1. Rules for every plugin

1. **Plugins go in `forge/auth.ts`**: `defineAuth({ …, plugins: [ … ] })`.
2. **Better Auth's plugins come with the engine; import them from it, install nothing.** `@archlast/forge-runtime/auth` has everything `better-auth/plugins` exports (`organization`, `twoFactor`, `admin`, `jwt`, `bearer`, `magicLink`, `emailOTP`, `genericOAuth`, `username`, `phoneNumber`, `anonymous`, `multiSession`, `deviceAuthorization`, …) and `oauthProvider`; the separately published ones are subpaths: `/auth/oauth-provider`, `/auth/api-key` (`apiKey`), `/auth/passkey` (`passkey`), `/auth/sso` (`sso`), `/auth/scim` (`scim`), `/auth/i18n` (`i18n`). Only plugins that need an SDK of the app's are installed (`@better-auth/stripe` with `stripe`, `@better-auth/expo` for mobile, `@better-auth/electron`), at the engine's Better Auth version, or a second copy of Better Auth is installed: `cd forge && bun add @better-auth/stripe@<version>`, where `<version>` is `grep '"version"' forge/node_modules/better-auth/package.json` (1.7.12 for this release). Server dependencies go in `forge/package.json`, never the root.
3. **The tables a plugin adds are the engine's: declare none of them in `forge/schema.ts`.** At load the engine derives a table for each model a plugin in `plugins` describes (the model name plus `s`: `members`, `jwkss`, `oauthClients`; dates as numbers, optional fields accepting `null`, JSON as `v.any()`, an index `by_<field>` on each unique, indexed or reference field), following the plugin's options (`organization({ teams: { enabled: true } })` adds `teams`, `teamMembers`). `bun run codegen` writes their types to `forge/_generated/authTables.ts`, so `ctx.db.query("members").withIndex("by_userId", …)` is typed: run it after changing `forge/auth.ts`. Never hand-write them; a table declared in `schema.ts` under the same name replaces the engine's (only for projects that declared them before). Never declare `users`, `sessions`, `accounts`, `verifications` (built in; fields plugins add to them just work).
4. **Client plugins** (the browser half: `organizationClient()`, `oauthProviderClient()`, `twoFactorClient()`, …): a full-stack app exports them from `app/root.tsx` as `export const authPlugins = [ … ]` (the framework gives them to the client on the server render and in the browser); a separate frontend passes `authPlugins` to `new ArchlastForgeClient({ … })` ([clients.md](clients.md)). Type their methods with `useAuth<typeof authPlugins>()` (`import type { authPlugins } from "../root"`). They run in the browser, so their packages go in the **root** `package.json` as well (`better-auth`, `@better-auth/*` at the engine's version). Not every plugin has a client half: `genericOAuth` (section 4) needs none.
5. **Plugin hooks** (`databaseHooks`, `sendInvitationEmail`, …) run outside any function call: no `ctx`, no `ctx.db`. Keep them to checks and sending.
6. With any plugin, the engine resolves sessions through Better Auth instead of its fast path: about a millisecond more per call. Expected.
7. **Your own code still follows the blueprint** ([feature-blueprint.md](feature-blueprint.md)): guards, services and controllers that work with a plugin live in `forge/_modules/<feature>/`.

## 2. Being an OAuth 2.1 / OpenID Connect provider

The OAuth Provider plugin (`@better-auth/oauth-provider`, with the `jwt` plugin) makes the app an authorization server: authorization code + PKCE, consent, ID tokens, `userinfo`, refresh-token rotation, introspection, revocation, client registration, discovery, JWKS. Upstream reference: https://better-auth.com/docs/plugins/oauth-provider

### 2.1 `forge/auth.ts`

```ts
import { defineAuth } from "@archlast/forge-runtime";
import { jwt, oauthProvider } from "@archlast/forge-runtime/auth";

/** The app's own API as an OAuth resource: access tokens for it are JWTs with this audience. */
export const API_RESOURCE = `${process.env.BETTER_AUTH_URL ?? "http://localhost:3000"}/http`;

/** Who may register and manage OAuth clients: staff, by user id (OAUTH_ADMIN_USER_IDS, comma-separated), read on each call. */
const isStaff = (user?: { id: string }) =>
  !!user && (process.env.OAUTH_ADMIN_USER_IDS ?? "").split(",").map((id) => id.trim()).includes(user.id);

export default defineAuth({
  emailAndPassword: { enabled: true },
  disabledPaths: ["/token"], // the JWT plugin's session-token endpoint; OAuth clients use /oauth2/token
  plugins: [
    jwt(),
    oauthProvider({
      loginPage: "/sign-in",
      consentPage: "/consent",
      scopes: ["openid", "profile", "email", "offline_access", "tasks:read"], // your own scopes after the standard ones
      resources: [API_RESOURCE],
      clientRegistrationDefaultResources: [API_RESOURCE], // without it: "client … is not linked to resource(s)"
      // Who may register and manage OAuth clients. Without it ANY signed-in user can (every customer, with open sign-up).
      clientPrivileges: ({ user }) => isStaff(user), // your rule; return false or undefined to refuse
    }),
  ],
});
```

**Decide who registers clients, and ask the user if they did not say.** Without `clientPrivileges`, every signed-in user can create, change and delete OAuth clients. Typical rules: staff only (`isStaff` reading user ids or an admin role), or any signed-in user when partners register themselves (then leave it out deliberately and say so). It receives `{ action, user, session, headers, clientId? }`.

Its tables (`jwkss`, `oauthClients`, `oauthResources`, `oauthClientResources`, `oauthRefreshTokens`, `oauthAccessTokens`, `oauthConsents`, `oauthClientAssertions`) are the engine's (section 1, rule 3). Codegen, typecheck.

### 2.2 What it serves (under `/api/auth`; the issuer is `BETTER_AUTH_URL/api/auth`)

| Address                                                                                               | For                                                                         |
| ----------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `/api/auth/.well-known/openid-configuration`                                                         | discovery: give clients this                                                |
| `/api/auth/oauth2/authorize`, `/api/auth/oauth2/token`                                                | the flow (`response_type=code`, PKCE S256; `authorization_code`, `refresh_token`, `client_credentials`) |
| `/api/auth/oauth2/userinfo`, `/api/auth/jwks`                                                         | the user for an access token; signing keys                                   |
| `/api/auth/oauth2/introspect`, `/revoke`, `/end-session`                                              | RFC 7662, RFC 7009, logout                                                   |
| `/api/auth/oauth2/create-client`, `get-clients`, `update-client`, `delete-client`, `public-client`, `consent` | client management (signed-in user), the public name for consent screens, the consent answer |

- Discovery works both ways a client may start from the issuer: OpenID Connect at `/api/auth/.well-known/openid-configuration`, and RFC 8414 (some OAuth and MCP clients) at `/.well-known/oauth-authorization-server/api/auth`, which the engine routes to Better Auth's document (likewise `/.well-known/openid-configuration/api/auth`). Do not add routes for them.
- **Client registration:** `POST /api/auth/oauth2/create-client` with `{ redirect_uris, client_name, token_endpoint_auth_method }` (signed in, allowed by `clientPrivileges`) returns `client_id` and, once, `client_secret`. Web clients need `https://` redirect URIs, `localhost` included; during development register a client app on this machine as `application_type: "native"`, which allows `http://localhost:<port>/…`. Build a "Developer apps" page over these endpoints if users register apps; do not write your own clients table.
- **Machine clients** (`client_credentials`, a server calling as itself): `grant_types: ["client_credentials"]` and **no `redirect_uris` key** (an empty list is refused). Their token requests are refused ("client has no authorized client_credentials scopes") until the client's `clientCredentialsScopes` is set, which Better Auth's server-only admin API does and functions cannot reach. Do the same write in a staff-only mutation (a service behind your staff check): `const c = await this.ctx.db.query("oauthClients").withIndex("by_clientId", (q) => q.eq("clientId", clientId)).unique(); await this.ctx.db.patch(c!._id, { clientCredentialsScopes: scopes });`.
- **Tokens:** with `resource=<API_RESOURCE>` in the authorize and token requests, access tokens are JWTs (`typ: at+jwt`, audience = your API). Without it they are opaque. Refresh tokens rotate on every use; a reused authorization code gets `invalid_grant`.

### 2.3 Sign-in and consent pages

A visitor who is not signed in goes to `loginPage`, one who is to `consentPage`, each with a **signed query** (it carries `sig`). Both pages must send that query back as `oauth_query`: add Better Auth's `oauthProviderClient()` to the client plugins and it does so on every request those pages make (section 1, rule 4; `@better-auth/oauth-provider` also in the root `package.json`).

```tsx
// app/root.tsx
import { oauthProviderClient } from "@better-auth/oauth-provider/client";
export const authPlugins = [oauthProviderClient()];
```

- **Sign-in page:** nothing changes. With the plugin, the scaffold's own `signIn.email(...)` form carries the signed query, and Better Auth sends the browser on to `/consent?…` (checked in a browser).
- **Consent page** (`app/routes/consent.tsx`):

```tsx
import { redirect, useLoaderData, type LoaderArgs } from "@archlast/forge-framework";
import { useAuth } from "@archlast/forge-react";
import { useEffect, useState } from "react";
import type { authPlugins } from "../root";

export const loader = async ({ ctx, request }: LoaderArgs) => {
  const url = new URL(request.url);
  if (!(await ctx.viewer())) throw redirect(`/sign-in${url.search}`); // keep the signed query
  return {
    clientId: url.searchParams.get("client_id") ?? "",
    scopes: (url.searchParams.get("scope") ?? "").split(" ").filter(Boolean),
  };
};

export default function Consent() {
  const { clientId, scopes } = useLoaderData<typeof loader>();
  const auth = useAuth<typeof authPlugins>();
  const [name, setName] = useState<string>();
  useEffect(() => {
    fetch(`/api/auth/oauth2/public-client?client_id=${encodeURIComponent(clientId)}`)
      .then((r) => r.json())
      .then((c) => setName(c.client_name));
  }, [clientId]);
  async function answer(accept: boolean) {
    const res = await auth.oauth2.consent({ accept }); // the plugin adds this page's signed query
    if (res.data?.url) window.location.href = res.data.url; // back to the client app with a code, or access_denied
  }
  return (
    <main>
      <h1>{name ?? "An application"} wants to access your account</h1>
      <ul>
        {scopes.map((s) => (
          <li key={s}>{s}</li>
        ))}
      </ul>
      <button onClick={() => answer(true)}>Allow</button>
      <button onClick={() => answer(false)}>Deny</button>
    </main>
  );
}
```

Without the plugin, both pages put `oauth_query: window.location.search.slice(1)` in their `POST` bodies themselves (sign-in then answers `{ redirect: true, url }` to follow).

### 2.4 Protecting your API with the tokens (resource server)

Calls from other apps carry `Authorization: Bearer <access token>` and no session, so **`ctx.auth.getUserIdentity()` is `null` for them**. Verify the token in a guard (`better-auth/oauth2`), then pass its subject to **internal** functions. Never let a public function take a `userId` argument for this.

```ts
// forge/_modules/oauth/oauth.guard.ts
import {
  ApiSecurity,
  applyDecorators,
  createParamDecorator,
  ForbiddenException,
  Injectable,
  SetMetadata,
  UnauthorizedException,
  UseGuards,
  type CanActivate,
  type ExecutionContext,
  type NestRequest,
} from "@archlast/forge-runtime/nest";
import { isInsufficientScopeError, requestToResourceInput, verifyAccessTokenRequest } from "better-auth/oauth2";
import { API_RESOURCE } from "../../auth";

const SCOPES = "oauth:scopes";
const TOKEN = Symbol("oauth:token");
const BASE = API_RESOURCE.replace(/\/http$/, "");
export type OAuthClaims = { sub: string; scope?: string; azp?: string; [claim: string]: unknown };

@Injectable()
export class OAuthGuard implements CanActivate {
  async canActivate(context: ExecutionContext) {
    const requiredScopes = (Reflect.getMetadata(SCOPES, context.getHandler()) ??
      Reflect.getMetadata(SCOPES, context.getClass()) ??
      []) as string[];
    const req = context.switchToHttp().getRequest<NestRequest & { [TOKEN]?: OAuthClaims }>();
    try {
      req[TOKEN] = (await verifyAccessTokenRequest(requestToResourceInput(req.raw), {
        jwksUrl: `${BASE}/api/auth/jwks`,
        verifyOptions: { issuer: `${BASE}/api/auth`, audience: API_RESOURCE },
        requiredScopes,
      })) as OAuthClaims;
      return true;
    } catch (e) {
      if (isInsufficientScopeError(e)) throw new ForbiddenException(`This needs the scopes: ${requiredScopes.join(" ")}`);
      throw new UnauthorizedException("A valid access token is required");
    }
  }
}

/** On a controller or a route: an access token with these scopes is required (and the API docs say so). */
export const RequireScopes = (...scopes: string[]) =>
  applyDecorators(SetMetadata(SCOPES, scopes), UseGuards(OAuthGuard), ApiSecurity("oauth", scopes));
/** The verified token's claims. */
export const OAuthToken = createParamDecorator(
  (_: unknown, host: ExecutionContext): OAuthClaims => host.switchToHttp().getRequest()[TOKEN],
);
```

```ts
// forge/_modules/partner/partner.controller.ts: the API other apps call, at /http/partner
import { Controller, Ctx, Get, type ActionCtx } from "@archlast/forge-runtime/nest";
import { internal } from "../../_generated/api";
import { OAuthToken, RequireScopes, type OAuthClaims } from "../oauth/oauth.guard";

@Controller("partner")
@RequireScopes("tasks:read")
export class PartnerController {
  @Get("me")
  me(@Ctx() ctx: ActionCtx, @OAuthToken() token: OAuthClaims) {
    return ctx.runQuery(internal.partner.profile, { userId: token.sub, client: token.azp ?? null });
  }
}
```

`forge/partner.ts` declares `profile` as an `internalQuery` that injects a `PartnerReader`; `partner.module.ts` lists `PartnerController`, `PartnerReader` and `OAuthGuard`. Answers: `200` with a valid token, `401` without or with a bad one, `403` without the scope.

**Documenting it for partners:** declare the scheme once, `http.docs({ production: true, securitySchemes: { oauth: { type: "oauth2", flows: { clientCredentials: { tokenUrl: "/api/auth/oauth2/token", scopes: { "tasks:read": "Read tasks" } } } } } })` in `forge/http.ts` (the name must be the one `ApiSecurity` uses). The docs page then lists the scopes per route and its Authorize panel fetches a client-credentials token to try them ([server-features.md](server-features.md) "API docs and OpenAPI").

**Machine tokens** (`client_credentials`) have no user: `sub` is the client's id, the same as `azp`. A route that acts for a user refuses them (`if (token.sub === token.azp) throw new ForbiddenException("This needs a user's token")`); a route for machines reads `token.azp`.

### 2.5 Checklist

- [ ] `jwt` and `oauthProvider` imported from `@archlast/forge-runtime/auth` (nothing installed).
- [ ] `jwt()` + `oauthProvider({ loginPage, consentPage, scopes, resources, clientRegistrationDefaultResources, clientPrivileges })`; `disabledPaths: ["/token"]`.
- [ ] Who may register clients is decided (`clientPrivileges`), not left open by accident.
- [ ] No plugin tables in `schema.ts`; codegen (`_generated/authTables.ts`) and typecheck pass.
- [ ] `oauthProviderClient()` in the client plugins (`app/root.tsx`'s `authPlugins`), and a `/consent` page.
- [ ] Machine clients, if any, given their `clientCredentialsScopes` by a staff-only mutation.
- [ ] API routes for partners behind `RequireScopes(...)`, calling internal functions with `token.sub`; the `oauth` scheme and its scopes in `http.docs({ securitySchemes })`.
- [ ] Told the user: issuer and discovery URL, how clients register, which scopes exist.

## 3. Organizations: multi-tenant SaaS

The organization plugin gives organizations, members with roles (`owner`, `admin`, `member`), invitations, and an **active organization on each session**. Upstream: https://better-auth.com/docs/plugins/organization

```ts
// forge/auth.ts
import { organization } from "@archlast/forge-runtime/auth";
export default defineAuth({ emailAndPassword: { enabled: true }, plugins: [organization()] });
```

Its tables (`organizations`, `members`, `invitations`; `teams`, `teamMembers` with teams on) are the engine's, and `activeOrganizationId` lands on the built-in sessions. Users manage organizations through `/api/auth/organization/*`: `create`, `set-active`, `invite-member`, `accept-invitation`, `update-member-role`, `remove-member`, `list` (setting an organization you are not a member of is refused with 403).

### 3.1 The tenant of a call: one shared service

```ts
// forge/_modules/tenancy/tenant.service.ts
import { ForgeError } from "@archlast/forge-runtime";
import { ForgeService, Injectable, type QueryCtx } from "@archlast/forge-runtime/nest";
import type { Id } from "../../_generated/dataModel";

export type Role = "owner" | "admin" | "member";

/** The organization active in the caller's session, checked against their membership. Never take it from the client. */
@Injectable()
export class TenantContext extends ForgeService<QueryCtx> {
  async current() {
    const me = await this.ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in first");
    const session = await this.ctx.db.get(me.sessionId as Id<"sessions">);
    const organizationId = (session as { activeOrganizationId?: string | null } | null)?.activeOrganizationId;
    if (!organizationId) throw new ForgeError({ code: "NO_ORGANIZATION", message: "Choose an organization first" });
    const member = (await this.ctx.db.query("members").withIndex("by_userId", (q) => q.eq("userId", me.userId)).collect()).find(
      (m) => m.organizationId === organizationId,
    );
    if (!member) throw new ForgeError({ code: "NOT_A_MEMBER", message: "You are not a member of this organization" });
    return { userId: me.userId, organizationId, role: member.role as Role };
  }

  async require(...roles: Role[]) {
    const tenant = await this.current();
    if (!roles.includes(tenant.role)) throw new ForgeError({ code: "FORBIDDEN", message: `This needs the role ${roles.join(" or ")}` });
    return tenant;
  }
}
```

```ts
// forge/_modules/tenancy/tenancy.module.ts
@Module({ providers: [TenantContext], exports: [TenantContext] })
export class TenancyModule {}
```

### 3.2 A tenant-scoped feature (the blueprint plus the tenant)

```ts
// forge/schema.ts
projects: defineTable({ organizationId: v.string(), name: v.string(), createdBy: v.id("users") }).index("by_organizationId", ["organizationId"]),
```

```ts
// forge/_modules/projects/projects.service.ts
@Injectable()
export class ProjectsReader extends ForgeService<QueryCtx> {
  constructor(private readonly tenants: TenantContext) {
    super();
  }
  async list(paginationOpts: PaginationOptions) {
    const { organizationId } = await this.tenants.current();
    return this.ctx.db
      .query("projects")
      .withIndex("by_organizationId", (q) => q.eq("organizationId", organizationId))
      .order("desc")
      .paginate(paginationOpts);
  }
}

@Injectable()
export class ProjectsWriter extends ForgeService<MutationCtx> {
  constructor(private readonly tenants: TenantContext) {
    super();
  }
  async create(name: string) {
    const { organizationId, userId } = await this.tenants.current();
    return this.ctx.db.insert("projects", { organizationId, name: name.trim(), createdBy: userId });
  }
  async remove(id: Id<"projects">) {
    const { organizationId } = await this.tenants.require("owner", "admin");
    const project = await this.ctx.db.get(id);
    if (!project || project.organizationId !== organizationId) throw new ForgeError("No such project"); // another tenant's row looks absent
    await this.ctx.db.delete(id);
  }
}
```

`projects.module.ts` has `imports: [TenancyModule]` and `providers: [ProjectsReader, ProjectsWriter]`. `forge/projects.ts` stays thin, as always. In testing: each owner saw only their organization's rows, another tenant's row read as missing, a member could read but not delete, the owner could.

### 3.3 Testing it

`t.withIdentity({ email, userId, session: { activeOrganizationId } })` signs in with a real session that has the organization active; create the `organizations` and `members` rows with `t.run` first. The full snippet is in [testing.md](testing.md) §5. Test that a second tenant sees nothing and that a member's write that needs `owner`/`admin` is refused.

### 3.4 Rules for multi-tenant code

1. **Every tenant table has `organizationId` and an index on it**, and every read of it filters through that index with the tenant from `TenantContext`.
2. **The organization never comes from the client** (no `organizationId` argument on a public function). It comes from the session.
3. **Rows fetched by id are checked against the tenant** before they are returned or changed.
4. **Roles are checked in services** (`require("owner", "admin")`), not in pages or controllers.
5. **Tenant-specific webhooks:** pass `organizationId` as `tenant` to `webhooks.dispatch()` and the endpoint methods ([webhooks.md](webhooks.md)).
6. Use the plugin's roles and invitations; add `teams`, custom roles or access control through the plugin's own options, not new tables.

## 4. Being the client of another forge app ("Sign in with Acme", calling its API)

When this app should sign people in with another archlast-forge app that is an OAuth provider (section 2), and call that app's API for them or as itself. Use Better Auth's **`genericOAuth`** plugin: no client plugin, no custom OAuth code. Inside one system of your own (a monorepo's services) use Forge RPC instead ([forge-rpc.md](forge-rpc.md)); OAuth is for apps with separate owners, or where users grant access.

### 4.1 Register at the provider

At the provider ("Acme"), register this app ("Partner") as a client with the redirect URI **`<Partner's BETTER_AUTH_URL>/api/auth/callback/acme`** (the last part is Partner's `providerId`): `https://` in production, a `native` client with `http://localhost:<port>/…` in development. For calls as Partner itself, register a second, machine client (section 2.2) and have Acme's staff give it its scopes. Put the ids and secrets in Partner's `.env` / `.env.example`.

### 4.2 Partner's `forge/auth.ts`

```ts
import { defineAuth } from "@archlast/forge-runtime";
import { genericOAuth } from "@archlast/forge-runtime/auth";

export const ACME_URL = process.env.ACME_URL ?? "http://localhost:3000";
export const ACME_API = `${ACME_URL}/http`; // the resource Partner's tokens are for

export default defineAuth({
  emailAndPassword: { enabled: true },
  advanced: { cookiePrefix: "partner" }, // two apps on localhost in development: their session cookies must not share a name
  plugins: [
    genericOAuth({
      config: [
        {
          providerId: "acme",
          discoveryUrl: `${ACME_URL}/api/auth/.well-known/openid-configuration`,
          clientId: process.env.ACME_CLIENT_ID ?? "",
          clientSecret: process.env.ACME_CLIENT_SECRET,
          scopes: ["openid", "profile", "email", "offline_access", "tasks:read"],
          pkce: true,
          authorizationUrlParams: { resource: ACME_API },
          tokenUrlParams: { resource: ACME_API },
          refreshTokenParams: { resource: ACME_API },
        },
      ],
    }),
  ],
});
```

- **The sign-in button** is the core social sign-in (in Better Auth 1.7 `genericOAuth` providers are social providers; there is no `genericOAuthClient`): `useAuth().signIn.social({ provider: "acme", callbackURL: "/acme" })`. The first sign-in creates the user at Partner and an `accounts` row (`providerId: "acme"`) with Acme's access token, refresh token and `accessTokenExpiresAt`.
- `genericOAuth` adds no tables.

### 4.3 Calling Acme as the user, and as Partner

One feature folder, `_modules/acme/`, in the blueprint shape:

```ts
// forge/_modules/acme/acme.service.ts
import { ForgeError } from "@archlast/forge-runtime";
import { ForgeService, Injectable, type ActionCtx, type MutationCtx, type QueryCtx } from "@archlast/forge-runtime/nest";
import { internal } from "../../_generated/api";
import type { Id } from "../../_generated/dataModel";
import { ACME_API, ACME_URL } from "../../auth";

const TOKEN_URL = `${ACME_URL}/api/auth/oauth2/token`;

/** The user's Acme tokens (their `accounts` row). Internal only: tokens never reach a client. */
@Injectable()
export class AcmeAccounts extends ForgeService<QueryCtx> {
  async tokensOf(userId: Id<"users">) {
    const account = (await this.ctx.db.query("accounts").withIndex("by_userId", (q) => q.eq("userId", userId)).collect()).find(
      (a) => a.providerId === "acme",
    );
    if (!account?.accessToken) return null;
    return {
      accountId: account._id,
      accessToken: account.accessToken,
      refreshToken: account.refreshToken ?? undefined,
      accessTokenExpiresAt: account.accessTokenExpiresAt ?? undefined,
    };
  }
}

/** Keeps refreshed tokens on the same row: the only write this app makes to `accounts`. */
@Injectable()
export class AcmeTokenStore extends ForgeService<MutationCtx> {
  async save(accountId: Id<"accounts">, t: { accessToken: string; refreshToken?: string; expiresIn?: number }) {
    await this.ctx.db.patch(accountId, {
      accessToken: t.accessToken,
      ...(t.refreshToken && { refreshToken: t.refreshToken }),
      ...(t.expiresIn && { accessTokenExpiresAt: Date.now() + t.expiresIn * 1000 }),
      updatedAt: Date.now(),
    });
  }
}

/** Calls Acme as the signed-in user, refreshing their token a minute before it expires. */
@Injectable()
export class AcmeApi extends ForgeService<ActionCtx> {
  // Return types written out: this class calls internal.acme.*, whose types come from forge/acme.ts, which imports this class.
  private async token(): Promise<string> {
    const me = await this.ctx.auth.getUserIdentity();
    if (!me) throw new ForgeError("Sign in first");
    const tokens = await this.ctx.runQuery(internal.acme.tokens, { userId: me.userId });
    if (!tokens) throw new ForgeError({ code: "NOT_CONNECTED", message: "Sign in with Acme first" });
    if (tokens.accessTokenExpiresAt === undefined || tokens.accessTokenExpiresAt > Date.now() + 60_000) return tokens.accessToken; // 0 is expired
    if (!tokens.refreshToken) throw new ForgeError({ code: "NOT_CONNECTED", message: "Sign in with Acme again" });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: tokens.refreshToken,
        client_id: process.env.ACME_CLIENT_ID ?? "",
        client_secret: process.env.ACME_CLIENT_SECRET ?? "",
        resource: ACME_API,
      }),
    });
    if (!res.ok) throw new ForgeError({ code: "NOT_CONNECTED", message: "Sign in with Acme again" });
    const fresh = (await res.json()) as { access_token: string; refresh_token?: string; expires_in?: number };
    await this.ctx.runMutation(internal.acme.saveTokens, {
      accountId: tokens.accountId,
      accessToken: fresh.access_token,
      refreshToken: fresh.refresh_token,
      expiresIn: fresh.expires_in,
    });
    return fresh.access_token;
  }

  async get(path: string): Promise<unknown> {
    const res = await fetch(`${ACME_API}${path}`, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new ForgeError({ code: "ACME_ERROR", message: `Acme answered ${res.status}` });
    return res.json();
  }
}

/** Calls Acme as Partner itself: a client_credentials token, kept until a minute before it expires. A singleton (no ctx). */
@Injectable()
export class AcmeMachine {
  private cached?: { token: string; until: number };

  private async token(): Promise<string> {
    if (this.cached && this.cached.until > Date.now() + 60_000) return this.cached.token;
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: process.env.ACME_M2M_CLIENT_ID ?? "",
        client_secret: process.env.ACME_M2M_CLIENT_SECRET ?? "",
        scope: "tasks:read",
        resource: ACME_API,
      }),
    });
    if (!res.ok) throw new Error(`Acme refused the client credentials: ${res.status}`);
    const t = (await res.json()) as { access_token: string; expires_in: number };
    this.cached = { token: t.access_token, until: Date.now() + t.expires_in * 1000 };
    return t.access_token;
  }

  async get(path: string): Promise<unknown> {
    const res = await fetch(`${ACME_API}${path}`, { headers: { authorization: `Bearer ${await this.token()}` } });
    if (!res.ok) throw new Error(`Acme answered ${res.status}`);
    return res.json();
  }
}
```

```ts
// forge/acme.ts: thin, as always
import { action, internalAction, internalMutation, internalQuery, v } from "@archlast/forge-runtime";
import { inject } from "@archlast/forge-runtime/nest";
import { AcmeAccounts, AcmeApi, AcmeMachine, AcmeTokenStore } from "./_modules/acme/acme.service";

export const profile = action({ handler: async (ctx) => (await inject(ctx, AcmeApi)).get("/partner/me") });
export const ping = internalAction({ handler: async (ctx) => (await inject(ctx, AcmeMachine)).get("/partner/ping") });
export const tokens = internalQuery({
  args: { userId: v.id("users") },
  handler: async (ctx, { userId }) => (await inject(ctx, AcmeAccounts)).tokensOf(userId),
});
export const saveTokens = internalMutation({
  args: { accountId: v.id("accounts"), accessToken: v.string(), refreshToken: v.optional(v.string()), expiresIn: v.optional(v.number()) },
  handler: async (ctx, { accountId, ...t }) => (await inject(ctx, AcmeTokenStore)).save(accountId, t),
});
```

`acme.module.ts` lists the four providers; add it to `_modules/index.ts`. Calls to Acme are I/O, so they run in actions (or crons), never in queries or mutations.

Tested end to end with two apps: sign-in with Acme (discovery, PKCE, `resource`, consent, callback), Partner calling Acme's API as the user, a refresh after the token expired, and a `client_credentials` call.

## 5. Other plugins, briefly

| Need                                               | Plugin (server / client)                          | Note                                                                       |
| -------------------------------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------- |
| Bearer tokens for scripts and other servers        | `bearer()` / none                                 | Then `Authorization: Bearer <session token>` works on `/rpc` and `/http`.  |
| Admin roles, bans                                  | `admin()`                                         | Adds `role`, `banned` to users: nothing to declare.                        |
| Two-factor                                         | `twoFactor()` / `twoFactorClient()`               | Its table is the engine's.                                                        |
| Mobile apps (Expo)                                 | `expo()` / `expoClient()`                         | See [clients.md](clients.md).                                              |

For any other plugin: read its Better Auth page, install it at the engine's version (or import it from `better-auth/plugins`), run codegen (its tables are the engine's), and test its endpoints under `/api/auth`.

## 6. Common mistakes

- Writing an OAuth server, a `clients`/`tokens` table, or JWT signing yourself, instead of the OAuth Provider plugin.
- Writing `tenants`, `memberships` or `invitations` tables yourself, instead of the organization plugin.
- Taking `organizationId` (or `userId`) from the client; reading tenant data without the tenant index.
- Installing a plugin the engine comes with (`@better-auth/oauth-provider`, `api-key`, `passkey`, `sso`, `scim`, `i18n`) or importing from `better-auth/plugins` instead of `@archlast/forge-runtime/auth`; installing any other `@better-auth/*` at another version than the engine's Better Auth.
- Declaring plugin tables in `schema.ts` (the engine declares them; codegen types them), or forgetting codegen after changing `forge/auth.ts`.
- Expecting `ctx.auth` on a bearer-token request from another app: verify the token in a guard and call internal functions.
- Web OAuth clients with `http://localhost` redirect URIs (refused), or a client that is not linked to the resource it asks for.
- Losing the signed query on the way from the consent page to sign-in, or leaving out `oauthProviderClient()` without sending `oauth_query` by hand.
- Adding routes for `/.well-known/...` discovery: the engine already answers both forms.
- A machine client registered with `redirect_uris: []`, or expected to work before its `clientCredentialsScopes` are set; a user route that accepts a machine token (`sub === azp`).
- As a client of another forge app: writing an OAuth client by hand instead of `genericOAuth`; looking for `genericOAuthClient` (1.7 uses `signIn.social`); forgetting `resource` in `authorizationUrlParams`, `tokenUrlParams` and `refreshTokenParams`; returning tokens to the browser; treating `accessTokenExpiresAt: 0` as "never expires"; two dev apps on localhost without a `cookiePrefix`.
- Leaving `clientPrivileges` out without deciding to: any signed-in user can then register OAuth clients.
- Testing tenant code with a bare `withIdentity()`: pass `session: { activeOrganizationId }` and create the membership ([testing.md](testing.md) §5).

## Full documentation

When this file is not enough, read the page instead of guessing (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                  | Read it for                                                                      |
| ----------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [auth](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/auth.mdx)   | plugins and their tables, being an OAuth provider, organizations, bearer tokens  |
| [clients](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/clients.mdx) | `authPlugins` in a separate frontend                                         |
| [webhooks](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/webhooks.mdx) | per-tenant webhooks                                                        |
| [nest](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/nest.mdx)   | guards, custom decorators                                                         |
