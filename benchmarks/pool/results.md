| | requests/s | p50 | p99 | cores used |
|---|---:|---:|---:|---:|
| Work on the serving thread | 133 | 238.68 ms | 318.46 ms | 1.02 |
| Work in the pool | 401 | 80.73 ms | 105.4 ms | 3.14 |

`/ping` (does nothing) while the work route is under load:

| | requests/s | p50 | p99 |
|---|---:|---:|---:|
| Idle server | 23,519 | 0.16 ms | 0.29 ms |
| Work on the serving thread | 17 | 241.8 ms | 339.91 ms |
| Work in the pool | 14,543 | 0.24 ms | 0.71 ms |
