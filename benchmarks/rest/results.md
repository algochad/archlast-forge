| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | 556,334 | 306,858 | 487,527 | 490,500 | 26 MiB |
| archlast-serve (native App API, 3 I/O threads) | 493,662 | 361,024 | 392,359 | 352,873 | 106 MiB |
| Go (fasthttp) | 483,527 | 397,865 | 450,130 | 458,484 | 67 MiB |
| .NET 10 (Minimal APIs) | 399,712 | 347,109 | 341,848 | 306,066 | 70 MiB |
| archlast-forge (forge/http.ts light routes, archlast-serve) | 306,078 | 237,098 | 246,769 | 226,972 | 234 MiB |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | 172,030 | 141,447 | 127,302 | 117,821 | 210 MiB |
| archlast-forge (NestJS path, archlast-serve) | 151,079 | 133,364 | 120,762 | 109,043 | 255 MiB |
| Bun.serve | 142,882 | 108,589 | 92,094 | 81,816 | 97 MiB |
| archlast-forge (NestJS path, Bun.serve) | 34,362 | 30,813 | 25,560 | 24,880 | 196 MiB |
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
| archlast-forge (forge/http.ts light routes, archlast-serve) | read | 0.184 | 0.964 | 2.55 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | list | 0.237 | 0.988 | 2.28 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | update | 0.22 | 1.21 | 2.49 |
| archlast-forge (forge/http.ts light routes, archlast-serve) | create | 0.204 | 1.878 | 2.49 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | read | 0.337 | 1.315 | 2.03 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | list | 0.4 | 1.42 | 1.88 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | update | 0.447 | 1.694 | 1.85 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | create | 0.42 | 4.474 | 1.97 |
| archlast-forge (NestJS path, archlast-serve) | read | 0.401 | 1.375 | 1.88 |
| archlast-forge (NestJS path, archlast-serve) | list | 0.428 | 1.512 | 1.83 |
| archlast-forge (NestJS path, archlast-serve) | update | 0.518 | 1.653 | 1.78 |
| archlast-forge (NestJS path, archlast-serve) | create | 0.498 | 4.567 | 1.92 |
| Bun.serve | read | 0.426 | 0.863 | 0.79 |
| Bun.serve | list | 0.568 | 1.121 | 0.82 |
| Bun.serve | update | 0.664 | 1.331 | 0.84 |
| Bun.serve | create | 0.683 | 3.045 | 1.06 |
| archlast-forge (NestJS path, Bun.serve) | read | 1.776 | 3.541 | 0.92 |
| archlast-forge (NestJS path, Bun.serve) | list | 1.984 | 3.845 | 0.91 |
| archlast-forge (NestJS path, Bun.serve) | update | 2.38 | 4.735 | 0.93 |
| archlast-forge (NestJS path, Bun.serve) | create | 2.332 | 7.171 | 0.99 |
| Node.js 24 (Express 5) | read | 2.807 | 3.285 | 0.92 |
| Node.js 24 (Express 5) | list | 3.068 | 3.546 | 0.91 |
| Node.js 24 (Express 5) | update | 3.933 | 4.727 | 0.94 |
| Node.js 24 (Express 5) | create | 3.731 | 4.653 | 0.94 |
