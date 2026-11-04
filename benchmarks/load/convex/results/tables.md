
#### A. Cached query, closed loop (64 connections), one hot list

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 73,548 (70,485–74,553) | 0.82 (0.81–0.85) | 1.00 (0.99–1.10) | 1.74 (1.73–1.88) | 0 | 104 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 75,500 (72,663–76,608) | 0.80 (0.80–0.83) | 0.97 (0.92–1.04) | 1.67 (1.66–1.80) | 0 | 104 of 300 |
| archlast-forge, Postgres, default | 3/3 | 74,337 (72,135–76,342) | 0.82 (0.80–0.83) | 0.98 (0.91–1.06) | 1.71 (1.63–1.79) | 0 | 107 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 74,355 (70,729–76,115) | 0.82 (0.81–0.84) | 0.98 (0.91–1.14) | 1.69 (1.64–1.87) | 0 | 105 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 72,675 (70,377–73,032) | 0.83 (0.83–0.85) | 1.03 (1.00–1.09) | 1.82 (1.79–1.93) | 0 | 107 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 70,477 (57,828–72,463) | 0.85 (0.83–1.01) | 1.11 (1.06–1.56) | 1.87 (1.81–2.84) | 0 | 108 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 73,844 (70,957–75,359) | 0.82 (0.81–0.84) | 1.03 (0.91–1.08) | 1.75 (1.65–1.89) | 0 | 107 of 300 |
| Convex, SQLite, default | 3/3 | 20,190 (18,720–20,484) | 3.05 (3.00–3.26) | 4.71 (4.68–5.17) | 6.70 (6.55–7.88) | 0 | 294 of 300 |
| Convex, SQLite, optimized | 3/3 | 22,574 (21,988–22,642) | 2.72 (2.72–2.80) | 4.23 (4.18–4.34) | 5.90 (5.87–6.32) | 0 | 294 of 300 |
| Convex, Postgres, default | 3/3 | 14,050 (13,494–14,332) | 4.63 (4.62–4.81) | 6.31 (6.21–6.52) | 7.64 (7.38–8.16) | 0 | 211 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 15,939 (11,231–15,988) **noisy** | 4.21 (4.11–4.75) | 5.56 (5.53–9.79) | 6.49 (6.46–12.46) | 0 | 209 of 300 |

#### A. Cached query, open loop at 2,000 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 1,999 (1,999–2,000) | -0.37 (-0.38–-0.35) | 0.37 (0.22–0.43) | 0.90 (0.89–5.70) | 0 | 16 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | -0.40 (-0.40–-0.37) | 0.30 (0.16–0.37) | 0.82 (0.79–0.87) | 0 | 16 of 300 |
| archlast-forge, Postgres, default | 3/3 | 2,000 (1,999–2,000) | -0.40 (-0.41–-0.38) | 0.31 (0.20–0.39) | 0.81 (0.79–0.83) | 0 | 16 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | -0.41 (-0.41–-0.39) | 0.27 (0.20–0.32) | 0.80 (0.80–0.82) | 0 | 13 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 2,000 (1,999–2,000) | -0.39 (-0.39–-0.38) | 0.31 (0.28–0.31) | 0.84 (0.79–0.85) | 0 | 19 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | -0.37 (-0.39–-0.35) | 0.33 (0.19–0.36) | 0.84 (0.83–0.84) | 0 | 21 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 2,000 (2,000) | -0.37 (-0.42–-0.34) | 0.31 (0.30–0.34) | 0.79 (0.78–0.89) | 0 | 21 of 300 |
| Convex, SQLite, default | 3/3 | 2,000 (1,999–2,000) | -0.18 (-0.21–-0.15) | 0.49 (0.45–0.54) | 0.98 (0.98–1.10) | 0 | 35 of 300 |
| Convex, SQLite, optimized | 3/3 | 2,000 (1,999–2,000) | -0.21 (-0.22–-0.18) | 0.48 (0.44–0.52) | 0.90 (0.86–0.97) | 0 | 33 of 300 |
| Convex, Postgres, default | 3/3 | 2,000 (1,999–2,000) | -0.17 (-0.18–-0.16) | 0.51 (0.50–0.53) | 1.01 (1.00–1.05) | 0 | 34 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 2,000 (1,999–2,000) | -0.17 (-0.21–-0.16) | 0.50 (0.45–0.53) | 0.97 (0.95–1.14) | 0 | 33 of 300 |

#### B. Uncached query over 64 lists, closed loop (forge: CACHE_TTL_MS=0; Convex: its result cache as it is)

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 21,500 (20,799–21,830) | 2.82 (2.76–2.90) | 3.47 (3.41–3.63) | 5.08 (4.61–5.48) | 0 | 106 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 38,284 (33,350–38,333) | 1.48 (1.46–1.66) | 2.59 (2.58–3.00) | 4.96 (4.85–5.46) | 0 | 216 of 300 |
| archlast-forge, Postgres, default | 3/3 | 15,716 (15,188–16,306) | 3.92 (3.72–3.97) | 5.84 (5.51–6.19) | 10.49 (8.28–10.61) | 0 | 194 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 21,654 (17,595–22,848) | 2.51 (2.51–3.09) | 5.82 (5.39–7.00) | 11.65 (8.79–13.77) | 0 | 243 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 4,783 (4,392–4,826) | 12.67 (12.45–13.84) | 17.47 (17.46–19.41) | 25.18 (23.95–27.04) | 0 | 183 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 9,750 (9,630–10,814) | 6.13 (5.65–6.22) | 12.79 (11.27–12.99) | 20.39 (18.81–21.20) | 0 | 256 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 9,347 (8,912–10,925) | 6.43 (5.67–6.51) | 13.22 (10.74–14.36) | 21.84 (18.38–24.57) | 0 | 255 of 300 |
| Convex, SQLite, default | 3/3 | 20,087 (19,529–20,662) | 3.08 (2.98–3.15) | 4.71 (4.57–4.89) | 6.57 (6.43–7.04) | 0 | 294 of 300 |
| Convex, SQLite, optimized | 3/3 | 22,508 (21,576–22,551) | 2.74 (2.73–2.85) | 4.19 (4.19–4.44) | 5.99 (5.93–6.40) | 0 | 294 of 300 |
| Convex, Postgres, default | 3/3 | 14,047 (13,957–14,638) | 4.65 (4.52–4.67) | 6.38 (6.04–6.40) | 7.67 (7.09–7.73) | 0 | 211 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 15,839 (14,410–15,942) | 4.19 (4.15–4.31) | 5.61 (5.49–6.33) | 6.51 (6.33–10.78) | 0 | 210 of 300 |

#### B. Same, open loop at 2,000 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 2,000 (2,000) | -0.30 (-0.31–-0.29) | 0.39 (0.38–0.45) | 0.93 (0.93–0.96) | 0 | 22 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 2,000 (2,000) | -0.26 (-0.27–-0.22) | 0.45 (0.43–0.52) | 1.00 (0.99–1.13) | 0 | 29 of 300 |
| archlast-forge, Postgres, default | 3/3 | 2,000 (1,999–2,000) | -0.16 (-0.18–-0.14) | 0.50 (0.50–0.55) | 1.21 (1.17–1.54) | 0 | 43 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 2,000 (2,000) | -0.09 (-0.12–-0.08) | 0.69 (0.61–0.69) | 1.51 (1.20–1.77) | 0 | 51 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 2,000 (1,999–2,000) | 0.39 (0.16–0.40) | 1.73 (1.15–1.80) | 6.57 (5.19–8.13) | 0 | 87 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 2,000 (1,999–2,000) | 0.26 (0.23–0.52) | 2.74 (2.66–4.36) | 10.93 (10.04–14.37) | 0 | 84 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 1,999 (1,999–2,000) | 0.48 (0.28–0.59) | 4.56 (3.38–4.64) | 14.50 (10.99–15.49) | 0 | 106 of 300 |
| Convex, SQLite, default | 3/3 | 2,000 (1,999–2,000) | -0.20 (-0.21–-0.19) | 0.45 (0.43–0.49) | 0.95 (0.90–0.99) | 0 | 34 of 300 |
| Convex, SQLite, optimized | 3/3 | 2,000 (2,000) | -0.23 (-0.24–-0.22) | 0.46 (0.44–0.46) | 0.93 (0.88–0.94) | 0 | 32 of 300 |
| Convex, Postgres, default | 3/3 | 2,000 (2,000) | -0.19 (-0.20–-0.17) | 0.53 (0.46–0.53) | 1.00 (1.00) | 0 | 36 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 2,000 (2,000) | -0.20 (-0.20–-0.18) | 0.48 (0.44–0.52) | 0.93 (0.88–1.09) | 0 | 31 of 300 |

#### B′. Convex without its result cache (a throwaway argument per call), closed loop

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Convex, SQLite, default | 3/3 | 825 (825–847) | 74.56 (72.85–74.99) | 94.83 (91.35–95.23) | 122.59 (119.93–128.01) | 0 | 291 of 300 |
| Convex, SQLite, optimized | 3/3 | 821 (789–860) | 75.80 (72.64–79.12) | 107.83 (102.93–111.71) | 143.64 (135.11–153.88) | 0 | 292 of 300 |
| Convex, Postgres, default | 3/3 | 597 (572–608) | 105.91 (103.85–110.44) | 121.37 (120.01–128.88) | 142.21 (137.59–148.80) | 0 | 219 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 612 (577–619) | 102.55 (101.66–109.10) | 134.47 (133.51–144.29) | 169.58 (168.04–181.60) | 0 | 219 of 300 |

#### B′. Same, open loop at 2,000 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| Convex, SQLite, default | 3/3 | 813 (800–829) | 4484.59 (4326.50–4624.14) | 8125.11 (7874.20–8158.28) | 8860.69 (8714.82–8941.81) | 0 | 291 of 300 |
| Convex, SQLite, optimized | 3/3 | 800 (785–854) | 4502.37 (4357.92–4552.15) | 7952.19 (7801.59–8179.41) | 8969.45 (8600.76–9076.31) | 0 | 291 of 300 |
| Convex, Postgres, default | 3/3 | 589 (579–594) | 5281.69 (5260.38–5296.14) | 9558.70 (9539.44–9662.61) | 10545.13 (10514.11–10627.57) | 0 | 219 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 592 (551–603) | 5258.41 (4948.35–5318.27) | 9527.08 (9456.32–9936.24) | 10527.06 (10448.66–10845.66) | 0 | 220 of 300 |

#### C. Insert mutation, closed loop, inserts spread over the 64 lists

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 12,452 (12,194–13,134) | 4.76 (4.74–4.89) | 7.09 (6.55–7.11) | 20.74 (15.74–23.57) | 0 | 113 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 13,728 (12,642–13,742) | 1.88 (1.84–1.95) | 3.39 (3.14–3.91) | 35.86 (25.91–45.89) | 0 | 145 of 300 |
| archlast-forge, Postgres, default | 3/3 | 651 (633–2,825) **noisy** | 96.20 (21.99–99.48) | 110.84 (26.24–116.57) | 139.74 (32.57–144.20) | 0 | 37 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 1,112 (1,086–3,185) **noisy** | 53.74 (13.97–57.15) | 69.96 (50.29–71.43) | 85.73 (61.29–91.41) | 0 | 58 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 2,845 (2,810–9,974) **noisy** | 20.93 (6.03–21.19) | 30.06 (8.36–30.41) | 37.30 (13.75–42.12) | 0 | 53 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 5,823 (2,494–8,686) **noisy** | 8.05 (6.53–22.29) | 21.04 (11.21–40.02) | 32.19 (19.92–68.23) | 0 | 131 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 14,465 (13,625–16,633) | 3.67 (3.28–4.00) | 7.48 (6.05–7.73) | 13.13 (11.33–13.75) | 0 | 221 of 300 |
| Convex, SQLite, default | 3/3 | 628 (255–699) **noisy** | 100.29 (90.46–244.85) | 134.52 (119.99–334.50) | 171.65 (147.56–428.79) | 0 | 181 of 300 |
| Convex, SQLite, optimized | 3/3 | 309 (274–316) | 208.37 (198.25–226.25) | 283.91 (271.82–324.60) | 412.74 (359.64–414.21) | 0 | 87 of 300 |
| Convex, Postgres, default | 3/3 | 805 (795–860) | 78.72 (73.89–78.96) | 105.08 (98.88–106.51) | 136.70 (126.07–141.78) | 0 | 218 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 796 (780–863) | 78.98 (73.99–81.99) | 105.31 (97.13–106.99) | 133.96 (128.04–139.33) | 0 | 212 of 300 |

#### C. Insert mutation, open loop at 500 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 500 (500) | -0.19 (-0.21–-0.16) | 0.52 (0.47–0.55) | 1.70 (1.39–1.76) | 0 | 21 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | -0.03 (-0.05–0.12) | 1.05 (1.04–1.34) | 3.84 (2.19–5.89) | 0 | 24 of 300 |
| archlast-forge, Postgres, default | 3/3 | 499 (496–500) | 10.57 (1.57–10.59) | 24.84 (2.74–27.51) | 49.61 (5.22–123.83) | 0 | 31 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 500 (499–500) | 9.12 (8.99–12.84) | 22.62 (12.14–28.00) | 50.15 (47.46–240.86) | 0 | 31 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 499 (497–500) | 15.69 (14.24–15.76) | 25.51 (19.58–31.10) | 46.07 (30.91–107.73) | 0 | 36 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 499 (499–500) | 11.20 (9.72–13.31) | 18.56 (16.00–27.98) | 45.07 (27.55–68.33) | 0 | 50 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 500 (500) | 0.24 (0.16–0.27) | 1.31 (1.28–1.68) | 5.92 (5.19–5.96) | 0 | 38 of 300 |
| Convex, SQLite, default | 3/3 | 364 (242–498) **noisy** | 72.69 (47.11–4183.98) | 3014.73 (69.18–7303.44) | 4091.16 (94.58–7884.43) | 0 | 116 of 300 |
| Convex, SQLite, optimized | 3/3 | 284 (278–304) | 3322.31 (3131.49–3358.95) | 6099.61 (5449.88–6224.45) | 6651.44 (6032.91–6853.23) | 0 | 82 of 300 |
| Convex, Postgres, default | 3/3 | 499 (498–500) | 17.83 (9.06–19.50) | 26.91 (14.90–35.38) | 45.06 (24.77–201.11) | 0 | 151 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 500 (499–500) | 9.50 (8.98–17.84) | 20.09 (16.63–31.63) | 41.03 (30.64–70.71) | 0 | 160 of 300 |

#### D. Read-modify-write mutation (toggle), closed loop, cycling the 1,280 todos

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 23,634 (22,914–24,712) | 2.75 (2.64–2.78) | 3.84 (3.61–3.99) | 6.89 (6.58–7.10) | 0 | 110 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 28,549 (26,696–29,111) | 1.00 (0.99–1.05) | 1.86 (1.83–2.18) | 22.90 (20.68–34.51) | 0 | 167 of 300 |
| archlast-forge, Postgres, default | 3/3 | 2,553 (2,001–2,685) **noisy** | 20.47 (19.61–21.49) | 39.02 (33.65–73.63) | 81.03 (64.11–143.33) | 0 | 117 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 1,465 (1,117–3,220) **noisy** | 39.10 (15.83–45.37) | 73.79 (32.72–89.22) | 146.84 (65.72–200.88) | 0 | 94 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 1,439 (696–1,865) **noisy** | 34.27 (32.83–90.98) | 86.34 (42.71–107.04) | 104.54 (58.10–136.30) | 0 | 105 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 1,980 (1,842–2,368) **noisy** | 27.17 (23.65–27.82) | 51.65 (43.95–56.88) | 70.73 (63.24–84.19) | 0 | 186 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 3,123 (3,052–3,347) | 17.37 (16.39–17.68) | 32.97 (30.43–33.46) | 50.16 (48.61–55.33) | 0 | 212 of 300 |
| Convex, SQLite, default | 3/3 | 572 (442–626) **noisy** | 110.24 (100.73–110.88) | 146.88 (133.45–289.64) | 185.08 (159.04–386.84) | 0 | 173 of 300 |
| Convex, SQLite, optimized | 3/3 | 682 (678–712) | 92.05 (88.46–92.78) | 120.18 (116.21–121.40) | 156.45 (143.37–157.84) | 0 | 191 of 300 |
| Convex, Postgres, default | 3/3 | 786 (778–798) | 80.75 (78.71–81.03) | 105.19 (103.26–105.58) | 128.91 (125.67–131.52) | 0 | 224 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 799 (787–803) | 78.70 (77.61–79.58) | 104.70 (101.50–104.70) | 134.61 (127.13–144.56) | 0 | 220 of 300 |

#### D. Read-modify-write, open loop at 500 req/s

| System / config | kept runs | req/s | p50 ms | p90 ms | p99 ms | errors | server+db CPU % |
| --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 500 (500) | -0.25 (-0.27–-0.24) | 0.44 (0.44–0.49) | 1.67 (1.41–2.41) | 0 | 19 of 300 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | -0.01 (-0.05–0.07) | 0.99 (0.99–29.55) | 4.97 (2.27–246.13) | 0 | 21 of 300 |
| archlast-forge, Postgres, default | 3/3 | 499 (499–500) | 9.59 (1.63–10.17) | 17.72 (2.99–18.05) | 40.49 (8.34–49.66) | 0 | 39 of 300 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | 8.85 (1.68–9.83) | 12.67 (2.86–18.27) | 25.54 (7.30–59.31) | 0 | 41 of 300 |
| archlast-forge, MongoDB, default | 3/3 | 499 (499–500) | 11.47 (2.70–12.88) | 19.63 (5.25–26.48) | 60.40 (14.17–104.72) | 0 | 62 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 500 (500) | 3.33 (3.00–11.65) | 13.01 (12.99–19.28) | 28.83 (28.46–46.82) | 0 | 84 of 300 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 500 (500) | 0.71 (0.47–0.77) | 4.78 (4.11–5.66) | 13.99 (13.23–28.64) | 0 | 54 of 300 |
| Convex, SQLite, default | 3/3 | 498 (216–499) **noisy** | 74.32 (64.61–4325.59) | 136.29 (96.13–7884.29) | 224.20 (141.59–8695.58) | 0 | 152 of 300 |
| Convex, SQLite, optimized | 3/3 | 395 (273–499) **noisy** | 73.48 (65.41–3713.36) | 2237.45 (97.75–6389.23) | 3159.17 (138.75–6922.92) | 0 | 118 of 300 |
| Convex, Postgres, default | 3/3 | 500 (499–500) | 17.67 (11.64–21.45) | 25.72 (23.70–46.91) | 36.93 (33.91–83.31) | 0 | 161 of 300 |
| Convex, Postgres tuned, optimized | 3/3 | 500 (500) | 10.33 (9.73–16.09) | 22.53 (19.12–31.04) | 47.25 (37.42–146.10) | 0 | 167 of 300 |

#### E. Reactive fan-out: 1,000 subscribers on one live query, 10 inserts/s for 15 s (delivery latency in ms, from the write's send time)

| System / config | kept runs | p50 | p90 | p99 | max | per-write p50 / p99 | updates received / expected | clients that saw every write | settle after last write ms | function re-runs per write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 65 (65–66) | 88 (87–89) | 104 (102–107) | 117 (110–129) | n/a | 149,000 / 149,000 | n/a (every update arrived) | n/a | 1.00 |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 69 (66–70) | 92 (89–95) | 108 (107–113) | 128 (116–140) | n/a | 147,000 / 148,000 | n/a (every update arrived) | n/a | 1.00 |
| archlast-forge, Postgres, default | 3/3 | 71 (67–74) | 94 (93–109) | 126 (112–132) | 152 (122–163) | n/a | 144,000 / 147,000 | n/a (every update arrived) | n/a | 0.99 |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 72 (69–72) | 97 (94–98) | 119 (118–119) | 136 (132–137) | n/a | 145,000 / 147,000 | n/a (every update arrived) | n/a | 0.99–1.01 |
| archlast-forge, MongoDB, default | 2/3 | 72 (70–74) | 96 (94–98) | 117 (114–120) | 135 (127–142) | n/a | 144,500 / 146,000 | n/a (every update arrived) | n/a | 0.99–1.00 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 72 (72–74) | 98 (93–102) | 122 (116–125) | 142 (137–166) | n/a | 142,000 / 147,000 | n/a (every update arrived) | n/a | 0.96–1.00 |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 68 (66–68) | 91 (89–93) | 107 (105–112) | 115 (113–126) | n/a | 148,000 / 148,000 | n/a (every update arrived) | n/a | 1.00 |
| Convex, SQLite, default | 3/3 | 67 (48–71) | 124 (106–127) | 622 (618–656) | 1,305 (1,184–1,335) | 470 / 3829 | 28,398 / 150,000 | 1,000 | 1,101–1,306 | not measured |
| Convex, SQLite, optimized | 3/3 | 68 (65–71) | 125 (121–130) | 622 (578–705) | 1,397 (1,013–1,405) | 476 / 3917 | 28,333 / 150,000 | 1,000 | 1,013–1,404 | not measured |
| Convex, Postgres, default | 3/3 | 56 (55–57) | 123 (121–137) | 741 (726–970) | 1,572 (1,150–1,871) | 477 / 3838 | 27,893 / 148,000 | 1,000 | 1,102–1,801 | not measured |
| Convex, Postgres tuned, optimized | 3/3 | 59 (52–66) | 128 (112–143) | 727 (534–1,020) | 1,505 (1,262–1,957) | 482 / 3879 | 27,757 / 149,000 | 1,000 | 1,201–1,906 | not measured |

#### E′. The same, archlast-forge measured with the Convex port's client code (WebSocket in Node)

| System / config | kept runs | p50 | p90 | p99 | max | per-write p50 / p99 | updates received / expected | clients that saw every write | settle after last write ms | function re-runs per write |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| archlast-forge, SQLite, default | 3/3 | 68 (67–69) | 89 (87–91) | 103 (101–110) | 114 (109–140) | 68 / 103 | 149,000 / 149,000 | 1,000 | 0–100 | not measured |
| archlast-forge, SQLite, RUNTIME_WORKERS=2 | 3/3 | 70 (69–70) | 91 (88–93) | 106 (102–136) | 126 (110–147) | 70 / 106 | 148,000 / 148,000 | 1,000 | 0 | not measured |
| archlast-forge, Postgres, default | 3/3 | 78 (74–86) | 107 (98–108) | 131 (124–137) | 150 (145–158) | 78 / 137 | 145,000 / 146,000 | 1,000 | 0–99 | not measured |
| archlast-forge, Postgres tuned, RUNTIME_WORKERS=2 | 3/3 | 76 (75–82) | 105 (100–108) | 133 (126–135) | 153 (146–155) | 76 / 145 | 143,000 / 145,000 | 1,000 | 0–101 | not measured |
| archlast-forge, MongoDB, default | 3/3 | 78 (71–82) | 103 (93–107) | 124 (124–125) | 144 (136–157) | 78 / 196 | 136,000 / 145,000 | 1,000 | 0–101 | not measured |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2 | 3/3 | 77 (75–79) | 99 (94–102) | 116 (107–118) | 129 (116–131) | 77 / 122 | 144,000 / 148,000 | 1,000 | 0–101 | not measured |
| archlast-forge, MongoDB, RUNTIME_WORKERS=2, w=1 journal=false | 3/3 | 69 (69–70) | 91 (89–91) | 106 (103–109) | 115 (115–122) | 69 / 106 | 148,000 / 149,000 | 1,000 | 0 | not measured |

#### Control: the machine's own noise (Bun.serve answering a fixed 20-document body, same cores and load generator)

| When | case | runs | req/s | p50 | p90 | p99 | max |
| --- | --- | --- | --- | --- | --- | --- | --- |
| before | closed | 3 | 108,216 (108,137–111,798) | 0.55 (0.55–0.56) | 0.63 (0.59–0.64) | 1.25 (1.22–1.29) | 8.4 (8.2–14.8) |
| before | open2000 | 3 | 2,000 (2,000) | -0.38 (-0.40–-0.37) | 0.29 (0.29–0.33) | 0.70 (0.68–0.81) | 13.1 (8.2–19.7) |
| after | closed | 3 | 110,734 (109,729–111,825) | 0.55 (0.54–0.55) | 0.61 (0.60–0.61) | 1.24 (1.24–1.25) | 8.4 (7.2–9.2) |
| after | open2000 | 3 | 2,000 (2,000) | -0.38 (-0.40–-0.37) | 0.34 (0.30–0.37) | 0.75 (0.71–0.79) | 10.2 (8.8–13.0) |

#### Discarded runs and errors

- run 2 forge-mongodb-default E: updates 121000/135000, missing undefined
