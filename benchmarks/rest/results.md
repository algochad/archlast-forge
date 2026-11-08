| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | 556,334 | 306,858 | 487,527 | 490,500 | 26 MiB |
| Go (fasthttp) | 483,527 | 397,865 | 450,130 | 458,484 | 67 MiB |
| .NET 10 (Minimal APIs) | 399,712 | 347,109 | 341,848 | 306,066 | 70 MiB |
| Bun.serve | 142,882 | 108,589 | 92,094 | 81,816 | 97 MiB |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | 35,414 | 33,213 | 30,164 | 27,920 | 215 MiB |
| archlast-forge (NestJS path, archlast-serve) | 33,602 | 31,122 | 29,605 | 26,680 | 249 MiB |
| Node.js 24 (Express 5) | 22,408 | 20,694 | 16,090 | 16,925 | 122 MiB |
| archlast-forge (NestJS path, Bun.serve) | 18,849 | 17,547 | 15,635 | 14,549 | 197 MiB |

Requests per second, median of the runs. Latency (p50 / p99, ms) and the CPU the server used:

| Server | Scenario | p50 | p99 | Cores used |
|---|---|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | read | 0.107 | 0.22 | 2.95 |
| Rust (Axum 0.8, Tokio) | list | 0.206 | 0.374 | 3.25 |
| Rust (Axum 0.8, Tokio) | update | 0.123 | 0.256 | 3.12 |
| Rust (Axum 0.8, Tokio) | create | 0.127 | 0.248 | 3.13 |
| Go (fasthttp) | read | 0.106 | 0.536 | 2.49 |
| Go (fasthttp) | list | 0.114 | 0.995 | 3.09 |
| Go (fasthttp) | update | 0.115 | 0.437 | 3.14 |
| Go (fasthttp) | create | 0.115 | 0.421 | 3.17 |
| .NET 10 (Minimal APIs) | read | 0.139 | 0.574 | 2.9 |
| .NET 10 (Minimal APIs) | list | 0.17 | 0.508 | 2.96 |
| .NET 10 (Minimal APIs) | update | 0.166 | 0.932 | 3 |
| .NET 10 (Minimal APIs) | create | 0.169 | 1.511 | 2.79 |
| Bun.serve | read | 0.426 | 0.863 | 0.79 |
| Bun.serve | list | 0.568 | 1.121 | 0.82 |
| Bun.serve | update | 0.664 | 1.331 | 0.84 |
| Bun.serve | create | 0.683 | 3.045 | 1.06 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | read | 1.961 | 3.709 | 1.23 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | list | 2.065 | 4.055 | 1.26 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | update | 2.166 | 4.382 | 1.25 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | create | 2.349 | 7.288 | 1.34 |
| archlast-forge (NestJS path, archlast-serve) | read | 2.15 | 3.98 | 1.23 |
| archlast-forge (NestJS path, archlast-serve) | list | 1.885 | 4.022 | 1.22 |
| archlast-forge (NestJS path, archlast-serve) | update | 2.386 | 4.362 | 1.24 |
| archlast-forge (NestJS path, archlast-serve) | create | 2.139 | 7.488 | 1.32 |
| Node.js 24 (Express 5) | read | 2.807 | 3.285 | 0.92 |
| Node.js 24 (Express 5) | list | 3.068 | 3.546 | 0.91 |
| Node.js 24 (Express 5) | update | 3.933 | 4.727 | 0.94 |
| Node.js 24 (Express 5) | create | 3.731 | 4.653 | 0.94 |
| archlast-forge (NestJS path, Bun.serve) | read | 3.241 | 6.405 | 0.95 |
| archlast-forge (NestJS path, Bun.serve) | list | 3.499 | 5.154 | 0.94 |
| archlast-forge (NestJS path, Bun.serve) | update | 3.892 | 7.556 | 0.95 |
| archlast-forge (NestJS path, Bun.serve) | create | 3.95 | 9.762 | 1.05 |
