#!/bin/bash
# Saturated WebSocket throughput of Forge's RPC handler: pipelined clients (WS_PIPELINE messages in flight per connection).
# usage: bench/ws-sat.sh engine [conns] [pipeline] [runs]     env: THREADS, BACKEND
cd "$(dirname "$0")/.."
E=$1; C=${2:-256}; K=${3:-16}; R=${4:-3}; PORT=$((4970 + RANDOM % 20))
ENGINE=$E PORT=$PORT THREADS=${THREADS:-2} ARCHLAST_BACKEND=${BACKEND:-napi} taskset -c 0-3 bun bench/servers/forge-rpc.ts >/dev/null 2>&1 & pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null -X POST -H "authorization: Bearer bench-token" -d '{"blob":"x"}' http://127.0.0.1:$PORT/echo.back && break; sleep 0.25; done
export WS_EXTRA_HEADER="Authorization: Bearer bench-token" WS_LENIENT=1 WS_MESSAGE='[[1,"echo.back",{"blob":"xxxxxxxxxxxxxxxx"}]]' WS_PIPELINE=$K
taskset -c 4-7,12-15 bench/client/target/release/client ws-echo --url ws://127.0.0.1:$PORT/_ws --conns $C --secs 2 --warmup 0.5 --threads 8 >/dev/null 2>&1
for r in $(seq 1 $R); do
  s0=$(awk '{print $14+$15}' /proc/$pid/stat)
  out=$(taskset -c 4-7,12-15 bench/client/target/release/client ws-echo --url ws://127.0.0.1:$PORT/_ws --conns $C --secs 5 --warmup 0.5 --threads 8 2>/dev/null | tail -1)
  s1=$(awk '{print $14+$15}' /proc/$pid/stat)
  python3 -c "
import json,sys
j=json.loads('''$out''')
cores=($s1-$s0)/100/5.5
print(f'$E c=$C pipe=$K  {j[\"msgs_per_sec\"]:9.0f} msg/s  {cores:.2f} cores  {cores/j[\"msgs_per_sec\"]*1e6:.2f} us/msg')"
done
kill $pid; wait $pid 2>/dev/null
