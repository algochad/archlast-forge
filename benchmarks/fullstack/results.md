# Results

Machine: 11th Gen Intel(R) Core(TM) i7-11700 @ 2.50GHz, 16 threads; servers pinned to 4 cores, load from 4 others. oha, 64 connections, 5 s per run, median of 3. 2026-11-08.

### Home page (no data)

| | requests/s | p50 ms | p99 ms | server RSS MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **295,884** | 0.2 | 0.3 | 110 | 0.9 | 1.3 |
| archlast-forge (islands, home rendered each time) | 18,128 | 3.3 | 6.6 | 205 | 0.9 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 16,981 | 3.7 | 5.9 | 198 | 1.3 | 121.6 |
| React Router 7 (react-router-serve, Node) | 2,379 | 25.8 | 42.2 | 296 | 3.7 | 97.9 |
| Next.js 16 (next start, Node) | 4,031 | 15.4 | 21.0 | 273 | 6.4 | 169.7 |

### Products: 100 rows from the loader, price and date formatted in every row, formatters built per call (how this code is usually written)

| | requests/s | p50 ms | p99 ms | server RSS MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | **2,164** | 29.1 | 43.6 | 213 | 10.4 | 1.3 |
| archlast-forge (islands, home rendered each time) | 2,143 | 30.0 | 38.9 | 245 | 10.4 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 1,915 | 32.9 | 49.1 | 231 | 21.6 | 122 |
| React Router 7 (react-router-serve, Node) | 114 | 377 | 4,165 | 2015 | 27.1 | 98.1 |
| Next.js 16 (next start, Node) | 87.8 | 432 | 4,373 | 1498 | 44.7 | 169.7 |

### Products: the same page with the formatters built once

| | requests/s | p50 ms | p99 ms | server RSS MB | HTML KB | JS to download (gzip KB) |
|---|---:|---:|---:|---:|---:|---:|
| archlast-forge (as scaffolded: islands + kept home) | 2,962 | 21.5 | 26.3 | 212 | 10.4 | 1.3 |
| archlast-forge (islands, home rendered each time) | **2,966** | 21.5 | 30.0 | 245 | 10.4 | 1.3 |
| archlast-forge (whole-page hydration, like React Router) | 2,636 | 24.1 | 34.6 | 257 | 21.6 | 122 |
| React Router 7 (react-router-serve, Node) | 896 | 70.5 | 151 | 341 | 27.1 | 98.1 |
| Next.js 16 (next start, Node) | 241 | 252 | 2,192 | 380 | 44.7 | 169.7 |
