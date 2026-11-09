#!/bin/bash
# oha, 8 s per run, /json, connections 50/500/2000/5000, one server at a time, all on this machine (loopback).
# Also records server RSS and CPU use (% of one core) over each run.
cd "$(dirname "$0")/.."
export PATH=$HOME/.local/share/mise/installs/node/22.23.4/bin:$PATH
OUT=bench/results.jsonl; CHECK=bench/check.txt
: > $OUT; : > $CHECK; rm -f bench/status.txt
cpu_ticks() { awk '{print $14+$15}' /proc/$1/stat; }
run() { # label port env-assignments cmd...
  local name=$1 port=$2 envs=$3; shift 3
  env PORT=$port $envs "$@" > "bench/logs-$name.txt" 2>&1 &
  local pid=$!
  for i in $(seq 1 60); do curl -s -o /dev/null localhost:$port/json && break; sleep 0.25; done
  { echo "== $name"; for p in / /json /missing; do printf '%s -> ' $p; curl -s -o /tmp/rs-body -w '%{http_code} %{content_type} ' localhost:$port$p; head -c 60 /tmp/rs-body; echo; done; } >> $CHECK
  for c in 50 500 2000 5000; do
    local t0=$(cpu_ticks $pid)
    ~/.cargo/bin/oha --no-tui --output-format json -c $c -z 8s http://127.0.0.1:$port/json 2>/dev/null > /tmp/rs-oha.json
    local t1=$(cpu_ticks $pid) rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status)
    node -e '
      const j=JSON.parse(require("fs").readFileSync("/tmp/rs-oha.json","utf8"));
      const [name,c,t0,t1,rss]=process.argv.slice(1);
      const err=Object.values(j.errorDistribution||{}).reduce((a,b)=>a+b,0);
      const non2xx=Object.entries(j.statusCodeDistribution||{}).filter(([k])=>k!=="200").reduce((a,[,v])=>a+v,0);
      console.log(JSON.stringify({server:name,conns:+c,rps:Math.round(j.summary.requestsPerSec),avg_ms:+(j.summary.average*1000).toFixed(3),p99_ms:+(j.latencyPercentiles.p99*1000).toFixed(3),errors:err,non2xx,cpu_pct:Math.round((t1-t0)/100/8*100),rss_mb:Math.round(rss/1024)}))' "$name" "$c" "$t0" "$t1" "$rss" >> $OUT
  done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
}
T=THREADS=4
# --- JS handler runs for every request ---
run bun-serve            3020 ""                               bun bench/bun-serve.ts
run elysia               3021 ""                               bun bench/elysia-dynamic.ts
run rs-dynamic-bunffi    3022 "$T ARCHLAST_BACKEND=bun-ffi"   bun bench/rs-dynamic.ts
run rs-dynamic-napi      3023 "$T ARCHLAST_BACKEND=napi"      bun bench/rs-dynamic.ts
run rs-dynamic-napi-node 3024 "$T ARCHLAST_BACKEND=napi"      node bench/rs-dynamic.ts
run rs-fetch-bunffi      3025 "$T ARCHLAST_BACKEND=bun-ffi"   bun bench/rs-fetch.ts
run rs-fetch-napi        3026 "$T ARCHLAST_BACKEND=napi"      bun bench/rs-fetch.ts
# --- constant responses ---
run bun-static           3027 ""                               bun bench/bun-static.ts
run elysia-static        3028 ""                               bun bench/elysia-static.ts
run rs-static-bunffi     3029 "ARCHLAST_BACKEND=bun-ffi"      bun bench/rs-static.ts
run rs-static-napi       3030 "ARCHLAST_BACKEND=napi"         bun bench/rs-static.ts
# --- second pass of the backend comparison, napi first to cancel ordering bias ---
run rs-dynamic-napi-r2   3031 "$T ARCHLAST_BACKEND=napi"      bun bench/rs-dynamic.ts
run rs-dynamic-bunffi-r2 3032 "$T ARCHLAST_BACKEND=bun-ffi"   bun bench/rs-dynamic.ts
run rs-fetch-napi-r2     3033 "$T ARCHLAST_BACKEND=napi"      bun bench/rs-fetch.ts
run rs-fetch-bunffi-r2   3034 "$T ARCHLAST_BACKEND=bun-ffi"   bun bench/rs-fetch.ts
echo ALL_DONE > bench/status.txt
