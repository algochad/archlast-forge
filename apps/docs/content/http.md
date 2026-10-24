# HTTP endpoints

Expose plain HTTP routes for things that aren't function calls: webhooks, a public JSON API, a file download. Declare them in `forge/http.ts`.

```ts
// forge/http.ts
import { httpAction, httpRouter } from "@archlast-forge/runtime";
import { api, internal } from "./_generated/api";

const http = httpRouter();

http.route({
  method: "POST",
  path: "/stripe/webhook",
  handler: httpAction(async (ctx, request) => {
    const body = await request.text(); // the exact bytes, for signature checks
    await ctx.runMutation(internal.billing.record, { body, signature: request.headers.get("stripe-signature") });
    return new Response(null, { status: 200 });
  }),
});

http.route({
  method: "GET",
  path: "/lists",
  handler: httpAction(async (ctx) => Response.json(await ctx.runQuery(api.lists.page, { paginationOpts: { numItems: 20, cursor: null } }))),
});

export default http;
```

Routes are served under `/http`: the first route above answers at `https://your-app.example/http/stripe/webhook`. The handler sees the path it registered, without the prefix.

## Handlers

A handler takes `(ctx, request)` and returns a standard `Response`. `ctx` is the same as an action's: `runQuery`, `runMutation`, `runAction`, `storage`, `scheduler` and `auth`. Use mutations to write data; a handler has no database access of its own.

- **Methods:** `GET`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`.
- **Paths:** `path` matches exactly. `pathPrefix` (starts and ends with `/`) matches everything below it. An exact path beats a prefix, and the longest prefix wins.
- **Unknown path:** 404. A known path under another method: 405 with an `Allow` header.
- **Who's calling:** `ctx.auth.getUserIdentity()` resolves the signed-in user from the request's cookie or `authorization` header, as in any function. Webhooks and other callers with neither header are anonymous, so verify their own signature or token yourself.
- **CORS:** none is added. Answer preflights with an `OPTIONS` route and set the headers you want.
- **Bodies** are bytes in both directions, so binary uploads and downloads work. They are buffered, not streamed, and a request is limited to `MAX_REQUEST_BYTES`.
- **Errors:** a `ForgeError` becomes a 400 with its data. Any other error becomes a 500 saying only "Server error" with a request id outside dev, and the full error is logged under that id. To control the status and body yourself, return a `Response` instead of throwing.

## Limits

A handler gets the action timeout (`ACTION_TIMEOUT_MS`, 10 minutes by default), so keep it short: a webhook sender usually gives up long before. Calls are rate limited per client IP like function calls, count in the call log and `/metrics` as `http <METHOD> <route>`, and appear in the dashboard's logs.
