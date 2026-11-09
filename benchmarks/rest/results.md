| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | 497,346 | 302,658 | 467,117 | 476,558 | 25 MiB |
| Go (fasthttp) | 457,135 | 380,759 | 412,648 | 461,824 | 68 MiB |
| Tuyere (native App API, 3 I/O threads) | 456,161 | 358,628 | 411,772 | 347,316 | 110 MiB |
| .NET 10 (Minimal APIs) | 392,989 | 305,788 | 345,777 | 306,551 | 76 MiB |
| archlast-forge (forge/http.ts minimal routes, Tuyere) | 336,018 | 251,478 | 261,625 | 234,766 | 267 MiB |
| NestJS on Tuyere (no Forge, a basic adapter) | 290,605 | 218,327 | 243,649 | 221,570 | 134 MiB |
| archlast-forge (NestJS path, Tuyere, telemetry off) | 188,862 | 147,532 | 137,816 | 122,752 | 224 MiB |
| archlast-forge (NestJS path, Tuyere) | 175,874 | 133,301 | 127,514 | 113,262 | 270 MiB |
| Bun.serve | 143,497 | 111,052 | 90,799 | 81,450 | 92 MiB |
| NestJS on Bun (Express adapter) | 38,744 | 35,168 | 22,949 | 21,416 | 156 MiB |
| archlast-forge (NestJS path, Bun.serve) | 37,971 | 32,708 | 27,535 | 26,192 | 224 MiB |
| NestJS on Node.js 24 (Express adapter) | 23,057 | 20,131 | 15,605 | 16,749 | 132 MiB |
| Node.js 24 (Express 5) | 22,579 | 20,528 | 16,311 | 17,282 | 131 MiB |

Requests per second, median of the runs. Latency (p50 / p99, ms) and the CPU the server used:

| Server | Scenario | p50 | p99 | Cores used |
|---|---|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | read | 0.058 | 2.033 | 2.89 |
| Rust (Axum 0.8, Tokio) | list | 0.209 | 0.385 | 3.17 |
| Rust (Axum 0.8, Tokio) | update | 0.066 | 2.053 | 3.13 |
| Rust (Axum 0.8, Tokio) | create | 0.124 | 0.318 | 3.08 |
| Go (fasthttp) | read | 0.076 | 1.458 | 2.37 |
| Go (fasthttp) | list | 0.116 | 1.433 | 2.99 |
| Go (fasthttp) | update | 0.072 | 1.952 | 2.84 |
| Go (fasthttp) | create | 0.113 | 0.475 | 3.11 |
| Tuyere (native App API, 3 I/O threads) | read | 0.12 | 0.531 | 2.93 |
| Tuyere (native App API, 3 I/O threads) | list | 0.163 | 0.501 | 2.67 |
| Tuyere (native App API, 3 I/O threads) | update | 0.134 | 0.573 | 3.02 |
| Tuyere (native App API, 3 I/O threads) | create | 0.138 | 1.352 | 2.75 |
| .NET 10 (Minimal APIs) | read | 0.136 | 1.097 | 3.03 |
| .NET 10 (Minimal APIs) | list | 0.18 | 1.008 | 3.16 |
| .NET 10 (Minimal APIs) | update | 0.155 | 1.098 | 3.27 |
| .NET 10 (Minimal APIs) | create | 0.167 | 1.465 | 2.92 |
| archlast-forge (forge/http.ts minimal routes, Tuyere) | read | 0.168 | 0.822 | 2.65 |
| archlast-forge (forge/http.ts minimal routes, Tuyere) | list | 0.224 | 0.94 | 2.33 |
| archlast-forge (forge/http.ts minimal routes, Tuyere) | update | 0.211 | 1.133 | 2.53 |
| archlast-forge (forge/http.ts minimal routes, Tuyere) | create | 0.198 | 1.973 | 2.51 |
| NestJS on Tuyere (no Forge, a basic adapter) | read | 0.203 | 0.674 | 2.2 |
| NestJS on Tuyere (no Forge, a basic adapter) | list | 0.289 | 0.814 | 1.94 |
| NestJS on Tuyere (no Forge, a basic adapter) | update | 0.244 | 0.794 | 2.18 |
| NestJS on Tuyere (no Forge, a basic adapter) | create | 0.228 | 1.992 | 2.14 |
| archlast-forge (NestJS path, Tuyere, telemetry off) | read | 0.314 | 1.165 | 2.04 |
| archlast-forge (NestJS path, Tuyere, telemetry off) | list | 0.427 | 1.379 | 1.8 |
| archlast-forge (NestJS path, Tuyere, telemetry off) | update | 0.431 | 1.615 | 1.88 |
| archlast-forge (NestJS path, Tuyere, telemetry off) | create | 0.442 | 4.167 | 1.9 |
| archlast-forge (NestJS path, Tuyere) | read | 0.335 | 1.217 | 1.91 |
| archlast-forge (NestJS path, Tuyere) | list | 0.438 | 1.432 | 1.66 |
| archlast-forge (NestJS path, Tuyere) | update | 0.452 | 1.641 | 1.76 |
| archlast-forge (NestJS path, Tuyere) | create | 0.457 | 4.312 | 1.83 |
| Bun.serve | read | 0.423 | 0.86 | 0.78 |
| Bun.serve | list | 0.551 | 1.081 | 0.81 |
| Bun.serve | update | 0.671 | 1.348 | 0.84 |
| Bun.serve | create | 0.686 | 2.965 | 1.04 |
| NestJS on Bun (Express adapter) | read | 1.575 | 2.556 | 0.91 |
| NestJS on Bun (Express adapter) | list | 1.736 | 2.677 | 0.9 |
| NestJS on Bun (Express adapter) | update | 2.661 | 4.466 | 0.92 |
| NestJS on Bun (Express adapter) | create | 2.535 | 7.701 | 1.15 |
| archlast-forge (NestJS path, Bun.serve) | read | 1.604 | 3.219 | 0.92 |
| archlast-forge (NestJS path, Bun.serve) | list | 1.862 | 3.691 | 0.91 |
| archlast-forge (NestJS path, Bun.serve) | update | 2.207 | 4.394 | 0.93 |
| archlast-forge (NestJS path, Bun.serve) | create | 2.214 | 7.249 | 0.99 |
| NestJS on Node.js 24 (Express adapter) | read | 2.716 | 3.336 | 0.92 |
| NestJS on Node.js 24 (Express adapter) | list | 3.128 | 3.824 | 0.92 |
| NestJS on Node.js 24 (Express adapter) | update | 4.078 | 4.906 | 0.94 |
| NestJS on Node.js 24 (Express adapter) | create | 3.775 | 4.8 | 0.94 |
| Node.js 24 (Express 5) | read | 2.793 | 3.47 | 0.92 |
| Node.js 24 (Express 5) | list | 3.077 | 3.838 | 0.92 |
| Node.js 24 (Express 5) | update | 3.849 | 4.869 | 0.94 |
| Node.js 24 (Express 5) | create | 3.63 | 4.695 | 0.94 |
