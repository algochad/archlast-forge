#!/bin/bash
# Alternating HTTP runs of Forge's RPC handler on Bun.serve and archlast-serve: req/s and server CPU per request.
# usage: http-ab.sh [conns] [rounds]
cd "$(dirname "$0")/.."
C=${1:-64}; R=${2:-3}
for i in $(seq 1 $R); do
  for E in bun archlast; do
    PORT=$((5500 + RANDOM % 400)); ENGINE=$E PORT=$PORT THREADS=${THREADS:-2} ARCHLAST_BACKEND=${BACKEND:-napi} taskset -c 0-3 bun bench/servers/forge-rpc.ts >/dev/null 2>&1 & pid=$!
    for k in $(seq 1 60); do curl -s -o /dev/null -X POST -H "authorization: Bearer bench-token" -d '{"blob":"x"}' http://127.0.0.1:$PORT/echo.back && break; sleep 0.25; done
    OHA="taskset -c 4-7,12-15 $HOME/.cargo/bin/oha --no-tui -c $C -m POST -H authorization:Bearer\ bench-token -d {\"blob\":\"xxxxxxxxxxxxxxxx\"} http://127.0.0.1:$PORT/echo.back"
    eval "$OHA -z 2s" >/dev/null 2>&1
    s0=$(awk '{print $14+$15}' /proc/$pid/stat)
    out=$(eval "$OHA -z 5s --output-format json" 2>/dev/null)
    s1=$(awk '{print $14+$15}' /proc/$pid/stat)
    python3 - "$out" $s0 $s1 $E <<'PY'
import json,sys
j=json.loads(sys.argv[1]); rps=j['summary']['requestsPerSec']; s0,s1=int(sys.argv[2]),int(sys.argv[3])
cores=(s1-s0)/100/5
print(f"{sys.argv[4]:9s} {rps:8.0f} req/s  {cores:.2f} cores  {cores/rps*1e6:5.1f} us/req  p50 {j['latencyPercentiles']['p50']*1000:.3f} ms")
PY
    kill $pid; wait $pid 2>/dev/null
  done
done
