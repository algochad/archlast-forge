// @archlast/forge-runtime/auth: Better Auth plugins that come with the engine, at the engine's Better Auth version, for forge/auth.ts.
// Nothing here runs unless an app passes a plugin to defineAuth({ plugins }); the tables a plugin needs are then the engine's to declare
// (server/auth-tables.ts at load, and codegen for the types): schema.ts lists none of them.
//
//   import { defineAuth } from "@archlast/forge-runtime";
//   import { jwt, oauthProvider, organization } from "@archlast/forge-runtime/auth";
//   export default defineAuth({ plugins: [organization(), jwt(), oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" })] });

/** OAuth 2.1 and OpenID Connect provider: the app as an authorization server. Needs `jwt()` beside it. */
export { oauthProvider } from "@better-auth/oauth-provider";
/** Organizations, members, invitations and roles (and teams with `teams: { enabled: true }`): multi-tenant apps. */
export { organization } from "better-auth/plugins";
/** Signing keys and JWTs (the `jwks` endpoint), which the OAuth provider signs its tokens with. */
export { jwt } from "better-auth/plugins";
