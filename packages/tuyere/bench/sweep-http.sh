#!/bin/bash
# oha, 8 s per run, /json, connections 50/500/2000/5000, one server at a time, all on this machine (loopback).
# Records throughput, p99, total server CPU (all threads, in cores) and RSS.
cd "$(dirname "$0")/.."
OUT=bench/results-http.jsonl; : > $OUT; rm -f bench/status-http.txt
ticks() { awk '{print $14+$15}' /proc/$1/stat; }
run() { # label port envs... -- cmd...
  local name=$1 port=$2; shift 2
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  env PORT=$port "${envs[@]}" "$@" > "bench/logs-http-$name.txt" 2>&1 &
  local pid=$!
  for i in $(seq 1 60); do curl -s -o /dev/null localhost:$port/json && break; sleep 0.25; done
  sleep 1   # let worker threads attach
  local check=$(curl -s localhost:$port/json); [ "$check" = '{"ok":true,"n":42}' ] || echo "WARNING $name returned: $check" >&2
  ~/.cargo/bin/oha --no-tui -c 100 -z 2s http://127.0.0.1:$port/json > /dev/null 2>&1   # warm-up
  for c in 50 500 2000 5000; do
    local t0=$(ticks $pid)
    ~/.cargo/bin/oha --no-tui --output-format json -c $c -z 8s http://127.0.0.1:$port/json 2>/dev/null > /tmp/sh-oha.json
    local t1=$(ticks $pid) rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status)
    bun -e '
      const j=JSON.parse(await Bun.file("/tmp/sh-oha.json").text());
      const [name,c,t0,t1,rss]=process.argv.slice(1);
      const err=Object.values(j.errorDistribution||{}).reduce((a,b)=>a+b,0);
      const non2xx=Object.entries(j.statusCodeDistribution||{}).filter(([k])=>k!=="200").reduce((a,[,v])=>a+v,0);
      console.log(JSON.stringify({server:name,conns:+c,rps:Math.round(j.summary.requestsPerSec),p99_ms:+(j.latencyPercentiles.p99*1000).toFixed(2),errors:err,non2xx,cpu_cores:+((t1-t0)/100/8).toFixed(2),rss_mb:Math.round(rss/1024)}))' "$name" "$c" "$t0" "$t1" "$rss" >> $OUT
  done
  kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
}
B=bench/servers
run bun-serve-w1         3200 WORKERS=1                       -- bun $B/http-bun.ts
run bun-reuseport-w2     3201 WORKERS=2                       -- bun $B/http-bun.ts
run bun-reuseport-w4     3202 WORKERS=4                       -- bun $B/http-bun.ts
run bun-reuseport-w8     3203 WORKERS=8                       -- bun $B/http-bun.ts
run archlast-napi-w1     3204 WORKERS=1 BACKEND=napi          -- bun $B/http-archlast.ts
run archlast-napi-w2     3205 WORKERS=2 BACKEND=napi          -- bun $B/http-archlast.ts
run archlast-napi-w4     3206 WORKERS=4 BACKEND=napi          -- bun $B/http-archlast.ts
run archlast-napi-w8     3207 WORKERS=8 BACKEND=napi          -- bun $B/http-archlast.ts
run archlast-bunffi-w1   3208 WORKERS=1 BACKEND=bun-ffi       -- bun $B/http-archlast.ts
run archlast-bunffi-w2   3209 WORKERS=2 BACKEND=bun-ffi       -- bun $B/http-archlast.ts
run archlast-bunffi-w4   3210 WORKERS=4 BACKEND=bun-ffi       -- bun $B/http-archlast.ts
run archlast-bunffi-w8   3211 WORKERS=8 BACKEND=bun-ffi       -- bun $B/http-archlast.ts
echo ALL_DONE > bench/status-http.txt
