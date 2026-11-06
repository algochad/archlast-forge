import { defineAuth } from "@archlast/forge-runtime";
import { jwt, oauthProvider, organization, twoFactor } from "@archlast/forge-runtime/auth";
import { apiKey } from "@archlast/forge-runtime/auth/api-key";

// Plugins the engine comes with, and no table for them in schema.ts.
export default defineAuth({
  emailAndPassword: { enabled: true },
  disabledPaths: ["/token"],
  plugins: [
    organization(),
    twoFactor(),
    apiKey(),
    jwt(),
    oauthProvider({ loginPage: "/sign-in", consentPage: "/consent", scopes: ["openid", "profile", "email", "offline_access"] }),
  ],
});
