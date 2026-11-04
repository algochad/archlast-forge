import { defineAuth } from "@archlast/forge-runtime";
import { oauthProvider } from "@better-auth/oauth-provider";
import { jwt } from "better-auth/plugins";

export default defineAuth({
  emailAndPassword: { enabled: true },
  disabledPaths: ["/token"],
  plugins: [jwt(), oauthProvider({ loginPage: "/sign-in", consentPage: "/consent", scopes: ["openid", "profile", "email", "offline_access"] })],
});
