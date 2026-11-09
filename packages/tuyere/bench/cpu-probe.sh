#!/bin/bash
# usage: cpu-probe.sh label port conns envs... -- cmd...   -> one JSON line: rps, cpu split, per-request CPU
cd "$(dirname "$0")/.."
label=$1 port=$2 conns=$3; shift 3
envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
env PORT=$port "${envs[@]}" "$@" > /dev/null 2>&1 &
pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null localhost:$port/json && break; sleep 0.25; done
~/.cargo/bin/oha --no-tui -c $conns -z 2s http://127.0.0.1:$port/json > /dev/null 2>&1   # warm-up
snap() { awk '{print $14, $15}' /proc/$pid/stat; }
read u0 s0 < <(snap)
~/.cargo/bin/oha --no-tui --output-format json -c $conns -z 6s http://127.0.0.1:$port/json 2>/dev/null > /tmp/cp.json
read u1 s1 < <(snap)
# per-thread CPU ticks, grouped by thread name
threads=$(for t in /proc/$pid/task/*; do echo "$(cat $t/comm | tr ' ' _) $(awk '{print $14+$15}' $t/stat)"; done | awk '{n[$1]++; c[$1]+=$2} END{for(k in n) printf "%s x%d=%.1fs ", k, n[k], c[k]/100}')
nthreads=$(ls /proc/$pid/task | wc -l)
node -e '
const j=JSON.parse(require("fs").readFileSync("/tmp/cp.json","utf8"));
const [label,u0,s0,u1,s1,threads,nth]=process.argv.slice(1);
const rps=j.summary.requestsPerSec, secs=6, user=(u1-u0)/100, sys=(s1-s0)/100;
console.log(JSON.stringify({label,rps:Math.round(rps),cores:+((user+sys)/secs).toFixed(2),user_cores:+(user/secs).toFixed(2),sys_cores:+(sys/secs).toFixed(2),cpu_us_per_req:+(((user+sys)/(rps*secs))*1e6).toFixed(2),os_threads:+nth}));
console.error("   threads(cumulative cpu): "+threads);' "$label" $u0 $s0 $u1 $s1 "$threads" $nthreads
kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
