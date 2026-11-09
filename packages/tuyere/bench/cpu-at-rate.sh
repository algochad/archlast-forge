#!/bin/bash
# usage: cpu-at-rate.sh label port path rate envs... -- cmd...
# Drives a FIXED request rate so every server does the same work, then reports the server's CPU (all threads).
cd "$(dirname "$0")/.."
label=$1 port=$2 path=$3 rate=$4; shift 4
envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
env PORT=$port "${envs[@]}" "$@" > /dev/null 2>&1 & pid=$!
for i in $(seq 1 80); do curl -s -o /dev/null localhost:$port$path && break; sleep 0.25; done; sleep 1
~/.cargo/bin/oha --no-tui -c 200 -q $rate -z 2s http://127.0.0.1:$port$path > /dev/null 2>&1
t0=$(awk '{print $14+$15}' /proc/$pid/stat); u0=$(awk '{print $14}' /proc/$pid/stat)
~/.cargo/bin/oha --no-tui --output-format json -c 200 -q $rate -z 6s http://127.0.0.1:$port$path 2>/dev/null > /tmp/car.json
t1=$(awk '{print $14+$15}' /proc/$pid/stat); u1=$(awk '{print $14}' /proc/$pid/stat)
bun -e '
const j=JSON.parse(await Bun.file("/tmp/car.json").text());
const [l,t0,t1,u0,u1,target]=process.argv.slice(1);
const rps=j.summary.requestsPerSec, cores=(t1-t0)/100/6, user=(u1-u0)/100/6;
const ok=Object.entries(j.statusCodeDistribution||{}).filter(([k])=>k==="200").reduce((a,[,v])=>a+v,0);
console.log(l.padEnd(30)+String(Math.round(rps)).padStart(8)+" rps (target "+target+")  "+cores.toFixed(2)+" cores  "+(cores/rps*1e6).toFixed(2)+" us/req   user "+(user/cores*100).toFixed(0)+"%  p99 "+(j.latencyPercentiles.p99*1000).toFixed(2)+"ms")' "$label" $t0 $t1 $u0 $u1 $rate
kill $pid; wait $pid 2>/dev/null; sleep 0.8
