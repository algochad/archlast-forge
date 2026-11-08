| Server | Read | List (20) | Update | Create | Peak memory |
|---|---:|---:|---:|---:|---:|
| Rust (Axum 0.8, Tokio) | 556,334 | 306,858 | 487,527 | 490,500 | 26 MiB |
| archlast-serve (native App API, 3 I/O threads) | 493,662 | 361,024 | 392,359 | 352,873 | 106 MiB |
| Go (fasthttp) | 483,527 | 397,865 | 450,130 | 458,484 | 67 MiB |
| .NET 10 (Minimal APIs) | 399,712 | 347,109 | 341,848 | 306,066 | 70 MiB |
| Bun.serve | 142,882 | 108,589 | 92,094 | 81,816 | 97 MiB |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | 131,430 | 115,507 | 106,665 | 97,251 | 211 MiB |
| archlast-forge (NestJS path, archlast-serve) | 114,500 | 102,570 | 100,453 | 90,155 | 247 MiB |
| archlast-forge (NestJS path, Bun.serve) | 33,995 | 30,861 | 25,740 | 24,322 | 195 MiB |
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
| Bun.serve | read | 0.426 | 0.863 | 0.79 |
| Bun.serve | list | 0.568 | 1.121 | 0.82 |
| Bun.serve | update | 0.664 | 1.331 | 0.84 |
| Bun.serve | create | 0.683 | 3.045 | 1.06 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | read | 0.463 | 1.48 | 1.76 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | list | 0.541 | 1.606 | 1.7 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | update | 0.531 | 1.89 | 1.71 |
| archlast-forge (NestJS path, archlast-serve, telemetry off) | create | 0.563 | 4.786 | 1.82 |
| archlast-forge (NestJS path, archlast-serve) | read | 0.534 | 1.709 | 1.69 |
| archlast-forge (NestJS path, archlast-serve) | list | 0.673 | 1.77 | 1.63 |
| archlast-forge (NestJS path, archlast-serve) | update | 0.605 | 1.856 | 1.66 |
| archlast-forge (NestJS path, archlast-serve) | create | 0.561 | 5.028 | 1.74 |
| archlast-forge (NestJS path, Bun.serve) | read | 1.795 | 3.568 | 0.92 |
| archlast-forge (NestJS path, Bun.serve) | list | 1.981 | 3.866 | 0.91 |
| archlast-forge (NestJS path, Bun.serve) | update | 2.369 | 4.688 | 0.93 |
| archlast-forge (NestJS path, Bun.serve) | create | 2.389 | 7.378 | 1.03 |
| Node.js 24 (Express 5) | read | 2.807 | 3.285 | 0.92 |
| Node.js 24 (Express 5) | list | 3.068 | 3.546 | 0.91 |
| Node.js 24 (Express 5) | update | 3.933 | 4.727 | 0.94 |
| Node.js 24 (Express 5) | create | 3.731 | 4.653 | 0.94 |
