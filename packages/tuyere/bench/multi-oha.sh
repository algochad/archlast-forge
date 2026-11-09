#!/bin/bash
# usage: multi-oha.sh label port k envs... -- cmd...   (k oha processes in parallel, 6 s, 500 conns total)
cd "$(dirname "$0")/.."
label=$1 port=$2 k=$3; shift 3
envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
env PORT=$port "${envs[@]}" "$@" > /dev/null 2>&1 &
pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null localhost:$port/json && break; sleep 0.25; done
~/.cargo/bin/oha --no-tui -c 100 -z 2s http://127.0.0.1:$port/json > /dev/null 2>&1
read u0 s0 < <(awk '{print $14, $15}' /proc/$pid/stat)
for i in $(seq 1 $k); do ~/.cargo/bin/oha --no-tui --output-format json -c $((500 / k)) -z 6s http://127.0.0.1:$port/json 2>/dev/null > /tmp/mo-$i.json & done
wait $(jobs -p | grep -v "^$pid$") 2>/dev/null
read u1 s1 < <(awk '{print $14, $15}' /proc/$pid/stat)
node -e '
const [label,k,u0,s0,u1,s1]=process.argv.slice(1);
let rps=0,p99=0;for(let i=1;i<=+k;i++){const j=JSON.parse(require("fs").readFileSync(`/tmp/mo-${i}.json`,"utf8"));rps+=j.summary.requestsPerSec;p99=Math.max(p99,j.latencyPercentiles.p99*1000)}
console.log(JSON.stringify({label,oha_procs:+k,rps:Math.round(rps),server_cores:+(((u1-u0)+(s1-s0))/100/6).toFixed(2),p99_ms:+p99.toFixed(2)}))' "$label" $k $u0 $s0 $u1 $s1
kill $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
