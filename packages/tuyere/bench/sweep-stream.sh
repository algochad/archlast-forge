#!/bin/bash
# SSE burst (n=1000 events per stream), WebSocket echo and WebSocket fan-out, driven by bench/client (Rust).
# One server at a time; records the client's JSON plus total server CPU (cores) and RSS.
cd "$(dirname "$0")/.."
C=bench/client/target/release/client
OUT=bench/results-stream.jsonl; : > $OUT; rm -f bench/status-stream.txt
ticks() { awk '{print $14+$15}' /proc/$1/stat; }
measure() { # pid label client-args...
  local pid=$1 label=$2; shift 2
  local t0=$(ticks $pid)
  local line; line=$($C "$@" --secs 8 2>/dev/null)
  local t1=$(ticks $pid) rss=$(awk '/VmRSS/{print $2}' /proc/$pid/status)
  if [ -z "$line" ]; then echo "{\"server\":\"$label\",\"mode\":\"$1\",\"failed\":true}" >> $OUT; return; fi
  # cpu window = warmup(1s) + measure(8s) + start-up slack; report cores over 9 s
  echo "$line" | bun -e '
    const j=JSON.parse(await Bun.stdin.text()); const [label,t0,t1,rss]=process.argv.slice(1);
    console.log(JSON.stringify({server:label,...j,server_cpu_cores:+((t1-t0)/100/9).toFixed(2),rss_mb:Math.round(rss/1024)}))' "$label" $t0 $t1 $rss >> $OUT
}
run() { # label port fanout(yes|no) envs... -- cmd...
  local name=$1 port=$2 fan=$3; shift 3
  local envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
  env PORT=$port "${envs[@]}" "$@" > "bench/logs-stream-$name.txt" 2>&1 &
  local pid=$!
  for i in $(seq 1 60); do curl -s -o /dev/null "localhost:$port/sse?n=1" && break; sleep 0.25; done
  sleep 1
  local base=127.0.0.1:$port
  for c in 50 500; do measure $pid $name sse-burst --url "http://$base/sse?n=1000" --conns $c; done
  for c in 50 500; do measure $pid $name ws-echo --url "ws://$base/ws" --conns $c; done
  if [ "$fan" = yes ]; then for c in 100 1000; do measure $pid $name ws-fanout --url "ws://$base/fanout" --conns $c; done; fi
  kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
}
B=bench/servers
run bun-w1             3400 yes WORKERS=1                    -- bun $B/stream-bun.ts
run bun-reuseport-w4   3401 no  WORKERS=4                    -- bun $B/stream-bun.ts
run archlast-napi-w1   3402 yes WORKERS=1 BACKEND=napi       -- bun $B/stream-archlast.ts
run archlast-napi-w4   3403 yes WORKERS=4 BACKEND=napi       -- bun $B/stream-archlast.ts
run archlast-bunffi-w4 3404 yes WORKERS=4 BACKEND=bun-ffi    -- bun $B/stream-archlast.ts
echo ALL_DONE > bench/status-stream.txt
