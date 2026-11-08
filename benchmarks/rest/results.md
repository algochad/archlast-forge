| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | 556,334 | 306,858 | 487,527 | 490,500 | 26 MiB |
| archlast-serve (native App API, 3 I/O threads) | 493,662 | 361,024 | 392,359 | 352,873 | 106 MiB |
| Go (fasthttp) | 483,527 | 397,865 | 450,130 | 458,484 | 67 MiB |
| .NET 10 (Minimal APIs) | 399,712 | 347,109 | 341,848 | 306,066 | 70 MiB |
| archlast-forge (forge/http.ts light routes, archlast-serve) | 328,080 | 249,418 | 260,617 | 240,264 | 247 MiB |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | 177,181 | 158,322 | 130,741 | 121,959 | 238 MiB |
| archlast-forge (NestJS path, archlast-serve) | 152,116 | 140,668 | 122,569 | 117,999 | 278 MiB |
| Bun.serve | 142,882 | 108,589 | 92,094 | 81,816 | 97 MiB |
| NestJS on Bun (Express adapter) | 38,122 | 34,027 | 22,919 | 21,135 | 138 MiB |
| archlast-forge (NestJS path, Bun.serve) | 35,667 | 32,302 | 26,826 | 26,278 | 198 MiB |
| NestJS on Node.js 24 (Express adapter) | 22,670 | 19,896 | 15,566 | 17,090 | 123 MiB |
| Node.js 24 (Express 5) | 22,408 | 20,694 | 16,090 | 16,925 | 122 MiB |

Requests per second, median of the runs. Latency (p50 / p99, ms) and the CPU the server used:

| Server | Scenario | p50 | p99 | Cores used |
|---|---|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | read | 0.107 | 0.22 | 2.95 |
| Rust (Axum 0.8, Tokio) | list | 0.206 | 0.374 | 3.25 |
| Rust (Axum 0.8, Tokio) | update | 0.123 | 0.256 | 3.12 |
| Rust (Axum 0.8, Tokio) | create | 0.127 | 0.248 | 3.13 |
| archlast-serve (native App API, 3 I/O threads) | read | 0.116 | 0.408 | 3.02 |
| archlast-serve (native App API, 3 I/O threads) | list | 0.162 | 0.488 | 2.67 |
| archlast-serve (native App API, 3 I/O threads) | update | 0.135 | 0.612 | 2.96 |
| archlast-serve (native App API, 3 I/O threads) | create | 0.133 | 1.277 | 2.78 |
| Go (fasthttp) | read | 0.106 | 0.536 | 2.49 |
| Go (fasthttp) | list | 0.114 | 0.995 | 3.09 |
| Go (fasthttp) | update | 0.115 | 0.437 | 3.14 |
| Go (fasthttp) | create | 0.115 | 0.421 | 3.17 |
| .NET 10 (Minimal APIs) | read | 0.139 | 0.574 | 2.9 |
| .NET 10 (Minimal APIs) | list | 0.17 | 0.508 | 2.96 |
| .NET 10 (Minimal APIs) | update | 0.166 | 0.932 | 3 |
| .NET 10 (Minimal APIs) | create | 0.169 | 1.511 | 2.79 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | read | 0.173 | 0.894 | 2.62 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | list | 0.23 | 0.902 | 2.3 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | update | 0.212 | 1.145 | 2.52 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | create | 0.196 | 1.861 | 2.53 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | read | 0.342 | 1.266 | 2.05 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | list | 0.349 | 1.297 | 1.95 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | update | 0.479 | 1.596 | 1.88 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | create | 0.413 | 4.219 | 1.95 |
| archlast-forge (NestJS path, archlast-serve) | read | 0.408 | 1.421 | 1.92 |
| archlast-forge (NestJS path, archlast-serve) | list | 0.395 | 1.443 | 1.85 |
| archlast-forge (NestJS path, archlast-serve) | update | 0.505 | 1.637 | 1.78 |
| archlast-forge (NestJS path, archlast-serve) | create | 0.417 | 4.348 | 1.92 |
| Bun.serve | read | 0.426 | 0.863 | 0.79 |
| Bun.serve | list | 0.568 | 1.121 | 0.82 |
| Bun.serve | update | 0.664 | 1.331 | 0.84 |
| Bun.serve | create | 0.683 | 3.045 | 1.06 |
| NestJS on Bun (Express adapter) | read | 1.604 | 2.556 | 0.91 |
| NestJS on Bun (Express adapter) | list | 1.811 | 2.616 | 0.9 |
| NestJS on Bun (Express adapter) | update | 2.702 | 3.803 | 0.93 |
| NestJS on Bun (Express adapter) | create | 2.521 | 7.542 | 1.15 |
| archlast-forge (NestJS path, Bun.serve) | read | 1.715 | 3.405 | 0.91 |
| archlast-forge (NestJS path, Bun.serve) | list | 1.902 | 3.658 | 0.91 |
| archlast-forge (NestJS path, Bun.serve) | update | 2.273 | 4.521 | 0.93 |
| archlast-forge (NestJS path, Bun.serve) | create | 2.235 | 6.565 | 0.96 |
| NestJS on Node.js 24 (Express adapter) | read | 2.772 | 3.486 | 0.91 |
| NestJS on Node.js 24 (Express adapter) | list | 3.172 | 3.848 | 0.92 |
| NestJS on Node.js 24 (Express adapter) | update | 4.055 | 4.802 | 0.94 |
| NestJS on Node.js 24 (Express adapter) | create | 3.655 | 4.823 | 0.94 |
| Node.js 24 (Express 5) | read | 2.807 | 3.285 | 0.92 |
| Node.js 24 (Express 5) | list | 3.068 | 3.546 | 0.91 |
| Node.js 24 (Express 5) | update | 3.933 | 4.727 | 0.94 |
| Node.js 24 (Express 5) | create | 3.731 | 4.653 | 0.94 |
