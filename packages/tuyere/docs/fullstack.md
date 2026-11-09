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

## What rari adds (read 2026-11-08, `rari-build/rari` 0.17.9, MIT, cloned read-only at `~/http-bench/vendor/rari`)

rari is a different bet from brust: **React Server Components with V8 embedded in a Rust server** (deno_core). Rust does HTTP, routing, caching, image
optimization and OG images; React itself still renders, in a pool of V8 runtimes picked round-robin. It has no template compiler. Its headline numbers (89k
req/s against Next.js's 1.7k) are from its own benchmark app; its response cache serves prebuilt bodies, so they are best read as the cache-hit path, not as a
dynamic render rate. I have not reproduced them.

What is useful to us:

- **The cache entry shape.** `PrebuiltResponse` holds the body already encoded as identity, gzip, brotli and zstd, the ETag, content type and `Cache-Control`;
  freshness comes from the entry's own `max-age`; a hit picks the encoding from `Accept-Encoding` and copies nothing else. That is the right form for our Rust page
  cache (brust's L1 kept a gzip variant only). Encode once when the entry is made, off the hot path.
- **Caching below the page.** A `use cache` directive (`crates/rari_use_cache`, `packages/use-cache`) caches a function or component result by key and tag, so a
  page whose parts differ in freshness is not all-or-nothing. Worth keeping in mind for Forge's query results, which already have this in `cache.ts`.
- **A pool of render runtimes in the server process.** Ours is the lane model (Bun Workers), which already exists in Tuyere.
- **Streaming with Suspense and loading states** as a first-class path, which the framework's `allReady` render does not use today.

What does not carry over:

- **V8 embedded in Rust is a different runtime from Bun.** Forge's server code uses `bun:sqlite`, `Bun.file`, Bun's S3 and password APIs; none of it runs in deno_core. We stay Bun-only.
- **RSC as the island mechanism.** React Server Components would give us the page/island split without a classifier: server components by default, `'use client'` marks
  the islands, and the flight payload carries the tree. It needs a bundler pass that splits the server and client module graphs and emits a client manifest
  (rari uses Vite with a plugin); `Bun.build` has none. It also changes how a route is written (async server components instead of `loader` + hooks, a boundary
  directive in client files), which the "nothing changes" rule excludes for existing apps. Kept as a possible later model, not part of Stage 1.

Change to the plan: the Stage 1 page cache stores prebuilt multi-encoding entries as above, and its freshness uses the response's own `Cache-Control`
together with Forge's topic invalidation.

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
- **Rust** (Tuyere): a page cache in the I/O threads keyed by route, params, query and viewer class (anonymous / signed-in user / role),
  with ETag, compression and `Vary`, invalidated by the same topics Forge's query cache uses (a mutation that changes a table drops the pages
  that read it). A hit never enters JS. Static assets and `/_app/*` are already served by Rust.

Expected result: far less client JavaScript and no whole-document hydration, hits served at engine speed, dynamic pages unchanged in cost.

### Stage 2: render pages from templates in Rust (only if Stage 1 measures it worth it)

A small compiler for the page tier alone: JSX to a template with holes, for the subset that is provably expression-safe (prop and loader-data
reads, `&&`, ternary, `map` with keys, string/number formatting). Anything else stays React. Rust renders it without a JS hop and the loader is the only
JS call. This is brust's compiler idea, cut down to the one tier where it pays, written for our data shapes (loader data, viewer, zone, nonce).

First numbers (one machine, one thread, release builds, no I/O): a starter-sized page of about 1 KB rendered by `renderToString` takes 36 us, and through
`renderToReadableStream` + `allReady` + text, the way the framework does it, 57 us; a 3.4 KB page with a 50-row table takes 174 us and 224 us. The same
pages as minijinja templates rendered in Rust, from a prebuilt value, take 1.3 us and 16 us. That is 20 to 45 times less for the render step alone. It does
not include the loader, getting the loader's data into Rust, the router and providers around a real Forge page, or the nonce, so it is the ceiling of the
gain, not the gain. A real Forge page request has not been profiled yet; that is the gate below.

Gate: after Stage 1, measure a page request's cost split (loader, React render, serialization, I/O). If React render is not the larger part, Stage 2
does not happen. The classifier from Stage 1 is the same one Stage 2 needs, so nothing is thrown away.

## Profile of a real page request (measured 2026-11-08)

Setup: the starter app (`create-archlast-forge` framework template) built for production and served by the real engine; server pinned to 4 cores,
`oha -c 64` on 4 others; `packages/framework/bench/profile.ts` reproduces it. Anonymous `/` and signed-in `/chat` (a loader, a live paginated query rendered
on the server).

| page                                                 | `Bun.serve` | Tuyere |
| ---------------------------------------------------- | ----------- | -------------- |
| `/` (about 2.6 KB)                                   | 5.7k req/s  | 7.7k req/s     |
| `/chat` (about 2.7 KB, loader + query)               | 3.2 to 3.5k | 4.6 to 4.8k    |
| `/sign-in` while signed in (302 redirect, no render) | 21k to 50k  | 49k to 63k     |

So a page costs about 175 us of JS-thread time on `/` and about 300 us on `/chat`, against 57 us for React alone rendering a page of that size in the
micro-benchmark above. The CPU profile (Bun `--cpu-prof-md`, `/`, 15 s of busy time, `Bun.serve`) by where the self time went:

| share     | what                                                                                                                                            |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| about 41% | Bun's native work: socket `write`/`end`/`writeSync`, `Response` and `ReadableStream` objects, `URL`, `JSON.stringify`, header copying           |
| about 27% | React: `react-dom/server` 23%, `react` 4%                                                                                                       |
| about 14% | React Router on the server: path matching, `resolvePathname`, `joinPaths`, `createStaticRouter`, hooks (a static router is built per request)   |
| about 6%  | the engine's own request path: `server.ts`, security headers, telemetry recorder, rate limit                                                    |
| about 5%  | the framework and the app: `server.tsx`, `time.tsx`, providers, `root.tsx`, route code                                                          |
| about 4%  | Better Auth's browser client, built during server render (nanostores, session atom, focus/online managers) because the header calls `useAuth()` |
| rest      | zod, TanStack Query, small                                                                                                                      |

Reading it:

- **Moving I/O to Rust already pays.** The 41% of native socket and `Response` work is what the engine takes over: +35% on `/` and `/chat`
  with no change to any page code. That is the number to hold the other ideas against.
- **React plus the router are about 41% of what is left on the JS thread.** A perfect Rust renderer would remove most of that, not all of it (the
  loader, the query cache, serialization and glue stay). With the engine already in place, expect page throughput up by roughly 1.5 to 1.7 times from the
  renderer alone, if every part of the page is in the compilable subset. The 20 to 45 times from the micro-benchmark is not available to a whole request.
- **A page cache removes all of it for a hit.** A cache hit is served in Rust at engine speed (the redirect above, which also never renders, does 49k to 63k req/s).
  For pages that can be cached that is tenfold or more, a larger lever than the renderer. It is why the cache comes first.
- **There is cheap work in the existing path that is not about Rust**: a `createStaticRouter` per request, and a Better Auth client built on every server render
  for a header that only needs the viewer on the server (it could be created lazily, in the browser). Together about 5% of the thread, no new architecture.

Caveats: one machine, one page shape; the `/chat` loader here reads an empty table; profile overhead is in the numbers; shares are of self time by file, and
recursion in React's renderer makes inclusive times unreliable, so no inclusive figure is given.

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

## Step 1 result: the classifier (`packages/framework/src/classify.ts`, `bun packages/framework/src/classify-cli.ts <app>`)

On the starter, with no change to any file: `index` is a page; `chat` and `sign-in` are islands; the header (`Chrome`) is an island because the sign-out
button, `useAuth()` and `useNavigate()` live in the same component as the static header and footer. The finding that matters: `Root` passes the page
(`<Outlet />`, elements) to `Chrome`, and elements cannot cross into an island, so **the root layout is an island and the whole page would hydrate**. Islands
only pay when the interactive part is its own component. Two ways forward, to decide at step 2:

- split the starter's header so the viewer menu (avatar, sign-out) is a small component of its own. The templates are ours, so the starters ship split;
  an app that does not split loses nothing, it behaves as today and the report says why.
- or teach the build to extract an interactive subtree into a synthesized island (a compiler job: the subtree closes over hooks and handlers, so it is only
  safe for simple cases). Later, if splitting by hand proves a burden.

The classifier fails closed: packages it does not read, members of objects, components chosen at run time and unresolved imports all count as islands (or make
the component containing them one), a class or `this` is a fallback, and an `action` export makes the route a fallback.

## Step 2 result: islands, end to end, behind a flag (`FORGE_ISLANDS=1`, or `islands: true` to `buildApp`/`createApp`)

Built and tested (`test/islands.test.ts`, with a fixture app and a real browser): the build classifies the app, wraps each island's export for the server bundle
(`island.tsx`; a wrapper module under its own path, because Bun treats a module of the same path in another namespace as the same module), generates a second
browser entry that loads each island by id (`islands.client.ts`), and the server renders island markers plus the island's own HTML. In the browser each marker
hydrates on its own root with the page's shared client, query cache, viewer and clock; `useNavigate` and `<Link>` inside an island load the page (there is no router
in the browser). A page with an error, or with a route the build cannot place (an `action`, for now), is rendered and hydrated as a whole, exactly as before, and the
two kinds of page can link to each other. Islands are off when the root layout or the document is itself interactive, with the reason printed at build time.

What the first measurement said: with the starter's header split so that the viewer menu is an island of its own, the home page ships **124.3 KiB gzip instead of
126.2 KiB**. That is almost nothing, and it is the honest result: the one island that remains (sign-out) needs React, the forge client and Better Auth's client, which
is most of what the whole-page entry carries. Islands remove JavaScript only from pages where **no island renders**. Two consequences for the next step:

- an island that is only needed in some states should be mounted only then: the starter's menu is an island for a signed-in visitor and a plain link for an anonymous
  one, so the anonymous home page has no island at all;
- when a page renders no island, the server leaves out the bootstrap script, the preload links and the `window.__FORGE__` state altogether, so the page has no
  JavaScript. This is done: the island render is written without scripts, counts the islands it meets, and the scripts are put into the HTML (before `</body>`, with
  the preloads before `</head>`) only when the count is not zero. Tested: an anonymous visitor's `/about` in the fixture has no `<script>` and no `modulepreload`,
  while the same site's signed-in pages load the islands entry.

The starter templates are not split yet: splitting changes what `create-archlast-forge` writes (and so the skill and the docs), which should happen when islands are
opt-in for users, not while they are a flag.

## Step 3 result: navigation by HTML swap (`src/nav.ts`)

Done and tested in a real browser. A click on a link to another page of the site, back and forward, and `useNavigate()` inside an island fetch the target's HTML and
swap it in: the head's differences, the body, the title; the document, its stylesheets and the shared client survive; the islands of the new page hydrate (the page's state
is a JSON block, because an inline script would need the new page's nonce, which the document's policy does not know). The server marks island pages with `x-forge-page:
islands`; a target without it, a non-HTML answer, another origin or `data-forge-reload` is loaded the ordinary way. Starters enable islands with `export const islands =
true` in `app/root.tsx` and ship the user menu as an island and the shadcn theme switch as part of the page.

Starter home page for a visitor who is not signed in: **126 kB of JavaScript before, 1.3 kB now** (shadcn: 147 kB before, 1.3 kB now); pages with an island are about as heavy as before.

## Step 4 result: pages kept by the engine (`pagecache.rs`, `handle.cache`)

Done and tested (Rust unit tests, engine tests on both backends, the framework with a real browser, the starters). A route with `export const handle = { cache: { ttl: 60 } }`
has its page for visitors who are not signed in kept by the engine and answered from the I/O threads: the starter's home page went from about 7,000 to about 290,000 requests
a second on 4 cores; a trivial cached response measured 394k against 113k through the handler. Entries are stored as the handler made them plus a gzip copy made once, with
an ETag (so `If-None-Match` gets a 304); the key is host, path and query, and the values of the varied cookies (here the time zone's). A request with an `Authorization` header,
or with any cookie but the time zone's, never meets the cache. The Content-Security-Policy of a kept page names its inline scripts by SHA-256 instead of carrying a nonce,
which every visitor would otherwise share. The engine has `purgeCache(tags?)`; Forge does not expose it yet, so a kept page lives until its ttl ends. Only the native engine
keeps pages; `HTTP_ENGINE=bun` renders every request.

## A real application: archlast-erp (profiled 2026-11-08)

The ERP (a multi-tenant SaaS on the framework: 114 route and component files, 26,000 lines, PostgreSQL in production) was copied to a scratch directory, wired to this checkout's
packages, seeded with its demo script and served in production mode on SQLite, 4 cores, 32 connections, signed in as the demo owner. The original was not touched.

What the classifier says about it: **every one of its 49 routes is an island** (live queries, forms, handlers), 51 components are pages and 196 are islands, and its layout
route (`o/[org]/_layout`) is an island that renders an `<Outlet />`. So islands, the page cache and a Rust page renderer all have nothing to work on here: an app of this kind
renders and hydrates whole pages, and what helps it is a faster whole-page render.

Where a page's time went (CPU profile of `/o/northwind/products`, before any change): a third was `Intl.NumberFormat`/`DateTimeFormat` being *constructed* in every table cell
(`formatMoney` builds its formatter inside), a tenth was the stream React writes chunk by chunk, an eighth the app's own components, a tenth React Router resolving every link.

What was changed in the framework, each measured on the ERP's pages (requests a second, 4 cores):

| change | dashboard | products | sales | stock |
| --- | ---: | ---: | ---: | ---: |
| before | 442 | 403 | 348 | 244 |
| render in one pass (`renderToString`; the stream only for pages that suspend or throw) | 484 | 450 | 389 | 274 |
| `Link` and `NavLink` print what React Router's print, for plain paths, without route resolution | 557 | 512 | 443 | 307 |
| Intl formatters made once per locale and options on the server (`FORGE_MEMO_INTL=0` turns it off) | 933 | 780 | 787 | 449 |

That is 1.8 to 2.3 times, with no change to the app. A remaining profile shows React's string building at a quarter, the app's components at a sixth, and the framework and
engine glue at a sixth. One more finding: a production build made in a shell without `NODE_ENV` called the development JSX runtime (every page failed with `jsxDEV is not a
function`); the build now chooses it from `dev`.

## Against React Router and Next.js (`benchmarks/fullstack`)

The same two pages in the three frameworks, each as shipped (see its README for the method). Requests a second on 4 cores, 64 connections:

| | home page | products (100 rows, formatters per call) | products (formatters built once) | JS for the home page (gzip) |
| --- | ---: | ---: | ---: | ---: |
| archlast-forge, as scaffolded (islands, home kept by the engine) | 295,884 | 2,164 | 2,962 | 1.3 kB |
| archlast-forge, home rendered each time | 18,128 | 2,143 | 2,966 | 1.3 kB |
| archlast-forge, whole-page hydration | 16,981 | 1,915 | 2,636 | 122 kB |
| React Router 7 (`react-router-serve`, Node) | 2,379 | 114 | 896 | 98 kB |
| Next.js 16 (`next start`, Node) | 4,031 | 88 | 241 | 170 kB |

The pages have nothing interactive, which is the case where islands send no framework JavaScript; Node servers are single processes, as these two start by default; no database or
authentication is involved. A first run of this comparison found the Node apps slow in a place that was the benchmark's own doing (`process.env` read per call in Node), which was
fixed and the numbers redone.

## Step 5: the Rust template renderer

Measured first on the starter's home page (cache bypassed): React and React Router were 64% of the JavaScript thread's busy time, a ceiling of about 2.8 times on a page a
renderer could print. The ERP shows that pages of that kind are not what an app like it has. What a page of that kind *is* worth was measured next, with a 100-row table.

**Built:** a template interpreter in the engine (`crates/core/src/template.rs`: HTML with holes, JavaScript's truthiness and string rules, React's escaping, `&&` `||` `??` `?:` `===`
`+` template literals, `.length`, maps over arrays, attributes left out when empty; it borrows from the data instead of copying it), `registerTemplate` / `renderTemplate` through the
Node-API addon, and a `TemplateReply`: the handler answers with a template id and the loader's JSON, and the **I/O thread** prints the page and writes it while the JavaScript thread
goes on to the next request. The output of the template equals React's (`renderToString`, minus the `<!-- -->` text separators) for the test page.

**Measured** (same engine, 100-row table, 64 connections, 4 cores; `packages/framework/bench/template-spike.ts`):

| how the page is printed | requests a second |
| --- | ---: |
| React `renderToString` in the handler | 7,500 |
| the Rust template, called from the handler with the data as an object | 10,600 |
| the Rust template, called from the handler with the data as JSON text | 12,200 |
| the Rust template, printed on the I/O thread (`TemplateReply`) | **23,600** |
| a fixed body (the floor of the engine) | 131,000 |

So printing on the I/O thread is three times React for this page. A call from the JavaScript thread into Rust is barely better than React (the time goes to moving a large string in and
a larger one out and parsing the JSON), which is why the work is placed on the I/O thread.

**Squeezed, then built into the framework.** A zero-copy JSON reader (`json.rs`) took reading the data from 51 to 23 microseconds and the 100-row page on the I/O threads from 23,600 to
**37,000 requests a second** (React 7,500). The compiler (`packages/framework/src/render-compile.ts`) reads the route's components (root, layouts, page) at build time and writes the template;
calls of the app's functions are lifted into a per-request step that runs them before printing (`formatMoney(row.price)` becomes a field of the row). The framework answers with the data as
JSON and `x-forge-template`, and the runtime hands it to the engine as a `TemplateReply` after the security headers and the cache note are on it, so a printed page can also be a kept page.
A route the compiler cannot read says why (`classify-cli`) and is rendered by React; the tests serve the same fixture app both ways and compare every page (signed in too).

In the benchmark app (4 cores): home page rendered on every request 17,000 -> **43,500** requests a second (React Router 2,400, Next.js 4,000); the 100-row products page 2,100 -> **3,300**
with formatters built per call and 2,950 -> **5,800** with them built once (React Router 113 / 900, Next.js 85 / 250); what is left on the JavaScript thread there is the app's own loader and
200 `Intl` formatting calls. Not covered: a route whose page shows an island for some visitors (the starters' header) is left to React, and so is anything with state or a handler.

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

## Step 1 result: the classifier (`packages/framework/src/classify.ts`, `bun packages/framework/src/classify-cli.ts <app>`)

On the starter, with no change to any file: `index` is a page; `chat` and `sign-in` are islands; the header (`Chrome`) is an island because the sign-out
button, `useAuth()` and `useNavigate()` live in the same component as the static header and footer. The finding that matters: `Root` passes the page
(`<Outlet />`, elements) to `Chrome`, and elements cannot cross into an island, so **the root layout is an island and the whole page would hydrate**. Islands
only pay when the interactive part is its own component. Two ways forward, to decide at step 2:

- split the starter's header so the viewer menu (avatar, sign-out) is a small component of its own. The templates are ours, so the starters ship split;
  an app that does not split loses nothing, it behaves as today and the report says why.
- or teach the build to extract an interactive subtree into a synthesized island (a compiler job: the subtree closes over hooks and handlers, so it is only
  safe for simple cases). Later, if splitting by hand proves a burden.

The classifier fails closed: packages it does not read, members of objects, components chosen at run time and unresolved imports all count as islands (or make
the component containing them one), a class or `this` is a fallback, and an `action` export makes the route a fallback.

## Step 2 result: islands, end to end, behind a flag (`FORGE_ISLANDS=1`, or `islands: true` to `buildApp`/`createApp`)

Built and tested (`test/islands.test.ts`, with a fixture app and a real browser): the build classifies the app, wraps each island's export for the server bundle
(`island.tsx`; a wrapper module under its own path, because Bun treats a module of the same path in another namespace as the same module), generates a second
browser entry that loads each island by id (`islands.client.ts`), and the server renders island markers plus the island's own HTML. In the browser each marker
hydrates on its own root with the page's shared client, query cache, viewer and clock; `useNavigate` and `<Link>` inside an island load the page (there is no router
in the browser). A page with an error, or with a route the build cannot place (an `action`, for now), is rendered and hydrated as a whole, exactly as before, and the
two kinds of page can link to each other. Islands are off when the root layout or the document is itself interactive, with the reason printed at build time.

What the first measurement said: with the starter's header split so that the viewer menu is an island of its own, the home page ships **124.3 KiB gzip instead of
126.2 KiB**. That is almost nothing, and it is the honest result: the one island that remains (sign-out) needs React, the forge client and Better Auth's client, which
is most of what the whole-page entry carries. Islands remove JavaScript only from pages where **no island renders**. Two consequences for the next step:

- an island that is only needed in some states should be mounted only then: the starter's menu is an island for a signed-in visitor and a plain link for an anonymous
  one, so the anonymous home page has no island at all;
- when a page renders no island, the server leaves out the bootstrap script, the preload links and the `window.__FORGE__` state altogether, so the page has no
  JavaScript. This is done: the island render is written without scripts, counts the islands it meets, and the scripts are put into the HTML (before `</body>`, with
  the preloads before `</head>`) only when the count is not zero. Tested: an anonymous visitor's `/about` in the fixture has no `<script>` and no `modulepreload`,
  while the same site's signed-in pages load the islands entry.

The starter templates are not split yet: splitting changes what `create-archlast-forge` writes (and so the skill and the docs), which should happen when islands are
opt-in for users, not while they are a flag.

## Step 3 result: navigation by HTML swap (`src/nav.ts`)

Done and tested in a real browser. A click on a link to another page of the site, back and forward, and `useNavigate()` inside an island fetch the target's HTML and
swap it in: the head's differences, the body, the title; the document, its stylesheets and the shared client survive; the islands of the new page hydrate (the page's state
is a JSON block, because an inline script would need the new page's nonce, which the document's policy does not know). The server marks island pages with `x-forge-page:
islands`; a target without it, a non-HTML answer, another origin or `data-forge-reload` is loaded the ordinary way. Starters enable islands with `export const islands =
true` in `app/root.tsx` and ship the user menu as an island and the shadcn theme switch as part of the page.

Starter home page for a visitor who is not signed in: **126 kB of JavaScript before, 1.3 kB now** (shadcn: 147 kB before, 1.3 kB now); pages with an island are about as heavy as before.

## Step 4 result: pages kept by the engine (`pagecache.rs`, `handle.cache`)

Done and tested (Rust unit tests, engine tests on both backends, the framework with a real browser, the starters). A route with `export const handle = { cache: { ttl: 60 } }`
has its page for visitors who are not signed in kept by the engine and answered from the I/O threads: the starter's home page went from about 7,000 to about 290,000 requests
a second on 4 cores; a trivial cached response measured 394k against 113k through the handler. Entries are stored as the handler made them plus a gzip copy made once, with
an ETag (so `If-None-Match` gets a 304); the key is host, path and query, and the values of the varied cookies (here the time zone's). A request with an `Authorization` header,
or with any cookie but the time zone's, never meets the cache. The Content-Security-Policy of a kept page names its inline scripts by SHA-256 instead of carrying a nonce,
which every visitor would otherwise share. The engine has `purgeCache(tags?)`; Forge does not expose it yet, so a kept page lives until its ttl ends. Only the native engine
keeps pages; `HTTP_ENGINE=bun` renders every request.

## A real application: archlast-erp (profiled 2026-11-08)

The ERP (a multi-tenant SaaS on the framework: 114 route and component files, 26,000 lines, PostgreSQL in production) was copied to a scratch directory, wired to this checkout's
packages, seeded with its demo script and served in production mode on SQLite, 4 cores, 32 connections, signed in as the demo owner. The original was not touched.

What the classifier says about it: **every one of its 49 routes is an island** (live queries, forms, handlers), 51 components are pages and 196 are islands, and its layout
route (`o/[org]/_layout`) is an island that renders an `<Outlet />`. So islands, the page cache and a Rust page renderer all have nothing to work on here: an app of this kind
renders and hydrates whole pages, and what helps it is a faster whole-page render.

Where a page's time went (CPU profile of `/o/northwind/products`, before any change): a third was `Intl.NumberFormat`/`DateTimeFormat` being *constructed* in every table cell
(`formatMoney` builds its formatter inside), a tenth was the stream React writes chunk by chunk, an eighth the app's own components, a tenth React Router resolving every link.

What was changed in the framework, each measured on the ERP's pages (requests a second, 4 cores):

| change | dashboard | products | sales | stock |
| --- | ---: | ---: | ---: | ---: |
| before | 442 | 403 | 348 | 244 |
| render in one pass (`renderToString`; the stream only for pages that suspend or throw) | 484 | 450 | 389 | 274 |
| `Link` and `NavLink` print what React Router's print, for plain paths, without route resolution | 557 | 512 | 443 | 307 |
| Intl formatters made once per locale and options on the server (`FORGE_MEMO_INTL=0` turns it off) | 933 | 780 | 787 | 449 |

That is 1.8 to 2.3 times, with no change to the app. A remaining profile shows React's string building at a quarter, the app's components at a sixth, and the framework and
engine glue at a sixth. One more finding: a production build made in a shell without `NODE_ENV` called the development JSX runtime (every page failed with `jsxDEV is not a
function`); the build now chooses it from `dev`.

## Against React Router and Next.js (`benchmarks/fullstack`)

The same two pages in the three frameworks, each as shipped (see its README for the method). Requests a second on 4 cores, 64 connections:

| | home page | products (100 rows, formatters per call) | products (formatters built once) | JS for the home page (gzip) |
| --- | ---: | ---: | ---: | ---: |
| archlast-forge, as scaffolded (islands, home kept by the engine) | 295,884 | 2,164 | 2,962 | 1.3 kB |
| archlast-forge, home rendered each time | 18,128 | 2,143 | 2,966 | 1.3 kB |
| archlast-forge, whole-page hydration | 16,981 | 1,915 | 2,636 | 122 kB |
| React Router 7 (`react-router-serve`, Node) | 2,379 | 114 | 896 | 98 kB |
| Next.js 16 (`next start`, Node) | 4,031 | 88 | 241 | 170 kB |

The pages have nothing interactive, which is the case where islands send no framework JavaScript; Node servers are single processes, as these two start by default; no database or
authentication is involved. A first run of this comparison found the Node apps slow in a place that was the benchmark's own doing (`process.env` read per call in Node), which was
fixed and the numbers redone.

## Step 5: the Rust template renderer

Measured first on the starter's home page (cache bypassed): React and React Router were 64% of the JavaScript thread's busy time, a ceiling of about 2.8 times on a page a
renderer could print. The ERP shows that pages of that kind are not what an app like it has. What a page of that kind *is* worth was measured next, with a 100-row table.

**Built:** a template interpreter in the engine (`crates/core/src/template.rs`: HTML with holes, JavaScript's truthiness and string rules, React's escaping, `&&` `||` `??` `?:` `===`
`+` template literals, `.length`, maps over arrays, attributes left out when empty; it borrows from the data instead of copying it), `registerTemplate` / `renderTemplate` through the
Node-API addon, and a `TemplateReply`: the handler answers with a template id and the loader's JSON, and the **I/O thread** prints the page and writes it while the JavaScript thread
goes on to the next request. The output of the template equals React's (`renderToString`, minus the `<!-- -->` text separators) for the test page.

**Measured** (same engine, 100-row table, 64 connections, 4 cores; `packages/framework/bench/template-spike.ts`):

| how the page is printed | requests a second |
| --- | ---: |
| React `renderToString` in the handler | 7,500 |
| the Rust template, called from the handler with the data as an object | 10,600 |
| the Rust template, called from the handler with the data as JSON text | 12,200 |
| the Rust template, printed on the I/O thread (`TemplateReply`) | **23,600** |
| a fixed body (the floor of the engine) | 131,000 |

So printing on the I/O thread is three times React for this page. A call from the JavaScript thread into Rust is barely better than React (the time goes to moving a large string in and
a larger one out and parsing the JSON), which is why the work is placed on the I/O thread.

**Not built:** the part that makes this usable by an app, a compiler from components to templates (JSX to nodes, with the loader data as `d`, a layout around an `<Outlet />`, `<title>`
hoisted to the head, `Link`/`NavLink` active state, and app helper calls such as `formatMoney(row.price)` lifted into a column the loader computes before printing), and the framework
route that chooses it. The classifier already finds the components it can take (pages with no island), and anything else stays React. Page-only routes that are not the same for
everyone (reports, tables of server data) are what it is for; the ERP has none, and pages with islands still need React to print the island.

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

## Step 1 result: the classifier (`packages/framework/src/classify.ts`, `bun packages/framework/src/classify-cli.ts <app>`)

On the starter, with no change to any file: `index` is a page; `chat` and `sign-in` are islands; the header (`Chrome`) is an island because the sign-out
button, `useAuth()` and `useNavigate()` live in the same component as the static header and footer. The finding that matters: `Root` passes the page
(`<Outlet />`, elements) to `Chrome`, and elements cannot cross into an island, so **the root layout is an island and the whole page would hydrate**. Islands
only pay when the interactive part is its own component. Two ways forward, to decide at step 2:

- split the starter's header so the viewer menu (avatar, sign-out) is a small component of its own. The templates are ours, so the starters ship split;
  an app that does not split loses nothing, it behaves as today and the report says why.
- or teach the build to extract an interactive subtree into a synthesized island (a compiler job: the subtree closes over hooks and handlers, so it is only
  safe for simple cases). Later, if splitting by hand proves a burden.

The classifier fails closed: packages it does not read, members of objects, components chosen at run time and unresolved imports all count as islands (or make
the component containing them one), a class or `this` is a fallback, and an `action` export makes the route a fallback.

## Step 2 result: islands, end to end, behind a flag (`FORGE_ISLANDS=1`, or `islands: true` to `buildApp`/`createApp`)

Built and tested (`test/islands.test.ts`, with a fixture app and a real browser): the build classifies the app, wraps each island's export for the server bundle
(`island.tsx`; a wrapper module under its own path, because Bun treats a module of the same path in another namespace as the same module), generates a second
browser entry that loads each island by id (`islands.client.ts`), and the server renders island markers plus the island's own HTML. In the browser each marker
hydrates on its own root with the page's shared client, query cache, viewer and clock; `useNavigate` and `<Link>` inside an island load the page (there is no router
in the browser). A page with an error, or with a route the build cannot place (an `action`, for now), is rendered and hydrated as a whole, exactly as before, and the
two kinds of page can link to each other. Islands are off when the root layout or the document is itself interactive, with the reason printed at build time.

What the first measurement said: with the starter's header split so that the viewer menu is an island of its own, the home page ships **124.3 KiB gzip instead of
126.2 KiB**. That is almost nothing, and it is the honest result: the one island that remains (sign-out) needs React, the forge client and Better Auth's client, which
is most of what the whole-page entry carries. Islands remove JavaScript only from pages where **no island renders**. Two consequences for the next step:

- an island that is only needed in some states should be mounted only then: the starter's menu is an island for a signed-in visitor and a plain link for an anonymous
  one, so the anonymous home page has no island at all;
- when a page renders no island, the server leaves out the bootstrap script, the preload links and the `window.__FORGE__` state altogether, so the page has no
  JavaScript. This is done: the island render is written without scripts, counts the islands it meets, and the scripts are put into the HTML (before `</body>`, with
  the preloads before `</head>`) only when the count is not zero. Tested: an anonymous visitor's `/about` in the fixture has no `<script>` and no `modulepreload`,
  while the same site's signed-in pages load the islands entry.

The starter templates are not split yet: splitting changes what `create-archlast-forge` writes (and so the skill and the docs), which should happen when islands are
opt-in for users, not while they are a flag.

## Step 3 result: navigation by HTML swap (`src/nav.ts`)

Done and tested in a real browser. A click on a link to another page of the site, back and forward, and `useNavigate()` inside an island fetch the target's HTML and
swap it in: the head's differences, the body, the title; the document, its stylesheets and the shared client survive; the islands of the new page hydrate (the page's state
is a JSON block, because an inline script would need the new page's nonce, which the document's policy does not know). The server marks island pages with `x-forge-page:
islands`; a target without it, a non-HTML answer, another origin or `data-forge-reload` is loaded the ordinary way. Starters enable islands with `export const islands =
true` in `app/root.tsx` and ship the user menu as an island and the shadcn theme switch as part of the page.

Starter home page for a visitor who is not signed in: **126 kB of JavaScript before, 1.3 kB now** (shadcn: 147 kB before, 1.3 kB now); pages with an island are about as heavy as before.

## Step 4 result: pages kept by the engine (`pagecache.rs`, `handle.cache`)

Done and tested (Rust unit tests, engine tests on both backends, the framework with a real browser, the starters). A route with `export const handle = { cache: { ttl: 60 } }`
has its page for visitors who are not signed in kept by the engine and answered from the I/O threads: the starter's home page went from about 7,000 to about 290,000 requests
a second on 4 cores; a trivial cached response measured 394k against 113k through the handler. Entries are stored as the handler made them plus a gzip copy made once, with
an ETag (so `If-None-Match` gets a 304); the key is host, path and query, and the values of the varied cookies (here the time zone's). A request with an `Authorization` header,
or with any cookie but the time zone's, never meets the cache. The Content-Security-Policy of a kept page names its inline scripts by SHA-256 instead of carrying a nonce,
which every visitor would otherwise share. The engine has `purgeCache(tags?)`; Forge does not expose it yet, so a kept page lives until its ttl ends. Only the native engine
keeps pages; `HTTP_ENGINE=bun` renders every request.

## Step 5: the Rust template renderer, decided

Measured on the starter's home page rendered on every request (the cache bypassed), native engine, islands on, 4 cores: **14.5k requests a second** (it was 7.7k before
islands and the lazy auth client). Where the JavaScript thread spends its busy time: React 39%, React Router 25% (path matching and resolving for every `Link` and
`NavLink`), the runtime's request path 12%, the engine's TypeScript 10%, the framework 5%, the rest 9%. So React and the router are the larger part (64%), and the gate set
above is passed; a renderer that removed both entirely would leave about a third, a ceiling of roughly 2.8 times on a page it can render.

It is not built, for these reasons, and it should be revisited with data from a real app rather than from the starter:

* **It serves a narrow set of requests.** Pages for visitors who are not signed in and are the same for everyone are now answered by the cache at 40 times. What is left
  for a renderer is a page that is personal and still has no island: a server-rendered report or table for a signed-in user. The pages with islands (live queries, forms)
  still need React to render the island on the server, so the renderer would have to call JavaScript for each of them, as brust's jobs do.
* **The cost is a compiler and a second renderer that must agree with React** on `+` of mixed types, truthiness, escaping, attribute names, style objects, boolean attributes,
  `<title>` hoisting, `NavLink`'s active state and the order of layouts, for each page shape an app uses, with the classifier failing closed into React for the rest.
* **Cheaper wins remain on the same path:** React Router's per-request path resolution is a quarter of the busy time and is a fixed cost of every `Link`; the runtime's request
  path and the engine's TypeScript are another fifth. These need no new renderer.

What would change the decision: a profile of a real app (archlast-erp) showing that most of its page requests are signed-in, island-free and large (many rows). Then the page tier
compiled to templates (the classifier already finds those components) is worth building, starting with the one tier where it pays.

## First steps

1. (Done.) Classifier over the starter templates, as a report. Not yet printed by `archlast-forge build`.
2. (Done, behind a flag.) One island end to end, client entry and loader, behind the framework's existing build.
3. (Done.) Navigation by HTML swap with `Link` and `redirect` unchanged; run the framework's browser tests against it.
4. (Done, with a ttl; no topic invalidation.) Rust page cache.
5. (Done.) Measure; decide on Stage 2: not built yet, see above.
