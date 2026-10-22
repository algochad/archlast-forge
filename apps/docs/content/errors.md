# Errors

Throw `ForgeError` for errors meant for the caller. Its message and data reach the client unchanged:

```ts
import { ForgeError } from "@archlast-forge/runtime";

if (!identity) throw new ForgeError("Sign in to post");
if (count >= limit) throw new ForgeError({ code: "LIMIT", max: limit });
```

```ts
try {
  await send({ body });
} catch (e) {
  if (e instanceof ForgeError) showToast(e.data.code === "LIMIT" ? "Too many" : e.message);
}
```

Argument validation errors also reach the caller as-is. Any other error is a bug, so outside dev the client sees only `Server error (request <id>)`. The full error and stack are logged with that request id. You can search for it in the dashboard's logs, and every response carries it in an `x-request-id` header.

Timeouts are reported as `TIMEOUT` (see [Limits](limits.html)). In React, `useQuery` throws errors to the nearest error boundary.
