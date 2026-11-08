| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| archlast-serve (native App API, 3 I/O threads, bun:sqlite) | 369,695 | 156,134 | 266,164 | 31,326 | 34 MiB |
| Rust (Axum 0.8, Tokio, rusqlite) | 362,227 | 196,657 | 182,745 | 27,281 | 6 MiB |
| archlast-forge (forge/http.ts light routes, archlast-serve, bun:sqlite) | 214,328 | 108,078 | 150,983 | 26,788 | 103 MiB |
| NestJS on archlast-serve (no Forge, a basic adapter, bun:sqlite) | 201,986 | 102,041 | 149,604 | 27,676 | 56 MiB |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | 189,697 | 120,579 | 97,017 | 10,985 | 33 MiB |
| Go (fasthttp, go-sqlite3) | 181,957 | 88,679 | 63,319 | 19,761 | 12 MiB |
| archlast-forge (NestJS path, archlast-serve, bun:sqlite) | 119,299 | 73,461 | 92,026 | 24,994 | 139 MiB |
| Bun.serve (bun:sqlite) | 101,684 | 63,859 | 60,555 | 19,528 | 21 MiB |
| archlast-forge (forge/http.ts light routes, archlast-serve, ctx.db) | 86,895 | 56,963 | 46,731 | 10,474 | 180 MiB |
| archlast-forge (NestJS path, archlast-serve, telemetry off, ctx.db) | 72,162 | 48,672 | 40,447 | 9,736 | 184 MiB |
| archlast-forge (NestJS path, archlast-serve, ctx.db) | 66,457 | 47,199 | 39,043 | 8,526 | 212 MiB |
| NestJS on Bun (Express adapter, bun:sqlite) | 30,720 | 25,997 | 20,008 | 11,910 | 85 MiB |
| archlast-forge (NestJS path, Bun.serve, ctx.db) | 21,227 | 17,975 | 25,100 | 8,792 | 198 MiB |
| Node.js 24 (Express 5, node:sqlite) | 18,845 | 14,302 | 14,329 | 10,016 | 96 MiB |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | 18,424 | 13,632 | 13,558 | 9,969 | 101 MiB |

Requests per second, median of the runs. Latency (p50 / p99, ms) and the CPU the server used:

| Server | Scenario | p50 | p99 | Cores used |
|---|---|---:|---:|---:|
| archlast-serve (native App API, 3 I/O threads, bun:sqlite) | read | 0.161 | 0.417 | 2.74 |
| archlast-serve (native App API, 3 I/O threads, bun:sqlite) | list | 0.389 | 0.703 | 1.79 |
| archlast-serve (native App API, 3 I/O threads, bun:sqlite) | update | 0.226 | 0.514 | 2.5 |
| archlast-serve (native App API, 3 I/O threads, bun:sqlite) | create | 0.96 | 7.306 | 0.76 |
| Rust (Axum 0.8, Tokio, rusqlite) | read | 0.172 | 0.319 | 3.21 |
| Rust (Axum 0.8, Tokio, rusqlite) | list | 0.324 | 0.582 | 3.43 |
| Rust (Axum 0.8, Tokio, rusqlite) | update | 0.337 | 0.707 | 2.52 |
| Rust (Axum 0.8, Tokio, rusqlite) | create | 1.344 | 8.184 | 0.91 |
| archlast-forge (forge/http.ts light routes, archlast-serve, bun:sqlite) | read | 0.268 | 0.934 | 2.13 |
| archlast-forge (forge/http.ts light routes, archlast-serve, bun:sqlite) | list | 0.542 | 1.397 | 1.58 |
| archlast-forge (forge/http.ts light routes, archlast-serve, bun:sqlite) | update | 0.38 | 1.317 | 1.93 |
| archlast-forge (forge/http.ts light routes, archlast-serve, bun:sqlite) | create | 1.21 | 8.21 | 0.8 |
| NestJS on archlast-serve (no Forge, a basic adapter, bun:sqlite) | read | 0.282 | 0.784 | 1.78 |
| NestJS on archlast-serve (no Forge, a basic adapter, bun:sqlite) | list | 0.565 | 1.307 | 1.41 |
| NestJS on archlast-serve (no Forge, a basic adapter, bun:sqlite) | update | 0.381 | 0.977 | 1.67 |
| NestJS on archlast-serve (no Forge, a basic adapter, bun:sqlite) | create | 1.162 | 7.793 | 0.75 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | read | 0.308 | 1.513 | 3.36 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | list | 0.503 | 1.366 | 3.56 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | update | 0.621 | 1.728 | 2.23 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | create | 3.191 | 142.548 | 0.79 |
| Go (fasthttp, go-sqlite3) | read | 0.274 | 1.235 | 3.44 |
| Go (fasthttp, go-sqlite3) | list | 0.554 | 2.846 | 3.56 |
| Go (fasthttp, go-sqlite3) | update | 0.711 | 4.504 | 1.72 |
| Go (fasthttp, go-sqlite3) | create | 1.669 | 15.294 | 0.98 |
| archlast-forge (NestJS path, archlast-serve, bun:sqlite) | read | 0.486 | 1.442 | 1.61 |
| archlast-forge (NestJS path, archlast-serve, bun:sqlite) | list | 0.793 | 1.968 | 1.42 |
| archlast-forge (NestJS path, archlast-serve, bun:sqlite) | update | 0.669 | 1.873 | 1.59 |
| archlast-forge (NestJS path, archlast-serve, bun:sqlite) | create | 1.554 | 8.176 | 0.85 |
| Bun.serve (bun:sqlite) | read | 0.604 | 1.21 | 0.83 |
| Bun.serve (bun:sqlite) | list | 0.975 | 1.91 | 0.87 |
| Bun.serve (bun:sqlite) | update | 1.023 | 2.03 | 0.86 |
| Bun.serve (bun:sqlite) | create | 2.216 | 8.128 | 0.67 |
| archlast-forge (forge/http.ts light routes, archlast-serve, ctx.db) | read | 0.656 | 1.692 | 1.65 |
| archlast-forge (forge/http.ts light routes, archlast-serve, ctx.db) | list | 1.023 | 2.14 | 1.45 |
| archlast-forge (forge/http.ts light routes, archlast-serve, ctx.db) | update | 1.298 | 2.767 | 1.31 |
| archlast-forge (forge/http.ts light routes, archlast-serve, ctx.db) | create | 4.27 | 21.396 | 0.85 |
| archlast-forge (NestJS path, archlast-serve, telemetry off, ctx.db) | read | 0.8 | 2.02 | 1.64 |
| archlast-forge (NestJS path, archlast-serve, telemetry off, ctx.db) | list | 1.187 | 2.615 | 1.5 |
| archlast-forge (NestJS path, archlast-serve, telemetry off, ctx.db) | update | 1.503 | 3.359 | 1.33 |
| archlast-forge (NestJS path, archlast-serve, telemetry off, ctx.db) | create | 4.662 | 29.456 | 0.91 |
| archlast-forge (NestJS path, archlast-serve, ctx.db) | read | 0.866 | 2.183 | 1.62 |
| archlast-forge (NestJS path, archlast-serve, ctx.db) | list | 1.225 | 2.76 | 1.49 |
| archlast-forge (NestJS path, archlast-serve, ctx.db) | update | 1.742 | 3.383 | 1.33 |
| archlast-forge (NestJS path, archlast-serve, ctx.db) | create | 4.153 | 205.497 | 0.73 |
| NestJS on Bun (Express adapter, bun:sqlite) | read | 2.009 | 2.914 | 0.92 |
| NestJS on Bun (Express adapter, bun:sqlite) | list | 2.378 | 3.234 | 0.91 |
| NestJS on Bun (Express adapter, bun:sqlite) | update | 3.116 | 4.077 | 0.93 |
| NestJS on Bun (Express adapter, bun:sqlite) | create | 4.302 | 10.678 | 0.8 |
| archlast-forge (NestJS path, Bun.serve, ctx.db) | read | 2.895 | 5.552 | 0.94 |
| archlast-forge (NestJS path, Bun.serve, ctx.db) | list | 3.44 | 4.865 | 0.94 |
| archlast-forge (NestJS path, Bun.serve, ctx.db) | update | 2.277 | 5.67 | 1.01 |
| archlast-forge (NestJS path, Bun.serve, ctx.db) | create | 4.945 | 127.756 | 0.79 |
| Node.js 24 (Express 5, node:sqlite) | read | 3.341 | 3.903 | 0.93 |
| Node.js 24 (Express 5, node:sqlite) | list | 4.398 | 6.299 | 0.96 |
| Node.js 24 (Express 5, node:sqlite) | update | 4.436 | 5.228 | 0.94 |
| Node.js 24 (Express 5, node:sqlite) | create | 5.455 | 12.03 | 0.83 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | read | 3.417 | 4.073 | 0.93 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | list | 4.604 | 6.581 | 0.97 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | update | 4.646 | 5.546 | 0.95 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | create | 5.533 | 12.273 | 0.85 |
