# Results

Machine: 11th Gen Intel(R) Core(TM) i7-11700 @ 2.50GHz, 16 threads; servers pinned to 4 cores, load from 4 others. oha, 64 connections, 5 s per run, median of 3. 2026-11-08.

### Home page (no data)

| | requests/s | p50 ms | p99 ms | server RSS MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **299,111** | 0.2 | 0.3 | 108 | 0.9 | 1.3 |
| archlast-forge (islands, home rendered each time) | 43,554 | 1.4 | 3.9 | 231 | 0.9 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 16,713 | 3.6 | 5.8 | 204 | 1.3 | 121.6 |
| React Router 7 (react-router-serve, Node) | 2,449 | 25.6 | 35.4 | 295 | 3.7 | 97.9 |
| Next.js 16 (next start, Node) | 4,046 | 15.5 | 20.7 | 277 | 6.4 | 169.7 |

### Products: 100 rows from the loader, price and date formatted in every row, formatters built per call (how this code is usually written)

| | requests/s | p50 ms | p99 ms | server RSS MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **3,480** | 18.3 | 22.6 | 211 | 10.4 | 1.3 |
| archlast-forge (islands, home rendered each time) | 3,318 | 19.2 | 24.0 | 238 | 10.4 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 1,969 | 32.4 | 49.0 | 255 | 21.6 | 122 |
| React Router 7 (react-router-serve, Node) | 113 | 367 | 4,111 | 2080 | 27.1 | 98.1 |
| Next.js 16 (next start, Node) | 84.8 | 433 | 4,377 | 1454 | 44.7 | 169.7 |

### Products: the same page with the formatters built once

| | requests/s | p50 ms | p99 ms | server RSS MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **5,995** | 10.5 | 13.4 | 199 | 10.4 | 1.3 |
| archlast-forge (islands, home rendered each time) | 5,804 | 10.8 | 14.3 | 235 | 10.4 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 2,660 | 23.9 | 36.1 | 232 | 21.6 | 122 |
| React Router 7 (react-router-serve, Node) | 902 | 70.4 | 132 | 345 | 27.1 | 98.1 |
| Next.js 16 (next start, Node) | 249 | 251 | 2,169 | 406 | 44.7 | 169.7 |
