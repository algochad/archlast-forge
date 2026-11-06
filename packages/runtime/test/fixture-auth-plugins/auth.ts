import { defineAuth } from "@archlast/forge-runtime";
import { jwt, oauthProvider, organization } from "@archlast/forge-runtime/auth";

// The plugins the engine comes with, and no table for them in schema.ts.
export default defineAuth({
  emailAndPassword: { enabled: true },
  disabledPaths: ["/token"],
  plugins: [organization(), jwt(), oauthProvider({ loginPage: "/sign-in", consentPage: "/consent", scopes: ["openid", "profile", "email", "offline_access"] })],
});
