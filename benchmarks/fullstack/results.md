# Results

Machine: 11th Gen Intel(R) Core(TM) i7-11700 @ 2.50GHz, 16 threads; each server pinned to 4 cores and limited to 2 GiB of memory, load from 8 other threads. oha, 64 connections, 5 s per run, median of 3. 2026-11-08.

### Home page (no data)

| | requests/s | p50 ms | p99 ms | peak memory MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **304,374** | 0.2 | 0.3 | 113 | 0.9 | 1.3 |
| archlast-forge (islands, home rendered each time) | 44,620 | 1.3 | 2.9 | 129 | 0.9 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 16,203 | 3.7 | 7.2 | 136 | 1.3 | 121.6 |
| brust 2.0 alpha (brust start, Rust renderer) | 211,010 | 0.3 | 0.6 | 52 | 1.0 | 4.7 |
| React Router 7 (react-router-serve, Node) | 2,262 | 27.0 | 43.9 | 145 | 3.7 | 97.9 |
| Next.js 16 (next start, Node) | 3,694 | 16.8 | 26.5 | 143 | 6.4 | 169.7 |

### Products: 100 rows from the loader, price and date formatted in every row, formatters built per call (how this code is usually written)

| | requests/s | p50 ms | p99 ms | peak memory MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **3,340** | 18.9 | 22.9 | 131 | 10.4 | 1.3 |
| archlast-forge (islands, home rendered each time) | 3,324 | 18.9 | 22.4 | 159 | 10.4 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 1,917 | 32.8 | 51.0 | 162 | 21.6 | 122 |
| brust 2.0 alpha (brust start, Rust renderer) | 359 | 184 | 322 | 185 | 10.5 | 4.7 |
| React Router 7 (react-router-serve, Node) | 115 | 363 | 4,256 | 553 | 27.1 | 98.1 |
| Next.js 16 (next start, Node) | 81.8 | 426 | 4,332 | 388 | 44.7 | 169.7 |

### Products: the same page with the formatters built once

| | requests/s | p50 ms | p99 ms | peak memory MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | 5,875 | 10.8 | 14.1 | 130 | 10.4 | 1.3 |
| archlast-forge (islands, home rendered each time) | 5,701 | 11.1 | 14.5 | 165 | 10.4 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 2,549 | 24.5 | 35.0 | 167 | 21.6 | 122 |
| brust 2.0 alpha (brust start, Rust renderer) | **11,262** | 5.5 | 11.6 | 175 | 10.5 | 4.7 |
| React Router 7 (react-router-serve, Node) | 848 | 72.3 | 169 | 187 | 27.1 | 98.1 |
| Next.js 16 (next start, Node) | 228 | 270 | 2,457 | 207 | 44.7 | 169.7 |
