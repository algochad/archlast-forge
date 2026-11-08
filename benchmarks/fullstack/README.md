# archlast-forge against React Router and Next.js

The same two pages in three frameworks, each built for production and served the way it ships:

| | what runs | notes |
|---|---|---|
| archlast-forge | `archlast/server.ts`: a project made from the starter, built with the framework, served by the native engine (Bun, Rust I/O threads) | three variants: as the starters ship (islands, the home page kept by the engine), islands with the home page rendered on every request, and whole-page hydration (the React Router way) |
| React Router 7 | framework mode, default entry files, `react-router-serve` (Node, one process) | |
| Next.js 16 | App Router, `next start` (Node, one process) | `/` is prerendered at build time (Next's default for a page with no data); `/products` is `force-dynamic` |

Pages: `/` has a header, three cards and a footer, no data. `/products` renders 100 rows from a loader (a table with a price and a date formatted in every row). The data and the formatting code are shared (`shared/data.ts`) and are built per call, as such code is usually written. A second run builds the formatters once (`CACHE_INTL=1`): archlast-forge also makes formatters once by itself on the server, so the first run shows what that is worth.

Method (`run.sh`): each server is pinned to cores 0-3 and loaded from cores 4-7 with [oha](https://github.com/hatoo/oha), 64 connections, 5 s per run, median of 3, after two warm-up requests. Node servers are single processes, as `react-router-serve` and `next start` run by default; the engine uses Rust threads for I/O and one Bun thread for the app. Memory is the server's resident size after the runs.

```
(cd react-router && bun install && node node_modules/@react-router/dev/bin.js build)
(cd next && bun install && node node_modules/next/dist/bin/next build)
./run.sh && bun report.ts      # writes results.raw and results.md
```

Read it with these in mind:

- The pages have nothing interactive. That is the case where islands send no framework JavaScript (the pages carry a 1.3 kB navigation script); a page with an island ships about what whole-page hydration does (about 120 kB gzip). React Router and Next send their runtime for every page.
- No database, no authentication and no streaming are involved: this measures rendering and serving, not the app around it. Real pages cost more (see the ERP numbers in `packages/serve/docs/fullstack.md`).
- One machine, one run of three medians. Latency under 64 connections on a single JS thread is mostly queueing; compare the requests per second.
- A kept page is the same bytes for everyone who is not signed in, up to its `ttl`. That is its whole point, and also why it is only for pages that are the same for everyone.
