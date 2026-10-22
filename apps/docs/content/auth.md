# Authentication

[Better Auth](https://better-auth.com) is built in. Its data lives in your database as ordinary documents, in the `users`, `sessions`, `accounts` and `verifications` tables, so it's reactive and visible in the dashboard.

Email and password sign-in works out of the box. To customize it, add `convex/auth.ts`:

```ts
import { defineAuth } from "@archlast-forge/runtime";

export default defineAuth({
  emailAndPassword: { enabled: true, requireEmailVerification: false },
  socialProviders: { github: { clientId: process.env.GITHUB_ID!, clientSecret: process.env.GITHUB_SECRET! } },
});
```

In functions, `await ctx.auth.getUserIdentity()` returns `{ userId: Id<"users">, email, name, sessionId }` or `null`. The identity is resolved once per request, from the session cookie or an `Authorization` header.

In the browser, `useAuth()` gives you the Better Auth client (`signIn.email`, `signUp.email`, `signOut`, …) and `useSession()` gives you the current session. After sign-in or sign-out, the client reconnects its WebSocket so live queries run as the new user.

- **Production:** set `BETTER_AUTH_SECRET` (required) and `BETTER_AUTH_URL` (must be `https://`). Startup fails without them.
- **Rate limiting:** Better Auth's sign-in rate limits are shared through Redis when `REDIS_URL` is set.
- **Banning:** banning a user in the dashboard ends their sessions and blocks new ones.
- **Cross-origin frontends:** list them in `TRUSTED_ORIGINS`. The default setup proxies the frontend instead, so it stays same-origin.
