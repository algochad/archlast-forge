// @archlast/forge-runtime/auth: Better Auth's plugins, at the engine's Better Auth version, for forge/auth.ts. Nothing here runs unless an
// app passes a plugin to defineAuth({ plugins }); the tables a plugin needs are then the engine's to declare (server/auth-tables.ts at load,
// and codegen for the types): schema.ts lists none of them.
//
//   import { defineAuth } from "@archlast/forge-runtime";
//   import { jwt, organization, twoFactor, oauthProvider } from "@archlast/forge-runtime/auth";
//   export default defineAuth({ plugins: [organization(), twoFactor(), jwt(), oauthProvider({ loginPage: "/sign-in", consentPage: "/consent" })] });
//
// Everything `better-auth/plugins` exports is here: admin, anonymous, bearer, captcha, customSession, deviceAuthorization, emailOTP,
// genericOAuth (and its providers), haveIBeenPwned, jwt, lastLoginMethod, magicLink, multiSession, oAuthProxy, oneTap, oneTimeToken,
// openAPI, organization, phoneNumber, siwe, twoFactor, username, and their helpers. Better Auth's separately published plugins each have
// a subpath of their own, so an app loads only the ones it imports: /auth/oauth-provider, /auth/api-key, /auth/passkey, /auth/sso,
// /auth/scim, /auth/i18n.
export * from "better-auth/plugins";
/** OAuth 2.1 and OpenID Connect provider: the app as an authorization server. Needs `jwt()` beside it. All of it: /auth/oauth-provider. */
export { oauthProvider } from "@better-auth/oauth-provider";
