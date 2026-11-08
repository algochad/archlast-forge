# Forge full-stack path: brust's philosophy, our implementation

Status: decision and plan. Supersedes the "embed `brust-core`" option in [brust.md](brust.md) (kept as the analysis it was written from). We do not
fork, vendor or depend on brust. We follow what it believes, and build the parts we need on our own stack.

## What we take from brust (the philosophy)

1. **Decide at build time what reaches the browser.** The build looks at every component and sorts it, instead of shipping the whole tree to hydrate.
2. **Most of a page is plain HTML.** Parts that never change after the server rendered them ship no JavaScript.
3. **Interactive parts are small and local.** A handler or an island that hydrates alone, not the whole document.
4. **Server JavaScript answers data.** The expensive per-request work (sockets, HTTP, templating, compression, caching) sits in Rust.
5. **Fail closed.** If the build cannot prove a component is simple, it stays React. Never guess.

## What we leave out (decided)

No actions layer (Forge has `/rpc`, `/http`, Forge RPC), no Cloudflare or Workers host, no job cache, no second dev server or proxy, no brust
compiler, no fork. And the developer sees no change: `archlast-forge dev`, `forge/`, codegen, `app/routes`, `loader`, `Link`, `useViewer`,
`useQuery`, live reload all stay the way they are written today.

## The tiers, in Forge's words

| tier         | what it is                                                                             | ships                                   | example from the starter                                           |
| ------------ | -------------------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------ |
| **page**     | no state, no effects, no handlers; reads props, loader data, viewer and zone as values | HTML only                               | `index.tsx` (hero, feature cards, a link that depends on `viewer`) |
| **island**   | state, events or live queries                                                          | its own chunk, hydrated on its own root | the header's sign-out button; the whole chat list and form         |
| **fallback** | anything the build cannot classify                                                     | today's behavior (whole route hydrates) | custom routers, refs to browser globals at render, odd patterns    |

Reading the starter by hand: `index.tsx` is a page, nothing to hydrate. `root.tsx`'s header is a page except for the sign-out button
(`useAuth`, `useNavigate`, `onClick`): one small island. `chat.tsx` is one island (live paginated query, mutation, effect, form state) inside a page.
That is the shape brust gives its pages, and it needs no authoring change because the classifier reads what the code already says
(hooks and `on*` props), the way the React compiler reads it.

## Two stages, in this order

### Stage 1: islands in JS, caching and delivery in Rust (no template compiler)

- **Build** (`framework/build.ts`, `generate.ts`): classify components with the TypeScript compiler API already in the repo. Emit one client entry
  per island instead of one for the whole router. The page and fallback routes keep working through today's entry.
- **Server render** stays `renderToReadableStream`, but only page-tier output goes into the HTML as markup, and each island renders into a marker
  with its serialized props and a seed of the live-query cache (`window.__FORGE__` per island rather than per document).
- **Client**: a small loader hydrates islands on their own roots (on idle or visible) and shares one `QueryClient`, WebSocket and viewer through a
  module-level store, so two islands see the same live data (brust's "unified store", done with what Forge already has).
- **Navigation**: a link fetches the target's HTML and swaps the layout levels that changed (brust's rule: a navigation shows what a full load of that
  URL would show). `Link`, `useNavigate` and `redirect` keep their signatures. Loaders then run on the server only, which is the one visible
  behavior change; today they also run in the browser on later visits.
- **Rust** (archlast-serve): a page cache in the I/O threads keyed by route, params, query and viewer class (anonymous / signed-in user / role),
  with ETag, compression and `Vary`, invalidated by the same topics Forge's query cache uses (a mutation that changes a table drops the pages
  that read it). A hit never enters JS. Static assets and `/_app/*` are already served by Rust.

Expected result: far less client JavaScript and no whole-document hydration, hits served at engine speed, dynamic pages unchanged in cost.

### Stage 2: render pages from templates in Rust (only if Stage 1 measures it worth it)

A small compiler for the page tier alone: JSX to a template with holes, for the subset that is provably expression-safe (prop and loader-data
reads, `&&`, ternary, `map` with keys, string/number formatting). Anything else stays React. Rust renders it without a JS hop and the loader is the only
JS call. This is brust's compiler idea, cut down to the one tier where it pays, written for our data shapes (loader data, viewer, zone, nonce).

Gate: after Stage 1, measure a page request's cost split (loader, React render, serialization, I/O). If React render is not the larger part, Stage 2
does not happen. The classifier from Stage 1 is the same one Stage 2 needs, so nothing is thrown away.

## Dev experience (unchanged, and how)

- The existing rebuild in `framework/dev.ts` reclassifies and rebuilds the changed files; the engine swaps its route/page table like `reload()`.
- Stylesheet-only edits swap in place and other edits reload keeping form fields and scroll (already in the dev server); islands add a per-island
  refresh later, if `Bun.build` output allows it, which it currently does not.
- A route the classifier cannot place logs one line saying why and renders as it does today. The `archlast-forge` dashboard shows the tier of each
  route (nothing to write, nothing to configure).

## Security and correctness constraints

- The CSP nonce and `SecurityHeaders` apply to cached pages as well; a cached page is keyed so a nonce is never shared (nonce inserted at serve time,
  or cached pages served with a header-only policy). Decide before Stage 1 ships.
- A cache key must include every input a page reads about the viewer. Pages that read cookies other than the session and zone are not cached.
- Hydration mismatches stay fatal in tests (`hydration.test.ts`), per island.

## First steps

1. Classifier over the starter templates and the framework's own test fixture, as a build-time report (`archlast-forge build` prints tiers).
2. One island end to end (the sign-out button), client entry and loader, behind the framework's existing build.
3. Navigation by HTML swap with `Link` and `redirect` unchanged; run the framework's browser tests against it.
4. Rust page cache with topic invalidation.
5. Measure; decide on Stage 2.
