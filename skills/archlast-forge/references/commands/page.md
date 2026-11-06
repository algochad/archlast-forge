# Command: `page <route> [what it shows]`

Builds one page of a full-stack app: the route file, its loader, live data, forms and errors, with nothing that makes the server's HTML differ from the browser's first render. Example: `/archlast-forge page invoices/[id] "one invoice, with a Mark paid button"`.

`<route>` is the URL path as a file under `app/routes/` (`invoices`, `invoices/[id]`, `(app)/settings`). Only for a full-stack app (`"mode": "framework"` in `archlast-forge.json`): for a backend or a separate frontend, say so and use [clients.md](../clients.md) instead.

## 1. Before you write

1. Read [fullstack.md](../fullstack.md): routes, route module exports, loaders, live queries, mutations and forms, hydration, auth and the viewer.
2. Find the functions the page needs in `forge/_generated/api` (after `bun run codegen`). If they don't exist, run [feature.md](feature.md) first: a page never reads the database another way.
3. Check `app/routes/` for the layouts it sits under (`_layout.tsx`, `(group)` folders) and how existing pages sign users in and style themselves (plain CSS or shadcn/ui: `components.json` means shadcn).
4. Check the route name against the engine's paths (`/rpc`, `/http`, `/api/auth`, `/_…`, the API docs path) and against other files that would answer the same URL.

## 2. Steps

1. **The file** `app/routes/<route>.tsx` with a default-exported component that renders its own `<title>` (React hoists it to `<head>`; a `meta` export is ignored).
2. **The loader** calls `ctx.query(api.x.y, args)` with **exactly** the arguments the component's hook uses, so the hook starts from the server's result. Lists: `usePaginatedQuery`'s args plus `paginationOpts`, or `pageArgs()` for `useNumberedPage`. Signed-in pages: redirect anonymous visitors in the loader (or a `(app)/_layout.tsx` guard), as the project already does.
3. **Live data** with the built-in hooks directly: `useQuery`, `usePaginatedQuery`, `useNumberedPage`. No wrapper hooks, no `useEffect` fetches, no copies of server data in state.
4. **Writes** with `useMutation(api.x.y)`; show a `ForgeError`'s message to the user; disable the button while it runs; optimistic updates only where the UI must not wait (`withOptimisticUpdate`). Uploads with `useUploadFile`.
5. **Hydration safety:** times and dates through `useNow()` and `useTimeZone()` (never `Date.now()`, `new Date()` or `toLocaleString()` without the zone in render), no `Math.random()` in render, no `window` during render. An inline `<script>` takes `nonce={useNonce()}`.
6. **Errors and empty states:** an `ErrorBoundary` export when the page has its own failure modes (a missing record: throw from the loader); a clear empty list.
7. `bun run codegen && bun run typecheck`, `bun run format`.

## 3. Verify

- `bun run typecheck` passes (a full-stack app's covers `app/`).
- Start `bun run dev`, then `curl -s localhost:3000/<url>` (with a session cookie for signed-in pages): the HTML already contains the data (server-rendered) and no error.
- In a browser if you have one: no hydration warning in the console, and the data updates live when it changes (change it from a second tab or the dashboard). Say so if you could not check in a browser.
- `archlast-forge build --no-docker` builds (bad route names fail here with the file named).

## 4. Report

```
Page /<url>  (app/routes/<route>.tsx)
  loader: api.x.y(args)  · live: useQuery / usePaginatedQuery …  · writes: api.x.z
  auth: signed-in only (redirects to /sign-in) | public
Checks: typecheck · server-rendered HTML has the data · build
Not verified: browser hydration / live update (no browser here) …
```

## 5. Stop and ask when

- the page needs data no function returns (offer `feature`), or a function's shape would have to change;
- a design system, layout or navigation change outside this page is implied;
- a third-party script, frame or image host is needed (it goes in `http.helmet({ app })`; confirm the source).

## Full documentation

| Page                                                                                                          | Read it for                                                             |
| ------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [framework](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/framework.mdx) | routes, loaders, hooks, hydration, `useNow`/`useTimeZone`, the viewer   |
| [reactivity](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/reactivity.mdx) | what makes a live query update                                        |
| [security-headers](https://raw.githubusercontent.com/algochad/archlast-forge/master/apps/docs/content/security-headers.mdx) | the pages' CSP, `useNonce()`, allowing third-party sources |
