# brust and archlast-serve: design

Status: **superseded by [fullstack.md](fullstack.md)**, which keeps brust's philosophy and drops embedding it. Kept as the analysis. Originally: analysis and recommendation, written from reading brust 2.0.0-alpha.38 (`AssetsArt/brust`, MIT, cloned read-only at
`~/http-bench/vendor/brust`). Nothing here is built into the engine yet.

## What brust is (not what its name suggests)

brust is **not** a faster React SSR. It is an ahead-of-time compiler plus a Rust page server:

```
 build time (Bun + prebuilt napi addon)                       run time
 ┌──────────────────────────────────────────┐   ┌────────────────────────────────────────────────────┐
 │ routes.tsx ─► brust-compiler (Bun's JS   │   │ brust-server: hyper/tokio/rustls (same stack as us)│
 │   parser + React Compiler passes)        │   │   brust-core::pipeline::handle<H: Host>            │
 │   classifies every component:            │   │     route match (matchit) ─► L1 page cache         │
 │     static  ─► minijinja template        │   │     loader  ─► JS worker  (data only, JSON)        │
 │     native  ─► template + small handler  │──►│     jobs    ─► JS worker  (batched, job cache)     │
 │     react   ─► template + SSR "job" +    │   │     render  ─► minijinja templates, in Rust        │
 │                island chunk              │   │     gzip, ETag, CORS, actions, static roots        │
 │ manifest.json, jinja/*, client/*.js      │   └────────────────────────────────────────────────────┘
 └──────────────────────────────────────────┘
```

- **Static** components render from a compiled template in Rust with no JavaScript. **Native** ones add a signals-based handler chunk
  (no React on the client). **React** components stay React: they render as an SSR _job_ in a Bun worker and hydrate as an island.
- JS workers answer only `loader` / `jobs` / `fetch` calls. Everything else is Rust.
- Its own benchmark (M1 Pro, `oha -c 120`): cached page 114k req/s vs `Bun.serve` 33k; a 151-row page with per-request loader
  13.8k vs 4.7k. Those numbers are theirs, from their machine, and not reproduced here.
- The crate split is the useful part: `brust-core` is host-agnostic (no tokio, no hyper), generic over a `Host` trait, and is shared by
  the native server and a Cloudflare Workers host. `brust-server` is just one `Host` implementation (501 lines, `host.rs`).

## Why it cannot simply replace Forge's SSR

Forge's framework (`packages/framework`) is a React Router data router: file routes with `loader`/`action`, TanStack Query cache
dehydrated into `window.__FORGE__`, whole-document `hydrateRoot`, a per-request CSP nonce, viewer/session in every page, live queries
over WebSocket. brust compiles a _subset_ of React:

|               | brust                                                                                                   | Forge framework                                                           |
| ------------- | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| route fields  | `path`, `Component`, `loader`, `cache`, `ssg`, `children` only                                          | React Router: `action`, `errorElement`, `handle`, `lazy`, ...             |
| loader result | flat JSON merged root to leaf                                                                           | per-request context, TanStack prefetch, sanitized errors                  |
| client        | its own runtime for native; islands hydrate one by one                                                  | one `hydrateRoot` over the router, client-side navigation (router-driven) |
| components    | compiler decides; hooks like `useQuery`, `useViewer`, `useMutation`, `useNavigate` force the React tier | those hooks are in most real pages                                        |

So a compiled route and a Forge route are two different kinds of page. Pages that are static or lightly interactive (marketing, docs,
lists, dashboards' shells) would compile; pages that use the live-query hooks fall to the React tier, where Rust only wraps a Bun SSR
job and there is no win over what Forge does now. brust has its own client navigation (`docs/navigation.md`): a link click fetches the target's real HTML and swaps the changed layout levels
in place, so a brust app is not a multi-page site. What it cannot do is share a router with React Router, so a Forge app is either one model or
the other per site, not mixed per link. (An earlier version of this note said brust navigates by full document load; that was wrong.)

Expected benefit is therefore **per route, not whole framework**, and it grows with the share of public/read-mostly pages.

## Options considered

| option                                                                                                                  | what                                                                            | verdict                                                                        |
| ----------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| A. fork brust whole, run its server beside ours                                                                         | two listeners, two stacks                                                       | no: duplicates hyper/TLS/h2, two ports, no shared WebSocket/pub-sub            |
| B. brust-napi next to the engine as a second addon                                                                      | `brust-napi` starts its own `brust-server`                                      | no: same problem, plus a second tokio runtime and a second set of worker slots |
| C. **embed `brust-core` in archlast-serve, implement `Host` for the engine; keep the compiler outside as a build tool** | one listener, one scheduler, brust's pipeline and caches run on our I/O threads | **recommended**                                                                |
| D. take only the compiler and write our own renderer                                                                    | rewrites 20k lines of pipeline/cache for no gain                                | no                                                                             |

### Why C fits unusually well

- `brust-core` has the same dependency base as the engine: hyper 1, `http` 1, `bytes`. Its own rule is "no tokio, hyper, moka"
  (checked in their CI). I built `brust-core` + `brust-jinja` alone on stable Rust 1.90 in 8 s; no nightly is needed for the runtime half.
- The `Host` trait maps onto what the engine already has:

  | `Host` method                    | engine side                                                                                                                                                                                     |
  | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | `loader`, `jobs`, `action`       | new event kinds to a JS lane (the same lanes that run `fetch` today); the answer returns as a command. brust's own worker protocol is JSON in, JSON out, so Forge's loader runs unchanged in JS |
  | `static_file`                    | `file.rs` (Range, ETag, validators already done)                                                                                                                                                |
  | `read_body` / `Body`             | hyper `Incoming` as in `http.rs`                                                                                                                                                                |
  | `Clock`, `PageCache`, `JobStore` | reuse brust's `L1Cache`/`JobCache` (moka) or move them into `brust-core` features; they are the page cache we do not have                                                                       |
  | `l2_get` / `l2_set`              | the trait defaults (no second tier)                                                                                                                                                             |

- Routing falls through: the engine asks `Core` whether a path is a brust route (matchit); if not, the request goes to the handler
  as today. Forge keeps owning `/rpc`, `/_dashboard`, `/api/auth`, storage and every non-compiled page.
- The compiler stays out of the engine. brust publishes prebuilt addons (`@brust/native-linux-x64-gnu`, ... alpha.38), so Forge's
  `build.ts` can call `compile` at build time without a nightly toolchain or Bun's git revision. Building the compiler from source
  needs `nightly-2026-09-15` and a pinned `oven-sh/bun` rev (their `Cargo.toml`); we do not want that in the engine's build.

### What forking is for

Not a fork of the whole repository. A **fork of the thin edges only**, if upstream will not take them:

1. `brust-core` exposing its `Host` seam without the `#[doc(hidden)]` fields (`Core.host`, `manifest`, `plans`), so we stop depending
   on "not an API" items.
2. A route-source adapter on the compiler side: Forge's `app/routes` manifest (`routes.ts`) to `defineRoutes` input, with
   `action`/`errorElement` routes marked "not compiled" so they stay on the React Router path.
3. A hook point in the compiler's tiering so Forge's own hooks (`useViewer`, `useQuery`) are recognized as "needs React" instead of
   an unknown-import fallback, keeping the diagnostics readable.

Everything else is used as published. Pin `brust-core` by git rev or vendor it under `crates/` with a `BRUST-PATCH.md`, the way brust
itself vendors `bun_react_compiler`. No GitHub fork is created without being asked.

## Scope (decided)

Taken from brust: the render pipeline in `brust-core` (routes, templates, layout chains, the loader call), the page cache (L1), compression and
static roots, and the compiler as a build step.

Left out on purpose:

- **The actions layer** (`/_brust/action`, its CORS and streamed-body rules): Forge already has `/rpc`, `/http` and Forge RPC. `actions` and `cors` stay `None` in `CoreConfig`.
- **Cloudflare / Workers** (`brust-wasm`, `core-cf`): not built, not depended on.
- **Caching of jobs** (the job cache, `JobStore`): jobs still run when a page needs one (a React island's SSR render is a job), but their results are not kept. The L2 (shared Redis/Cloudflare) tier is also left out.
- **brust's own dev server** (`brust dev`: a proxy and a restarted child per build): not used.

## Constraint: Forge's dev experience does not change

`archlast-forge dev`, `forge/` functions and codegen, `app/routes` conventions, `.forge/gen`, rebuild with live reload (`framework/dev.ts`) all stay as
they are. That decides what brust can be: an **optional render backend behind the existing conventions**, not a new authoring model.

- A route module keeps its React Router shape (`loader`, `Component`, ...). The framework's build asks the compiler whether it can render that
  route in Rust; if it can, the route is served by Rust, and if not (or if the route uses `action`, `errorElement`, a live-query hook outside an
  island, ...) it is rendered by today's `renderToReadableStream` path. No new file, no new field, no new command for the developer.
- In development the framework's existing rebuild recompiles the changed routes and the engine swaps its `Core` (the same way `reload()` swaps
  routes today). No second process and no proxy.
- **Open problem:** a page whose HTML comes from a brust template cannot be hydrated by `hydrateRoot` over the same route tree unless the markup is
  React's exactly. brust solves this with its own client (islands plus its navigation), so using its output means using its client for that route.
  Making that invisible to the developer is the hard part and phase 2 is where to find out whether it can be done. If it cannot, brust's contribution
  shrinks to the page cache and the compression/static pipeline in front of the existing SSR.

## Plan

| phase    | work                                                                                                                                                                                                                  | exit test                                                                                                                              |
| -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| 0 (done) | read brust; build `brust-core` on stable; map `Host`                                                                                                                                                                  | this document                                                                                                                          |
| 1        | `crates/render` in packages/serve: `EngineHost: Host`; boot `Core` from a `dist/manifest.json`; wire `loader`/`jobs` to lanes (new event/command kinds in `codec.ts` and `state.rs`); static + page-cache routes only | brust's pokedex example served by the engine; parity against `brust start` output (their parity normalizer)                            |
| 2        | `serveCompat` option `brust: { dist }`; Forge `build.ts` runs the compiler on routes that opt in (`export const render = "rust"` or a directory convention); the rest unchanged                                       | one Forge template page rendered by Rust, links between the two kinds are full document loads (the two navigations do not share state) |
| 3        | tags and `cache.invalidate` wired to Forge mutations; per-viewer cache keys (`ctx.auth` is already a cache key dimension in Forge's query cache)                                                                      | page cache hit never reaches JS; invalidation after a mutation                                                                         |
| 4        | measure in the pinned container against `renderToReadableStream` on the same page                                                                                                                                     | published numbers, or a stop decision                                                                                                  |

## Risks to decide on, in order

1. **Route fit.** If few Forge pages compile, the gain is small. Phase 2 measures this on the shadcn starter before any investment
   beyond phase 1. A stop after phase 1 still leaves the engine with a page cache.
2. **Alpha dependency.** brust is `2.0.0-alpha.38`, a young compiler whose tier decisions fail closed (good) but whose API can move.
   Pin the addon and `brust-core` by version.
3. **Two component models** on the same site (compiled pages with signals, React pages with hydrateRoot). Acceptable per route; not
   something to hide from users.
4. **Security.** Compiled pages need the CSP nonce and Forge's security headers (`SecurityHeaders`) applied on the way out; the
   engine must run the same `apply()` on Rust-rendered responses. `dangerouslySetInnerHTML` is raw in brust.
5. **Licence.** MIT; keep their notice (`THIRD_PARTY_NOTICES.md`) when vendoring.
