#!/bin/bash
# usage: threads-at-rate.sh label port path rate envs... -- cmd...  -> per-thread CPU (us per request) at a fixed rate
cd "$(dirname "$0")/.."
label=$1 port=$2 path=$3 rate=$4; shift 4
envs=(); while [ "$1" != "--" ]; do envs+=("$1"); shift; done; shift
env PORT=$port "${envs[@]}" "$@" > /dev/null 2>&1 & pid=$!
for i in $(seq 1 80); do curl -s -o /dev/null localhost:$port$path && break; sleep 0.25; done; sleep 1
~/.cargo/bin/oha --no-tui -c 200 -q $rate -z 2s http://127.0.0.1:$port$path > /dev/null 2>&1
snap() { for t in /proc/$pid/task/*; do echo "$(cat $t/comm | tr ' ' _) $(awk '{print $14, $15}' $t/stat)"; done; }
snap > /tmp/tar-a; ~/.cargo/bin/oha --no-tui -c 200 -q $rate -z 6s http://127.0.0.1:$port$path > /dev/null 2>&1; snap > /tmp/tar-b
echo "== $label @ $rate req/s"
paste -d' ' /tmp/tar-a /tmp/tar-b | awk -v r=$rate '{u=($5-$2)/100; s=($6-$3)/100; if (u+s > 0.05) printf "  %-18s user %.2f us/req   sys %.2f us/req\n", $1, u/(6*r)*1e6, s/(6*r)*1e6 }'
kill $pid; wait $pid 2>/dev/null; sleep 0.8
