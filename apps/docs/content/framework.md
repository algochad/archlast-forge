# Full-stack apps

A full-stack app is React pages, server rendering and your backend in one project. The engine serves the pages, the API, authentication and the dashboard from one process, so there is one thing to run and one thing to deploy.

```bash
bun create archlast-forge my-app --mode framework
cd my-app && bun install && bun run dev
```

```
app/
  root.tsx              the HTML document, and the header and footer around every page
  routes/
    index.tsx           /
    chat.tsx            /chat
    sign-in.tsx         /sign-in
public/                 served as they are: /favicon.svg, /robots.txt
forge/                  your backend
```

## Routes

Every file in `app/routes` is a page. Its path is its name.

| File | URL |
|---|---|
| `index.tsx` | `/` |
| `about.tsx` | `/about` |
| `blog/index.tsx` | `/blog` |
| `blog/[slug].tsx` | `/blog/hello`, with `params.slug` |
| `docs/[...path].tsx` | `/docs/a/b/c`, with `params["*"]` |
| `blog/_layout.tsx` | wraps everything under `/blog`; renders `<Outlet />` |
| `(app)/_layout.tsx` | a layout that adds nothing to the URL, for grouping |
| `_components/`, `_helpers.ts` | not routes: anything starting with `_` is yours |

A file that mixes a parameter with other text (`post-[id].tsx`) or two files that answer the same URL are build errors with the file names in the message.

A page is a React component:

```tsx
// app/routes/blog/[slug].tsx
import { useLoaderData, type LoaderArgs } from "@archlast/forge-framework";
import { api } from "../../../forge/_generated/api";

export const loader = async ({ params, ctx }: LoaderArgs) => ({
  post: await ctx.query(api.posts.bySlug, { slug: params.slug! }),
});

export default function Post() {
  const { post } = useLoaderData<typeof loader>();
  return (
    <article>
      <title>{post.title}</title>
      <h1>{post.title}</h1>
    </article>
  );
}
```

A route module may export:

- `default`: the page.
- `loader`: runs before the page renders.
- `ErrorBoundary`: shown when this route's loader or page fails.
- `handle`, `shouldRevalidate`: as in React Router, which does the routing underneath.

`app/root.tsx` is the one route that always renders. It exports `Layout` (the `<html>` document, also used for error pages), a default component with the chrome and an `<Outlet />`, and optionally `ErrorBoundary`.

Link with `Link` and `NavLink` from `@archlast/forge-framework`; navigation happens in the browser, loading only the next page's code. Also exported: `useNavigate`, `useParams`, `useLocation`, `useSearchParams`, `useNavigation`, `useRevalidator`, `redirect`, `data`.

## Loaders and live data

A loader runs on the server for the first request and in the browser for later navigations, with the same code. It gets `{ request, params, ctx }`.

`ctx.query(api.x.y, args)` runs a query as the signed-in user and **keeps the result in the page's live cache**. The component then reads it with `useQuery(api.x.y, args)` and has it on the first render, in the server's HTML; afterwards the query stays live over the WebSocket. Use the same function and arguments in both places. For a paginated list, the loader passes what `usePaginatedQuery` asks for first: `{ paginationOpts: { numItems: 30, cursor: null } }`.

```tsx
export const loader = async ({ ctx }: LoaderArgs) => {
  if (!(await ctx.viewer())) throw redirect("/sign-in");
  await ctx.query(api.messages.list, { paginationOpts: { numItems: 30, cursor: null } });
  return null;
};
```

- `ctx.viewer()` is the signed-in user or `null`. In the browser it asks the server, so it is right in the moment after a sign-in or sign-out.
- `throw redirect("/sign-in")` sends the visitor elsewhere (a real 302 for the first request).
- `throw data("No such post", { status: 404 })` renders the route's `ErrorBoundary` with that status.
- A loader returns JSON: dates arrive as strings. Return `null` rather than `undefined` when there is nothing.
- Mutations are not loaders' job. Call them from event handlers with `useMutation`.

`useViewer()` gives components the signed-in user. It is part of the server-rendered HTML, so a header can say "Hi Ada" with no flash, and it follows sign-in and sign-out without a reload. Sign in with `useAuth()` from `@archlast/forge-react`, then `navigate()` to the next page; its loader sees the new session.

## The page's head

Render `<title>`, `<meta>` and `<link>` inside a page and React moves them into `<head>`. Give every page its own `<title>`; do not also set one in `root.tsx`, or the document gets two.

## Styles, images and files

- `import "./styles.css"` from `root.tsx` (or any route). All CSS is built into one file that is linked in `<head>`, so there is no flash of unstyled content.
- `import logo from "./logo.svg"` gives a hashed URL. Declare the file types you import in `app/env.d.ts`.
- Files in `public/` are served at the root. Names that start with a dot are not, except `.well-known`.

## Errors

A failure in a loader or page renders the nearest `ErrorBoundary`, then the root's, inside your `Layout`, with the right status code. Unknown URLs are a 404 through the same path. Outside development, only what is meant for visitors is shown: a `ForgeError`'s message, and `Server error (request <id>)` for everything else, with the full error in the server log under that id.

## Development

`archlast-forge dev` runs the engine and the app in one process on your machine.

- Saving a file rebuilds the app (about a fifth of a second) and the browser reloads. A new file in `routes/` is a new page, with no restart.
- A build error appears over the page and in the terminal; fixing it reloads the page.
- Editing `forge/` restarts only your functions and regenerates the types in `forge/_generated`, which rebuilds the app.
- Services you chose (PostgreSQL, Redis, storage) run in Docker, with their ports on localhost, and stop when you do. Their data is kept.

## Production

```bash
archlast-forge build --no-docker     # the browser and server bundles, with sizes
archlast-forge start --no-docker     # serve them here

archlast-forge up                    # or: the image and its services, in Docker
```

The browser bundle is split per route, hashed, and stored with gzip and brotli versions that the server hands out as they are, with a one-year `immutable` cache header. The page links the code of the routes it shows, so the browser fetches it in parallel with the page. The starter's first load is about 107 kB with brotli (124 kB with gzip): React, the router, live queries and sign-in. Each page adds a couple of kilobytes.

## How it works

For each request the engine matches the URL, runs the matched routes' loaders (calling your functions in-process, as the visitor), renders the page to HTML with React, and sends it with the loaders' data and the live cache embedded. The browser then hydrates the page and takes over navigation. Routing and data loading are [React Router](https://reactrouter.com)'s data router; the engine adds file routes, the build, the live cache, the viewer, and the server around them.

Paths the engine uses itself are not available to routes: `/rpc`, `/api/auth`, `/http`, `/_app`, `/_admin`, `/_dashboard`, `/health`, `/ready`, `/metrics`.

## Not included

- Streaming responses, and static generation: every page is rendered per request.
- Form actions: change data with mutations from event handlers.
- Per-route CSS files loaded on demand: all CSS is one file.
- In production the engine image supplies `react` and `react-dom` (19.3.x); a different 19.x on your machine is fine for development, but test against the image (`archlast-forge up`) before shipping.
