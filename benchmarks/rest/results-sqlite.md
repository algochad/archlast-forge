| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| Rust (Axum 0.8, Tokio, rusqlite) | 338,464 | 199,323 | 177,611 | 26,477 | 6 MiB |
| Tuyere (native App API, 3 I/O threads, bun:sqlite) | 332,438 | 136,423 | 265,413 | 30,817 | 31 MiB |
| NestJS on Tuyere (no Forge, a basic adapter, bun:sqlite) | 208,072 | 109,526 | 166,448 | 27,655 | 54 MiB |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | 188,158 | 118,485 | 94,543 | 10,505 | 33 MiB |
| Go (fasthttp, go-sqlite3) | 175,354 | 87,521 | 61,790 | 19,487 | 12 MiB |
| archlast-forge (forge/http.ts minimal routes, Tuyere, ctx.db) | 175,013 | 127,149 | 73,650 | 19,722 | 266 MiB |
| archlast-forge (NestJS path, Tuyere, bun:sqlite) | 157,236 | 107,637 | 86,377 | 20,451 | 269 MiB |
| archlast-forge (NestJS path, Tuyere, ctx.db) | 143,756 | 106,740 | 61,441 | 18,708 | 337 MiB |
| .NET 10 (Web API: controllers only, no middleware, Microsoft.Data.Sqlite) | 117,167 | 80,172 | 60,732 | 5,312 | 36 MiB |
| Bun.serve (bun:sqlite) | 102,001 | 62,078 | 49,413 | 18,988 | 21 MiB |
| .NET 10 (Web API: controllers and middleware, Microsoft.Data.Sqlite) | 85,609 | 62,764 | 52,540 | 12,567 | 46 MiB |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | 18,432 | 13,643 | 13,769 | 9,322 | 103 MiB |

Requests per second, median of the runs. Latency (p50 / p99, ms) and the CPU the server used:

| Server | Scenario | p50 | p99 | Cores used |
|---|---|---:|---:|---:|
| Rust (Axum 0.8, Tokio, rusqlite) | read | 0.184 | 0.363 | 3.16 |
| Rust (Axum 0.8, Tokio, rusqlite) | list | 0.315 | 0.633 | 3.41 |
| Rust (Axum 0.8, Tokio, rusqlite) | update | 0.348 | 0.733 | 2.57 |
| Rust (Axum 0.8, Tokio, rusqlite) | create | 1.382 | 8.333 | 0.91 |
| Tuyere (native App API, 3 I/O threads, bun:sqlite) | read | 0.169 | 0.566 | 2.65 |
| Tuyere (native App API, 3 I/O threads, bun:sqlite) | list | 0.417 | 1.071 | 1.75 |
| Tuyere (native App API, 3 I/O threads, bun:sqlite) | update | 0.225 | 0.526 | 2.47 |
| Tuyere (native App API, 3 I/O threads, bun:sqlite) | create | 0.972 | 7.481 | 0.76 |
| NestJS on Tuyere (no Forge, a basic adapter, bun:sqlite) | read | 0.293 | 0.787 | 1.87 |
| NestJS on Tuyere (no Forge, a basic adapter, bun:sqlite) | list | 0.537 | 1.19 | 1.44 |
| NestJS on Tuyere (no Forge, a basic adapter, bun:sqlite) | update | 0.367 | 0.87 | 1.78 |
| NestJS on Tuyere (no Forge, a basic adapter, bun:sqlite) | create | 1.142 | 8.421 | 0.74 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | read | 0.312 | 1.556 | 3.36 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | list | 0.513 | 1.472 | 3.55 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | update | 0.639 | 1.817 | 2.24 |
| .NET 10 (Minimal APIs, Microsoft.Data.Sqlite) | create | 3.362 | 205.299 | 0.8 |
| Go (fasthttp, go-sqlite3) | read | 0.283 | 1.356 | 3.37 |
| Go (fasthttp, go-sqlite3) | list | 0.561 | 2.86 | 3.56 |
| Go (fasthttp, go-sqlite3) | update | 0.728 | 4.605 | 1.7 |
| Go (fasthttp, go-sqlite3) | create | 1.691 | 15.709 | 0.98 |
| archlast-forge (forge/http.ts minimal routes, Tuyere, ctx.db) | read | 0.325 | 1.266 | 2.9 |
| archlast-forge (forge/http.ts minimal routes, Tuyere, ctx.db) | list | 0.443 | 1.474 | 2.8 |
| archlast-forge (forge/http.ts minimal routes, Tuyere, ctx.db) | update | 0.797 | 1.959 | 1.82 |
| archlast-forge (forge/http.ts minimal routes, Tuyere, ctx.db) | create | 2.933 | 6.997 | 1.63 |
| archlast-forge (NestJS path, Tuyere, bun:sqlite) | read | 0.376 | 1.329 | 2.01 |
| archlast-forge (NestJS path, Tuyere, bun:sqlite) | list | 0.572 | 1.734 | 1.99 |
| archlast-forge (NestJS path, Tuyere, bun:sqlite) | update | 0.483 | 2.979 | 1.44 |
| archlast-forge (NestJS path, Tuyere, bun:sqlite) | create | 1.675 | 11.85 | 0.94 |
| archlast-forge (NestJS path, Tuyere, ctx.db) | read | 0.389 | 1.553 | 2.91 |
| archlast-forge (NestJS path, Tuyere, ctx.db) | list | 0.55 | 1.777 | 2.8 |
| archlast-forge (NestJS path, Tuyere, ctx.db) | update | 0.947 | 2.448 | 1.85 |
| archlast-forge (NestJS path, Tuyere, ctx.db) | create | 3.012 | 8.023 | 1.69 |
| .NET 10 (Web API: controllers only, no middleware, Microsoft.Data.Sqlite) | read | 0.512 | 1.337 | 3.53 |
| .NET 10 (Web API: controllers only, no middleware, Microsoft.Data.Sqlite) | list | 0.763 | 1.679 | 3.62 |
| .NET 10 (Web API: controllers only, no middleware, Microsoft.Data.Sqlite) | update | 1.011 | 1.996 | 2.85 |
| .NET 10 (Web API: controllers only, no middleware, Microsoft.Data.Sqlite) | create | 3.369 | 157.229 | 0.49 |
| Bun.serve (bun:sqlite) | read | 0.591 | 1.208 | 0.84 |
| Bun.serve (bun:sqlite) | list | 0.983 | 1.929 | 0.87 |
| Bun.serve (bun:sqlite) | update | 1.165 | 2.671 | 0.87 |
| Bun.serve (bun:sqlite) | create | 2.247 | 8.699 | 0.67 |
| .NET 10 (Web API: controllers and middleware, Microsoft.Data.Sqlite) | read | 0.669 | 2.054 | 3.47 |
| .NET 10 (Web API: controllers and middleware, Microsoft.Data.Sqlite) | list | 0.938 | 2.472 | 3.54 |
| .NET 10 (Web API: controllers and middleware, Microsoft.Data.Sqlite) | update | 1.117 | 2.593 | 3.2 |
| .NET 10 (Web API: controllers and middleware, Microsoft.Data.Sqlite) | create | 3.812 | 63.044 | 1.36 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | read | 3.408 | 4.236 | 0.93 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | list | 4.605 | 6.7 | 0.97 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | update | 4.588 | 5.647 | 0.94 |
| NestJS on Node.js 24 (Express adapter, node:sqlite) | create | 5.686 | 12.906 | 0.82 |
