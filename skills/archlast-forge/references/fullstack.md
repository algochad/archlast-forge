# Full-stack apps: app/, routes, loaders, live queries, hydration

Read this when you create or edit anything under `app/` (pages, layouts, `root.tsx`, styles) in a project whose `archlast-forge.json` says `"mode": "framework"`.
The backend half (`forge/`: schema, functions, auth config, Nest) is in the other references; a separate SPA, mobile or desktop client is in [clients.md](clients.md).

## How it works (the model to keep in your head)

- One process: the engine serves the API and, for every `GET`/`HEAD` it does not own, hands the request to the app. The app runs the matched route **loaders**, renders React on the server (the whole page is awaited, no streaming), sends HTML plus `window.__FORGE__` (viewer, seeded query cache, loader data, server `now` and `timeZone`), and the browser hydrates the **whole document** (`<html>` included).
- Routing is React Router's data router, imported **only** from `@archlast/forge-framework`. Routes are files in `app/routes`.
- Reads: a query in `forge/` is read with `useQuery` in a component; the route `loader` seeds it with `ctx.query(...)` so the first HTML has the data; afterwards it is live over a WebSocket.
- Writes: `useMutation`/`useAction` called from event handlers. **There are no route actions, no `<Form>`, no `useFetcher`**; a `POST` to a page URL is a plain 404.
- Everything in `app/` ships to the browser. Server-only logic, secrets and server-only packages belong in `forge/`.

## Layout and what not to edit

```
app/
  root.tsx          <html> Layout, chrome (header/footer + <Outlet />), ErrorBoundary
  styles.css        imported by root.tsx; one CSS file for the whole app
  env.d.ts          declare module "*.css" / "*.svg" / "*.png" (add more types you import)
  routes/           one file per page
  components/ui/    shadcn only (button, card, input, label, avatar) + components/theme-toggle.tsx
  lib/utils.ts      shadcn only: `cn`
forge/              backend; forge/_generated/ (api, internal, dataModel) is committed
public/             served as is at the root (/favicon.svg, /robots.txt)
.forge/             generated entry files and build output (gitignored)
components.json     shadcn only; its presence means the project uses shadcn/ui
archlast-forge.json { "mode": "framework", "services": [...] }
```

Do not edit: `.forge/**` (rewritten on every build), `forge/_generated/**` (written by `bun run codegen`; commit it, never hand-edit), the `mode` in `archlast-forge.json`, and `compose.yaml` / `Dockerfile` / `.env` unless the task is about deployment (`.env` holds secrets, git-ignored). `app/components/ui/*` are yours after `bunx shadcn@latest add`, but adding the same component again overwrites it.

`app/` may import from `forge/_generated` and from nothing else in `forge/`; `codegen`, `dev` and `build` fail naming the file:

```
✗ Frontend code must import only forge/_generated (and not Forge RPC, which is for backends):
  app/routes/teapot.tsx imports "../../forge/posts"
```

## Where to import from

- `@archlast/forge-framework`: `Link NavLink Navigate Outlet redirect data isRouteErrorResponse useLoaderData useRouteLoaderData useMatches useParams useLocation useNavigate useNavigation useRevalidator useRouteError useSearchParams useViewer useNow useTimeZone`, the types `LoaderArgs LoaderContext Viewer RouteModule` (with `import type`), and `DefaultLayout DefaultErrorBoundary`.
- `@archlast/forge-react`: `useQuery usePaginatedQuery useNumberedPage useMutation useAction useUploadFile useAuth useSession ForgeError windowArgs pageArgs`.
- `api`, `Doc`, `Id`: relative path to `forge/_generated/api` and `forge/_generated/dataModel` (the `@/` alias points at `app/`, not at `forge/`).

Not exported, do not use: `Form`, `useFetcher`, `useActionData`, `useSubmit`, `Await`, `ScrollRestoration`, route `action`. Never import `react-router` directly: the production image supplies one copy and a second one does not share context.

The `api` path depends on depth: `app/routes/x.tsx` is `../../forge/_generated/api`, `app/routes/blog/[slug].tsx` is `../../../forge/_generated/api`.

## Routes

Every `.tsx/.ts/.jsx/.js` file under `app/routes` is a page; its path is its name.

| File                                                             | URL                                                          |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `index.tsx`                                                      | `/`                                                          |
| `about.tsx`, `blog/index.tsx`                                    | `/about`, `/blog`                                            |
| `blog/[slug].tsx`                                                | `/blog/hello`, `params.slug`                                 |
| `users/[id]/posts.tsx`                                           | `/users/7/posts`, `params.id`                                |
| `docs/[...path].tsx`                                             | `/docs/a/b/c`, `params["*"] === "a/b/c"` (a file only)       |
| `blog/_layout.tsx`                                               | layout around everything under `/blog`; renders `<Outlet />` |
| `(app)/_layout.tsx`                                              | layout that adds nothing to the URL (guards, shared chrome)  |
| `(marketing)/pricing.tsx`                                        | `/pricing`; `(group)` folders only organize files            |
| `_components/`, `_helpers.ts`, `*.test.tsx`, `*.d.ts`, `.hidden` | not routes (anything starting with `_` or `.` is yours)      |

- Route id = path under `app/` without extension (`routes/blog/[slug]`, `routes/(app)/_layout`, root is `root`); you need it for `useRouteLoaderData("routes/blog/_layout")`.
- A `_layout.tsx` wraps its folder; folders nest. A `_layout.tsx` directly in `app/routes/` is silently ignored (the root chrome is `app/root.tsx`).
- Bad names fail the build with the file named: `post-[id].tsx` (dynamic part mixed with text), spaces or characters outside letters/digits/`- _ . ~`, `[...rest]/` as a folder, two files answering one URL (`about.tsx` + `(g)/about.tsx`, `a.tsx` + `a/index.tsx`, `[id].tsx` + `[slug].tsx` at one level), no `routes` folder.
- A missing URL renders the nearest `ErrorBoundary` with status 404. These first path segments belong to the engine and are unreachable as routes: `/rpc /api/auth /http /_app /_admin /_dashboard /_storage /_cli /health /ready /metrics` (and `/_api` when API docs are on).

## Route module exports

| Export               | Purpose                                                                                                                       |
| -------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `default`            | the page component (without it the route renders only `<Outlet />`)                                                           |
| `loader`             | runs before render: on the server for the first request, in the browser on later navigations; gets `{ request, params, ctx }` |
| `ErrorBoundary`      | shown when this route's loader or render fails, or a child's does and has none                                                |
| `handle`             | passed through; read with `useMatches()` (breadcrumbs)                                                                        |
| `shouldRevalidate`   | decides whether the loader reruns after a navigation or `revalidate()`                                                        |
| `Layout` (root only) | the `<html>` document; also wraps the error page, so it must not read loader data                                             |

Other exports (`action`, `meta`, `links`, ...) are ignored without a warning.

### `app/root.tsx`

```tsx
import {
  isRouteErrorResponse,
  Link,
  Outlet,
  useRouteError,
} from "@archlast/forge-framework";
import type { ReactNode } from "react";
import "./styles.css";

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
      </head>
      <body>{children}</body>
    </html>
  );
}

export default function Root() {
  return (
    <>
      <header>
        <Link to="/">Home</Link>
      </header>
      <Outlet />
    </>
  );
}

// Replaces the default export when nothing nearer caught the error, so include the chrome here too if you want it on error pages.
export function ErrorBoundary() {
  const error = useRouteError();
  const status = isRouteErrorResponse(error) ? error.status : 500;
  return (
    <main>
      <h1>{status}</h1>
    </main>
  );
}
```

Without `root.tsx` (or without `Layout`) the framework uses `DefaultLayout` (`<html lang="en">`, charset, viewport) and `DefaultErrorBoundary`.

## Loaders

```tsx
// app/routes/blog/[slug].tsx
import {
  data,
  redirect,
  useLoaderData,
  type LoaderArgs,
} from "@archlast/forge-framework";
import { useQuery } from "@archlast/forge-react";
import { api } from "../../../forge/_generated/api";

export const loader = async ({ request, params, ctx }: LoaderArgs) => {
  if (!(await ctx.viewer())) throw redirect("/sign-in");
  const post = await ctx.query(api.posts.bySlug, { slug: params.slug! });
  if (!post) throw data(`No post called "${params.slug}"`, { status: 404 });
  return { slug: params.slug! };
};

export default function Post() {
  const { slug } = useLoaderData<typeof loader>();
  const post = useQuery(api.posts.bySlug, { slug }); // seeded by the loader: present on the first render
  if (!post) return null;
  return (
    <article>
      <title>{post.title}</title>
      <h1>{post.title}</h1>
    </article>
  );
}
```

- `params` values are `string | undefined`. Search params: `new URL(request.url).searchParams`.
- `ctx.query(api.x.y, args?)` runs a **public query** as the visitor, returns the result and stores it in the live cache under the key `useQuery` reads. Internal functions are rejected by the types. Loaders only read: never call mutations from them.
- `ctx.viewer()` returns `{ userId, email, name } | null` (right even just after a sign-in or sign-out).
- `throw redirect("/x")` (302 on the first request, client navigation afterwards; `redirect(url, 303)` picks the status). `throw data(x, { status })` renders the nearest `ErrorBoundary`; `useRouteError()` + `isRouteErrorResponse(error)` give `error.status` and `error.data`. Any other throw is a 500; outside dev the message becomes `Server error (request <id>)` (a `ForgeError`'s message is kept).
- The same function runs in the browser, so: no secrets, `process.env` has only `NODE_ENV`, no server-only imports. A loader redirect is a convenience; **authorization belongs in the function** (`ctx.auth.getUserIdentity()`). All matched loaders run in parallel: a child's loader still runs when the layout's redirects.
- Return JSON-safe values (strings, numbers, booleans, plain objects, arrays, `null`). See "Hydration" for why `Date`, `Map` and `undefined` are bugs. Return `null` rather than nothing.
- Seed only what the first screen needs: the cache goes into the page twice (HTML and `window.__FORGE__`).
- Rerun rules: a loader reruns when its params or search params change or after `revalidate()`. Because seeded queries are live you rarely need to revalidate. Skip reruns that only change `?q=`:

```tsx
import { useRevalidator, type RouteModule } from "@archlast/forge-framework";

export const shouldRevalidate: RouteModule["shouldRevalidate"] = ({
  currentUrl,
  nextUrl,
  defaultShouldRevalidate,
}) =>
  currentUrl.pathname === nextUrl.pathname ? false : defaultShouldRevalidate;
// const { revalidate, state } = useRevalidator();   state: "idle" | "loading"
```

## Live queries in components

```tsx
const messages = useQuery(api.messages.recent); // undefined until the first result, then live
const hits = useQuery(api.notes.search, term ? { text: term } : "skip"); // "skip": no subscription, returns undefined
```

- `undefined` means loading (a query may legitimately return `null` or `[]`): handle it (`?? []`, a skeleton). Do not sort or reverse `results` in place; copy first.
- **Seeding rule: the loader must call `ctx.query` with the same function and structurally equal arguments as the component's `useQuery`** (property order is irrelevant; omitted args equal `{}`). Different keys do not break anything, the component just starts with `undefined`.
- Errors thrown by a query go to the nearest `ErrorBoundary`.
- Infinite list (one growing live window, every loaded item stays live; `loadMore` widens it, so do not load thousands). The loader seeds `paginationOpts: { numItems: N, cursor: null }`:

```tsx
export const loader = async ({ ctx }: LoaderArgs) => {
  await ctx.query(api.messages.list, {
    paginationOpts: { numItems: 30, cursor: null },
  });
  return null;
};
// component
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

- Numbered pages ("page 3 of 10"). `pageArgs({}, page, 20)` builds exactly what `useNumberedPage` asks for (`windowArgs({}, 30)` is the equivalent for `usePaginatedQuery`), so a page read from the URL renders on the server:

```tsx
import { pageArgs, useNumberedPage } from "@archlast/forge-react";

export const loader = async ({ request, ctx }: LoaderArgs) => {
  const page = Math.max(
    1,
    Math.floor(Number(new URL(request.url).searchParams.get("page"))) || 1,
  ); // pageArgs throws on a non-integer
  await ctx.query(api.patients.list, pageArgs({}, page, 20));
  return { page };
};
export default function Patients() {
  const { page } = useLoaderData<typeof loader>();
  const { results, total, pageCount, hasNextPage, isLoading } = useNumberedPage(
    api.patients.list,
    {},
    { page, pageSize: 20 },
  );
  // <Link to={`?page=${page + 1}`}>Next</Link> reruns the loader (search params changed) and the page follows
}
```

Both paginated hooks need a query that takes `paginationOpts` and returns `.paginate(paginationOpts)`. Call them directly in the component, as above: no `usePaginatedTasks` wrapper, no local `items`/`hasMore`/`page` state, no `useEffect` that fetches the next page. `results`, `status`, `loadMore`, `total`, `pageCount` and `hasNextPage` are everything a list needs.

## Better Auth client plugins (`authPlugins`)

A plugin's browser half (`organizationClient()`, `oauthProviderClient()`, `twoFactorClient()`, …) is exported from `app/root.tsx`; the framework gives it to the auth client on the server render and in the browser. Name it for typed methods:

```tsx
// app/root.tsx
import { organizationClient } from "better-auth/client/plugins";
export const authPlugins = [organizationClient()];

// a page
import { useAuth } from "@archlast/forge-react";
import type { authPlugins } from "../root";
const auth = useAuth<typeof authPlugins>(); // auth.organization.create(...), auth.organization.setActive(...)
```

Their packages go in the root `package.json` (browser code) at the engine's Better Auth version. Call these methods directly; do not wrap them or write `fetch` calls to `/api/auth/...` by hand. Details: [auth-plugins.md](auth-plugins.md).

## Mutations, forms, uploads

```tsx
const add = useMutation(api.tasks.add);

async function submit(e: FormEvent<HTMLFormElement>) {
  e.preventDefault();
  try {
    await add({ title });
    setTitle("");
  } catch (err) {
    setError(
      err instanceof ForgeError ? String(err.data) : "Couldn't save that",
    );
  }
}
// <form onSubmit={submit}>
```

- Plain controlled forms with `onSubmit`; nothing to revalidate afterwards, live queries update the screen. Navigate after creating with `await navigate(`/notes/${id}`)`.
- A failed call rejects: `ForgeError` (the function threw it; `.data` is its payload) or an `Error` (validation, server, rate limit) that carries `.code` and `.requestId`.
- Optimistic update: the cache is changed at once, restored if the mutation fails, and replaced by the live result either way. `getQuery`/`setQuery` take the same function and args as the page's `useQuery`; guard against `undefined`. Not for `usePaginatedQuery` lists; not for creates that need the new id.

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

- `useAction(api.x.y)` calls an action. File upload: `const upload = useUploadFile(api.files.generateUploadUrl); const storageId = await upload(file);` (the mutation must take `{ contentType?: string }` and return `ctx.storage.generateUploadUrl(args)`), then save `storageId` with another mutation and show it through a query that returns `ctx.storage.getUrl(id)`.

## Hydration: the browser's first render must equal the server's HTML

If the two differ, React discards the server HTML and re-renders (dev: a notice in the corner of the page and a console message naming the component; production: `Minified React error #418`). Focus, selection and typed text are lost. The server renders in its own time zone (UTC in a container) at its own moment; the browser hydrates seconds later in the visitor's zone.

| Do not (in render)                                                                     | Do instead                                                                                                          |
| -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `new Date(ts).toLocaleString()`, any default-zone formatting                           | `new Intl.DateTimeFormat("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: useTimeZone() }).format(ts)` |
| `Date.now()`, `new Date()` ("3 hours ago", day counts)                                 | `const now = useNow()` (ms, rounded to the minute, re-renders when it turns; `useNow(1000)` for a ticking clock)    |
| `useQuery(ref, { from: Date.now() - DAY })` (key differs, so no data on hydration)     | compute it in the loader, `ctx.query` with it, `return { from }`, read it with `useLoaderData`                      |
| a loader returning `Date`, `Map`, `Set`, class instances or `undefined` fields         | return numbers, ISO strings, plain objects, `null`                                                                  |
| `typeof window`, `localStorage`, `matchMedia`, `Math.random()` choosing what to render | read them in `useEffect` into state (render the server's version first); `useId()` for ids                          |
| `useSession()` to know who is signed in in the HTML                                    | `useViewer()` (rendered on the server); `useSession()` is `isPending` there                                         |
| `suppressHydrationWarning` as a fix                                                    | it hides the warning and keeps the server's wrong text; it only fits the `<html>` theme-class script                |

- The loader's result reaches the browser as JSON but the **server renders from the raw returned object**, so a `Date` is `Thu Jan 01 ...` in the HTML and an ISO string in the browser's render. That is why loaders must return JSON-safe values.
- `useTimeZone()` returns the IANA name (`"Asia/Manila"`); always pass a locale to `Intl` too. On the first call the browser sets the `forge-tz` cookie so later server renders use the visitor's zone; the very first visit renders UTC, then switches after hydration (an ordinary update, not an error).
- Both hooks need no provider, and return the server's values only while hydrating. Keep dates in the database as timestamps and format in the component.

## Auth and the viewer

- `useViewer()` gives `Viewer | null` (`{ userId, email, name }`); it is in the server HTML and follows sign-in/out with no reload. Note `userId` here, while `useSession().data.user` has `id`.
- Sign in with the Better Auth client from `useAuth()`, then navigate (the next loader sees the session). Every method returns `{ data, error }`:

```tsx
const auth = useAuth();
const navigate = useNavigate();
const res = await auth.signIn.email({ email, password }); // sign-up: auth.signUp.email({ email, password, name })
if (res.error) return setError(res.error.message ?? "That didn't work");
await navigate(next);
// sign out: await auth.signOut(); await navigate("/");
```

- If the sign-in page takes `?next=`, accept only same-site paths: `next.startsWith("/") && !next.startsWith("//")`. Redirect a signed-in visitor away in the sign-in `loader` (`if (await ctx.viewer()) throw redirect(...)`).
- Guard a section with a pathless layout (`app/routes/(app)/_layout.tsx`):

```tsx
export const loader = async ({ ctx, request }: LoaderArgs) => {
  if (!(await ctx.viewer())) {
    const here = new URL(request.url);
    throw redirect(
      `/sign-in?next=${encodeURIComponent(here.pathname + here.search)}`,
    );
  }
  return null;
};
export default function SignedIn() {
  return <Outlet />;
}
```

- Providers, email verification, social sign-in are configured in `forge/auth.ts`, not in `app/`. Cookies are `HttpOnly`; pages only ever see the viewer.

## Navigation and head

- `Link`/`NavLink` navigate in the browser (`NavLink` sets `class="active"` and `aria-current="page"`; pass `end` on `/`; its `className` may be a function of `{ isActive }`). `useNavigate()` returns `(to, { replace })` as a promise that settles when loaders finish. `useNavigation().state` is `"idle" | "loading"` for pending UI. `useSearchParams()` reads/sets the query string (`setParams({ q }, { replace: true })`). `<Navigate to="/sign-in" replace />` redirects during render.
- No prefetch on hover and no scroll restoration (call `window.scrollTo(0, 0)` in an effect keyed on `useLocation().pathname` if needed).
- Render `<title>`, `<meta>`, `<link>` inside a page or layout and React 19 hoists them to `<head>` (server-rendered, so crawlers see them). Give **every page its own `<title>`**; a `<title>` in `root.tsx` or a layout is not a default that pages override, the document gets two.

## Styling: plain vs shadcn/ui

Detect with `components.json` (shadcn) and `app/components/ui/`.

- **shadcn/ui (the default of `bun create`)**: Tailwind CSS v4 through `bun-plugin-tailwind` (the build loads it from the project), base style `base-nova` on Base UI. Write Tailwind classes and use `@/components/ui/{button,card,input,label,avatar}` and `cn` from `@/lib/utils`; `buttonVariants()` styles a `<Link>` like a button. Add components with `bunx shadcn@latest add dialog`. The theme is the CSS variables in `app/styles.css` (`:root` and `.dark`; edit them rather than hard-coding colors). Dark mode is the `dark` class on `<html>`, set before first paint by a small script in `root.tsx` and toggled by `ThemeToggle` (`localStorage`); keep `suppressHydrationWarning` on `<html>`. The `@/` alias maps to `app/`: reach `forge/_generated` with a relative path.
- **Plain (`--no-shadcn`)**: hand-written `app/styles.css` with CSS variables and classes such as `container`, `btn`, `btn primary`, `card`, `field`. Tailwind is not installed: to add it, `bun add tailwindcss && bun add -d bun-plugin-tailwind` and `@import "tailwindcss";` at the top of the stylesheet.
- Do not mix them: `className="container"` or `btn primary` does nothing in a shadcn app, Tailwind utilities do nothing in a plain one. Copying a snippet written for the other starter is the usual bug.
- All CSS is bundled into one file linked in `<head>` (no per-route CSS, no CSS modules, no PostCSS). `import logo from "./logo.svg"` yields a hashed URL (declare the file type in `app/env.d.ts`). Files in `public/` are served at the root (only for paths with a file extension; cached an hour in production).

## Config files

- `package.json` scripts: `dev`, `build`, `start`, `codegen`, `typecheck` (`archlast-forge codegen && tsc --noEmit`), `up`, `down`, `format`. New projects are formatted with Prettier at 4 spaces; run `bun run format` after edits.
- Dependencies: packages used by `app/` go in the **root** `package.json` `dependencies`; packages used by functions go in `forge/package.json`. In the production image only the root `dependencies` are installed (no `devDependencies`), and `react`, `react-dom` (19.3.x) and `@archlast/forge-*` come from the engine image: do not add other copies.
- `tsconfig.json`: `include: ["app"]`, `jsx: "react-jsx"`, `strict`, `noEmit`, `types: ["bun"]` with `@types/bun` in `devDependencies`, `experimentalDecorators` (both needed because the page's type-check follows the generated API into `forge/`, whose files use `process.env`, `node:` modules and Nest decorators; `archlast-forge upgrade` adds them to older apps that had `types: []`). The types don't make `process.env` or `Bun` safe in pages: code in `app/` still runs in the browser. **`verbatimModuleSyntax` is on: type-only imports must be `import type` or `import { type X }`.** shadcn adds `paths: { "@/*": ["./app/*"] }`. TypeScript 7 rejects `baseUrl`.
- `.forge/gen/` holds `routes.client.ts`, `routes.server.ts` and `entry.client.tsx`, generated from `app/` on every build; `.forge/build/<version>/` is the output. Never edit either.
- After changing anything in `forge/` outside `dev`, run `bun run codegen` so `forge/_generated` (and the types your pages use) are current. `bun run typecheck` does codegen and `tsc`.

## Develop, build, run

- `bun run dev` (`archlast-forge dev`, optional `--port <n>`, `--no-docker` to skip Docker services and use SQLite): engine and app in one process on your machine, `http://localhost:3000`, dashboard at `/_dashboard` (admin key printed). Saving a file in `app/` rebuilds (about 0.2 s) and reloads the browser; a new file in `routes/` is a new page with no restart; a build error shows as an overlay (`Esc` dismisses) and every page answers 500 until fixed. There is no HMR: component state is lost on save. Saving in `forge/` regenerates `_generated`, restarts only the functions and rebuilds the app.
- `bun run build` (`archlast-forge build --no-docker`) writes the production bundles and prints first-load sizes; `bun run start` serves them and reads the build once, so rebuild and restart after changes. It reads `.env` from the current directory (`BETTER_AUTH_SECRET`, `BETTER_AUTH_URL` must be `https://` outside development unless `ALLOW_INSECURE_HTTP=1`, `ADMIN_KEY`).
- `bun run up` / `bun run down`: the Docker stack from `compose.yaml` (needs Docker). Test against it before shipping, since production uses the image's React. A deploy replaces the hashed files: an already-open tab fails on a client navigation to a chunk it has not loaded until reloaded.
- Not supported: streaming, static generation, route actions and `Form`, per-route CSS, HMR, prefetching, `.server` files. Route files render pages inside the root `Layout`: JSON or webhook endpoints go in `forge/http.ts` (served under `/http/*`), static files in `public/`.

## Common mistakes

1. Importing `../../forge/posts` (anything but `forge/_generated`) in `app/`: codegen fails. Use `api` from `_generated` and a query.
2. Using `Form`, `useFetcher`, `useActionData`, route `action`, or importing `react-router`/`react-router-dom`: not available. Use `useMutation` in an `onSubmit`/`onClick` handler and import router APIs from `@archlast/forge-framework`.
3. `new Date(x).toLocaleString()`, `Date.now()` or `new Date()` in render, or an argument built from the clock: hydration mismatch. Use `useTimeZone()`, `useNow()`, or a value computed in the loader.
4. A loader returning a `Date`, `Map`, `Set` or `undefined` field: the server renders the raw value, the browser the JSON copy. Return JSON-safe data.
5. `ctx.query(...)` and `useQuery(...)` with different arguments (or a loader that fetches but the component calls another function): no first-render data. Pagination seeds must be `windowArgs`/`pageArgs` or the exact `paginationOpts` the hook uses.
6. Secrets, `process.env.X`, database drivers or other server-only code in a loader or component: it is bundled for the browser. Put it in a function in `forge/`.
7. Protecting data only with a layout redirect: the child loader still runs and anyone can call `/rpc/...`. Check `ctx.auth.getUserIdentity()` in the function.
8. `useSession()` for server-rendered identity (it is `isPending` on the server) or `viewer.id` (the field is `userId`). Use `useViewer()`.
9. Forgetting the `undefined` first state of `useQuery`, or mutating `results` (`.reverse()`, `.sort()`) in place.
10. Two `<title>`s (root plus page) or none; `className="container"`/`btn` in a shadcn app, Tailwind classes in a plain one.
11. Route file pitfalls: `_layout.tsx` directly in `routes/` (ignored), `[id].tsx` next to `[slug].tsx` (conflict), a page file or folder starting with `_` (not a route), `post-[id].tsx` (rejected), a first segment the engine owns (`/health`, `/http`, `/rpc`, ...).
12. A wrong `../` depth in the `api` import; `import { LoaderArgs }` without `type` (breaks under `verbatimModuleSyntax`).
13. Editing `.forge/gen`, `forge/_generated` or `archlast-forge.json`'s mode; putting app packages in `forge/package.json` or the reverse; adding `react` to `dependencies` at another version.
14. Optimistic updates on a paginated list, or calling a mutation from a loader.
15. Expecting hot reload or a watching `start`: dev reloads the page on save; `start` serves the build it read at startup.

## Full documentation

When this file is not enough, read the page instead of guessing: the docs are the full reference (see "Going deeper" in [SKILL.md](../SKILL.md) for where to fetch a page).

| Page                                                                                                            | Read it for                                                                           |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| [framework](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/framework.mdx)   | the full-stack framework in depth: routes, loaders, hydration, styling, build, NestJS |
| [tutorial](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/tutorial.mdx)     | a full-stack notes app, step by step                                                  |
| [recipes](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/recipes.mdx)       | auth-gated pages, infinite scroll, optimistic updates, uploads                        |
| [reactivity](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/reactivity.mdx) | how live queries behave in components                                                 |
| [clients](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/clients.mdx)       | the React hooks the pages use                                                         |
| [auth](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/auth.mdx)             | sign-in and the viewer                                                                |
