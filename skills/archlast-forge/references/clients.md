# Clients: a separate frontend, mobile and desktop apps against a backend

Read this when a UI is NOT the full-stack `app/` (a Vite/React/Vue/Svelte SPA, an Expo app, a Tauri app, a script) and talks to a forge backend through `@archlast/forge-client` or its bindings.
For pages inside a full-stack project (`archlast-forge.json` mode `framework`) read [fullstack.md](fullstack.md) instead; its `useQuery`/`useMutation` are the same hooks.

## Packages and types

| Package                  | Gives you                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@archlast/forge-client` | `ArchlastForgeClient`, `ForgeError`, `queryKey`, `syncQuery`, `windowArgs`, `pageArgs`                                                                                                        |
| `@archlast/forge-react`  | the client re-exported, `ArchlastForgeProvider`, `useQuery`, `usePaginatedQuery`, `useNumberedPage`, `useMutation`, `useAction`, `useUploadFile`, `useAuth`, `useSession`, `useArchlastForge` |
| `@archlast/forge-vue`    | `archlastForge` plugin, `useQuery`, `useMutation`, `useAction`, `useSession`, `useArchlastForge` (+ client, `ForgeError`, `windowArgs`, `pageArgs`)                                           |
| `@archlast/forge-svelte` | `query` and `session` stores (+ client, `ForgeError`, `windowArgs`, `pageArgs`); no mutation or action wrappers                                                                               |

- References come from the generated `api`: in the same repo `import { api } from "../forge/_generated/api"`; in a monorepo the main app's types are re-exported by `packages/api` (`import type { webApi } from "@acme/api"`, cast `anyApi` from `@archlast/forge-runtime`, see Mobile). Only **public** functions type-check; an `internal*` reference is a type error and the server answers 404 for it. `Doc`/`Id` types come from `forge/_generated/dataModel`.
- A frontend may import nothing else from `forge/` (`archlast-forge codegen` fails for files in `src/` or `app/` next to `forge/`).
- The generated types pull in `forge/` sources: if `forge/` uses Nest decorators the frontend's `tsconfig.json` needs `"experimentalDecorators": true` (the mobile and desktop templates set it).
- Use React 19 with `@archlast/forge-react`; Vue 3 with `-vue`. `@archlast/forge-react` ships its own TanStack Query.

## Connecting: same origin or cross origin

Same origin is the easiest (cookies are first-party, no CORS): a dev-server proxy, or one host in production whose proxy sends `/rpc` (WebSocket included), `/api/auth` and `/http` to the engine. Create the client with no URL (it uses `location.origin`):

```ts
// vite.config.ts
const backend = process.env.BACKEND_URL ?? "http://localhost:3000";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/rpc": { target: backend, ws: true }, "/api": backend } },
});
```

Cross origin (`new ArchlastForgeClient({ url: "https://api.example.com" })`):

- List the frontend's exact origin (scheme, host, port, no trailing slash) in the backend's `TRUSTED_ORIGINS`, comma separated. Only that variable adds CORS headers (`access-control-allow-origin`, `-credentials: true`) to `/rpc` and `/api/auth`, lets Better Auth accept sign-ins (otherwise `403 INVALID_ORIGIN`) and lets the live WebSocket open (otherwise `403`). Dev: `TRUSTED_ORIGINS=http://localhost:3000,http://localhost:5173 archlast-forge dev` (setting it replaces the default `http://localhost:<port>`, so keep that one). A production `compose.yaml` passes only the variables it lists: add the origin to the app's `environment`.
- Sessions are `SameSite=Lax` cookies: subdomains of one site work (`app.` and `api.example.com`); a different site does not get the cookie on `fetch` or the WebSocket handshake, so proxy instead.
- Preflights allow only `content-type, authorization, x-request-id` request headers: a custom header from the `headers` option fails in a browser. `/http/*` routes get no CORS headers from the engine (the route answers its own `OPTIONS`).
- Outside a browser (Node, Bun, React Native) there is no `location`, so `url` is required.

## The core client

```ts
import { ArchlastForgeClient } from "@archlast/forge-client";
import { api } from "../forge/_generated/api";

const client = new ArchlastForgeClient({ url: "https://app.example.com" });
const lists = await client.query(api.lists.all); // one-off read, not live
const id = await client.mutation(api.lists.create, { name: "Groceries" });
await client.action(api.billing.sync, { customerId });
const stop = client.watch(api.lists.all, {}, (u) => {
  // live query; returns an unsubscribe function
  if ("value" in u) console.log(u.value);
  else console.error(u.error, u.requestId); // { error, data?, requestId? }
});
```

Constructor options (all optional): `url`; `WebSocket` (constructor to use instead of the global); `headers: () => Record<string,string> | undefined | Promise<...>` (added to **every call** and the socket handshake, asked each time so a changing session is picked up; for clients without cookies); `authPlugins` (Better Auth client plugins, e.g. `expoClient`). Creating a client does no network I/O.

Other members: `auth` (the Better Auth client, created lazily), `onSessionChange(listener)` (user or `null`; fires only once something has used `auth`), `reconnect()` (new socket now, re-subscribes everything), `close()` (stops every watch and the socket for good, HTTP calls still work), `uploadFile(generateUploadUrl, file)`.

- Arguments may be omitted when a function takes none. Identical `(function, args)` watches share one server subscription (args are compared as `JSON.stringify`, so key order matters); a late listener gets the latest value at once.
- A failing live query is an **update** (`{ error }`), not an exception; the subscription stays and a later good run delivers `value`. A refused subscription (unknown query, more than 200 per connection) delivers one error update and ends.
- Connection: the socket opens with the first watch; a drop reconnects with backoff (about 0.25 s doubling to 10 s, jittered) and every subscription's first message is a fresh result; watchers keep their last value meanwhile. There is no offline queue and no connection-state API: a call made offline rejects with the browser's `TypeError`.
- Arguments are validated on the server with the same rules as a call.

### Errors

A failed call rejects:

```ts
import { ForgeError } from "@archlast/forge-client";
try {
  await client.mutation(api.messages.send, { body });
} catch (e) {
  if (e instanceof ForgeError)
    showToast(String(e.data)); // the function threw ForgeError(data): e.data is that value
  else
    console.error(
      (e as Error).message,
      (e as { code?: string; requestId?: string }).requestId,
    );
}
```

Anything else is an `Error` with `.code` (`BAD_REQUEST` for validation like `args.body must be a string, got 5`, `NOT_FOUND` for an unknown or internal function, `TIMEOUT`, `SERVICE_UNAVAILABLE`, `INTERNAL_SERVER_ERROR`, `TOO_MANY_REQUESTS` with `retryAfter` in seconds) and `.requestId`. Outside dev a non-`ForgeError` server failure has the generic message `Server error (request <id>)`. Show `ForgeError` text to users; log `requestId`.

### Outside a browser

Needs `fetch` and `WebSocket` (Bun, Deno, Node 22+). No cookie jar: calls are anonymous unless you pass `headers: () => ({ cookie })` (the `set-cookie` of a sign-in response) or, with Better Auth's `bearer()` plugin, ``({ authorization: `Bearer ${token}` })``. For live queries as a user the socket needs the header too: the client opens it as `new WebSocket(url, undefined, { headers })` (React Native's form). **Bun's `WebSocket` ignores that form** (the live query ran anonymous); pass a subclass:

```ts
class AuthedSocket extends WebSocket {
  constructor(url: string | URL) {
    super(url, { headers: { cookie } } as never); // Bun's own option
  }
}
const client = new ArchlastForgeClient({
  url,
  headers: () => ({ cookie }),
  WebSocket: AuthedSocket,
});
```

## React

```tsx
import {
  ArchlastForgeClient,
  ArchlastForgeProvider,
} from "@archlast/forge-react";

const client = new ArchlastForgeClient(); // one client, created once, outside components
createRoot(document.getElementById("root")!).render(
  <ArchlastForgeProvider client={client}>
    <App />
  </ArchlastForgeProvider>,
);
```

The provider also supplies a TanStack `QueryClient` (pass `queryClient` to use your own); `useArchlastForge()` returns the client.

```tsx
const todos = useQuery(api.todos.listByList, { listId }); // undefined until loaded, then live
const count = useQuery(api.todos.count); // no args
const maybe = useQuery(api.todos.listByList, listId ? { listId } : "skip");
```

- `undefined` = loading (check `=== undefined`: `null` and `[]` are valid results). New args (compared by value) subscribe to the new query and release the old one; unmount releases it. Errors throw to the nearest error boundary (a `ForgeError` or an `Error` with `requestId`): wrap routes in one.
- **Growing list** (`loadMore(n)` widens one live window, so every loaded item stays live; cost grows with the window). Needs a query taking `paginationOpts` and returning `.paginate(paginationOpts)`:

```tsx
const { results, status, isLoading, loadMore } = usePaginatedQuery(
  api.messages.list,
  {},
  { initialNumItems: 30 },
);
// status: "LoadingFirstPage" | "CanLoadMore" | "LoadingMore" | "Exhausted"
{
  status === "CanLoadMore" && (
    <button onClick={() => loadMore(30)}>More</button>
  );
}
```

- **Numbered pages** (the database skips to the page and counts the range; keep the page number in state or the URL; a page below 1 throws):

```tsx
const [page, setPage] = useState(1);
const { results, total, pageCount, hasNextPage, isLoading } = useNumberedPage(
  api.patients.list,
  {},
  { page, pageSize: 20 },
);
```

Both accept `"skip"` in place of args; new args reset the window; the previous results stay on screen while the next load. `total`/`pageCount` are `undefined` until the first result.

- **Mutations and optimistic updates.** `useMutation(ref)` returns an async function (rejects like `client.mutation`). `.withOptimisticUpdate(update)` returns a function you call the same way; `update(store, args)` changes the local copy of live results at once, restores it if the mutation fails, and the server's live result replaces your guess either way. `store.getQuery(ref, args)` returns `undefined` for a query that is not loaded: guard. Use the same function and args as the `useQuery` you want to change. Not offered for paginated hooks; not for creates that need the server's id.

```tsx
const toggle = useMutation(api.todos.toggle).withOptimisticUpdate(
  (store, { todoId }) => {
    const current = store.getQuery(api.todos.listByList, { listId });
    if (current)
      store.setQuery(
        api.todos.listByList,
        { listId },
        current.map((t) => (t._id === todoId ? { ...t, done: !t.done } : t)),
      );
  },
);
```

- `useAction(ref)` returns `(args) => Promise<result>`. `useUploadFile` is below.
- Live results live in the TanStack cache under `queryKey(ref, args)` (`["archlast-forge", "<module>:<fn>", args]`); `syncQuery(queryClient, client, ref, args)` mirrors a watch into a `QueryClient` and returns the unsubscribe. `useQuery` never makes TanStack fetch: do not run TanStack's own `useQuery` on the same key.
- Without the framework there is no server rendering: `useQuery` is `undefined` on a server render because subscriptions start in effects.

## Vue

```ts
// main.ts
import { ArchlastForgeClient, archlastForge } from "@archlast/forge-vue";
createApp(App).use(archlastForge(new ArchlastForgeClient())).mount("#app");
```

```vue
<script setup lang="ts">
import { ref } from "vue";
import {
  ForgeError,
  pageArgs,
  useMutation,
  useQuery,
  useSession,
} from "@archlast/forge-vue";
import { api } from "../forge/_generated/api";

const { data: messages, error, isLoading } = useQuery(api.messages.recent); // three refs; isLoading true until the first result or error
const send = useMutation(api.messages.send); // plain function
const term = ref("");
const { data: found } = useQuery(api.messages.search, () =>
  term.value ? { text: term.value } : "skip",
); // getter: re-subscribes when it changes
const page = ref(1);
const { data: rows } = useQuery(api.patients.list, () =>
  pageArgs({}, page.value, 20),
); // rows.value.page, .total, .isDone
const session = useSession(); // ref: session.value.data?.user
</script>
```

`useQuery(ref, args?)` args may be an object, a ref, a getter or `"skip"`; it stops with the component or effect scope. A failing query sets `error` and keeps the last `data`. Growing list: `useQuery(api.messages.list, () => windowArgs({}, size.value))` and raise `size`. There is no optimistic update and no upload hook: `useArchlastForge().uploadFile(...)`. `useArchlastForge()` throws until `app.use(archlastForge(client))` ran.

## Svelte

```svelte
<script lang="ts">
  import { ArchlastForgeClient, query, session } from "@archlast/forge-svelte";
  import { api } from "../forge/_generated/api";

  const client = new ArchlastForgeClient(); // share one across components (module)
  const messages = query(client, api.messages.recent); // $messages.data / .error / .isLoading
  const me = session(client); // $me.data?.user
  async function send(body: string) {
    await client.mutation(api.messages.send, { body }); // no wrappers: call the client
  }
</script>
```

Arguments are **fixed per store**: for different arguments make a new store (e.g. in a `$:` statement or keyed block). The subscription opens with the first subscriber and closes with the last. Pagination: `query(client, api.patients.list, pageArgs({}, page, 20))` (`$rows.data.total`) or `windowArgs`. No optimistic updates; upload with `client.uploadFile`.

## Auth from a client

- React `useAuth()`, Vue `useArchlastForge().auth`, anywhere `client.auth`: the Better Auth client. `signIn.email({ email, password })`, `signUp.email({ email, password, name })`, `signOut()`; every method returns `{ data, error }` instead of throwing (`error?.message` for the form). Plugins/social providers are configured in the backend's `forge/auth.ts`.
- Session state: React `useSession()` -> `{ data: { user: { id, email, name }, session } | null, isPending, error, refetch }` (pending during hydration); Vue `useSession()` ref; Svelte `session(client)` store; `client.onSessionChange(cb)`.
- Cookies reach the WebSocket only on its handshake, so the client **reconnects the socket when the session id changes**, making live queries run as the new user. This only runs once `client.auth` has been used; if you sign in with your own `fetch`, call `client.reconnect()` yourself.
- Secure data in functions (`ctx.auth.getUserIdentity()`), not by hiding UI.

## File upload from a client

Two steps; the bytes go straight to storage. The backend needs a mutation `generateUploadUrl` with `args: { contentType: v.optional(v.string()) }` returning `ctx.storage.generateUploadUrl(args)` (`{ uploadUrl, storageId }`; the S3 template includes `forge/files.ts` with it and a `url` query).

```tsx
const upload = useUploadFile(api.files.generateUploadUrl); // vanilla/Vue/Svelte: client.uploadFile(api.files.generateUploadUrl, file)
const attach = useMutation(api.todos.attach);

async function pick(file: File) {
  const storageId = await upload(file); // PUT with the file's content type, resolves to the new `_storage` id
  await attach({ todoId, storageId }); // save it with a normal mutation, or the file stays orphaned
}
```

Show a file through a query that returns `await ctx.storage.getUrl(id)` (a signed URL, valid about an hour) and render `<img src={url}>`. A failed `PUT` throws `Upload failed (<status>)`. The browser must be able to reach the storage address (`S3_PUBLIC_ENDPOINT` on the backend) and an S3 bucket needs CORS allowing `PUT` from your origin. The server does not check size or type: validate in the UI and enforce hard limits at the bucket or proxy.

## Mobile (Expo)

`bun create archlast-forge acme --mode backend --mobile` (also with `--mode framework`; implies `--monorepo`) or `archlast-forge add mobile` writes `apps/mobile` (Expo), a client of the main app (`apps/api` or `apps/web`), and gives that app Better Auth's Expo plugin: `forge/auth.ts` becomes `defineAuth({ emailAndPassword: { enabled: true }, plugins: [expo()], trustedOrigins: ["acme://"] })` (an existing `auth.ts` is left alone and you are told what to add). Run `bun run dev` for the backend and `expo start`.

```ts
// apps/mobile/src/client.ts
import { ArchlastForgeClient } from "@archlast/forge-react";
import { anyApi } from "@archlast/forge-runtime";
import { expoClient } from "@better-auth/expo/client";
import type { apiApi } from "@acme/api"; // type-only: the app never bundles backend code
import * as SecureStore from "expo-secure-store";
import { AppState } from "react-native";

export const api = anyApi as unknown as typeof apiApi;
const url = process.env.EXPO_PUBLIC_API_URL ?? "http://localhost:3000";

export const client: ArchlastForgeClient = new ArchlastForgeClient({
  url,
  authPlugins: [
    expoClient({ scheme: "acme", storagePrefix: "acme", storage: SecureStore }),
  ],
  headers: () => {
    const cookie = (
      client.auth as unknown as { getCookie(): string }
    ).getCookie();
    return cookie ? { cookie } : undefined; // the session from secure storage, on every call and the socket
  },
});
AppState.addEventListener(
  "change",
  (state) => state === "active" && client.reconnect(),
); // sockets die in the background
```

- Wrap the app in `<ArchlastForgeProvider client={client}>` and use the same hooks as on the web (`usePaginatedQuery`, `useMutation`, `useSession`; `client.auth.signIn.email(...)` / `signOut()`). Use `FlatList` etc. for UI.
- `EXPO_PUBLIC_API_URL` (inlined when bundling): simulator `http://localhost:3000`; a phone in dev your computer's LAN address (`http://192.168.1.20:3000`, `localhost` is the phone); a build the deployed `https://` backend (EAS: `eas env:create`). The package `@acme/api` (`packages/api`) exports `<mainApp>Api` (`apiApi` for `apps/api`, `webApi` for `apps/web`).
- Keep `@better-auth/expo` at the same version as `better-auth` (the templates pin `1.7.12`).
- Nothing is stored offline: screens keep the last data while the connection is down, calls reject and nothing is queued. The template was tested against a real engine with a header-capable WebSocket, not run on a device here.

## Desktop (Tauri)

`--desktop full|client` or `archlast-forge add desktop full|client` writes `apps/desktop` (implies `--monorepo`; needs Rust and the platform webview libraries). `bun run dev` runs `tauri dev`, `bun run build` makes an installer; run `bunx tauri icon your-icon.png` once (the icons are placeholders).

- **`full`** (main app must be a full-stack app): Tauri starts Bun as a sidecar running `engine/desktop-engine.ts`, which starts the engine (`start --no-docker`) in production on a free port of `127.0.0.1`, data and a secret in the app's data folder; the window opens on it once it answers. The UI is the full-stack app's own pages (`apps/web/app`, see [fullstack.md](fullstack.md)); nothing to deploy, each user owns their data. `scripts/bundle-engine.ts` prepares the bundle (Bun is about 90 MB, so installers are hundreds of MB).
- **`client`** (either main app): `src/main.tsx` is a React page using `ArchlastForgeClient({ url: FORGE_URL })` (`window.FORGE_URL` from `config.js`, default `http://localhost:3000`) typed with `import type { webApi } from "@acme/api"` over `anyApi`, like mobile. Build against the deployed backend: `FORGE_URL=https://api.example.com bun run build` (the script refuses to run without it).
- The backend must trust the app's origin: `TRUSTED_ORIGINS` gets `tauri://localhost` (macOS, Linux) and `http://tauri.localhost` (Windows); in `tauri dev` the page is served from `http://localhost:5174`, so also trust that one (the engine gives an untrusted origin no CORS headers and a 403 on the WebSocket).
- The template has no sign-in: to sign in, add Better Auth's `bearer()` plugin on the backend and pass ``headers: () => ({ authorization: `Bearer ${token}` })``. Tauri was not built or run here; only the scaffold and the full-mode engine starter were tested.

## Common mistakes

1. Importing from `forge/` anything but `forge/_generated` in the frontend (codegen fails), or passing an `internal.*` reference (type error).
2. Cross-origin frontend without `TRUSTED_ORIGINS` (CORS block, `INVALID_ORIGIN`, WebSocket 403), or listing it only in `forge/auth.ts` (passes Better Auth but gives no CORS headers). A different site also loses the `SameSite=Lax` cookie: proxy.
3. Setting `url` in the browser behind a proxy (breaks same-origin cookies), or leaving it out in Node, Bun or React Native (no `location`).
4. Assuming `client.query/mutation` are signed in outside a browser: pass `headers`; and for live queries in Bun use a `WebSocket` subclass (the `headers` option's socket form is React Native's).
5. Treating `undefined` from `useQuery` as "empty" or "error": it means loading. Errors throw to an error boundary; with `watch` they arrive as `{ error }`.
6. Creating the client inside a component (a new socket per render): create it once. In Svelte, passing changing arguments to one `query` store.
7. Calling `signIn` through your own `fetch` and expecting live queries to switch user: use `client.auth` (or call `client.reconnect()`).
8. Optimistic updates keyed with different args than the page's `useQuery`, unguarded `getQuery`, or on paginated hooks.
9. Mutating or sorting a query result in place; shadowing TanStack's `useQuery` with forge's (they are different hooks; do not run TanStack's against a forge key).
10. Forgetting `import type` for the `@acme/api` types in mobile and desktop (it would bundle backend code), or putting a custom header through the `headers` option for a cross-origin browser client (preflight fails).
11. Uploading without saving the `storageId` afterwards, or without the storage's CORS/`S3_PUBLIC_ENDPOINT` set.
12. Pointing the Expo app at `localhost` from a phone, or forgetting `expo()` and `trustedOrigins: ["<scheme>://"]` in the backend's `forge/auth.ts`.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                          | Read it for                                                     |
| ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| [clients](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/clients.mdx)     | the client library, the bindings and the wire protocol in depth |
| [mobile](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/mobile.mdx)       | the Expo template                                               |
| [desktop](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/desktop.mdx)     | the Tauri template                                              |
| [auth](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/auth.mdx)           | sign-in from a client                                           |
| [reference](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/reference.mdx) | client and hook signatures                                      |
