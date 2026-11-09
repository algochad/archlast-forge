#!/bin/bash
# run.sh <path...>: the benchmark API in-process, pinned to cores 0-3 (HTTP_ENGINE=archlast by default; BUNARGS e.g. "--cpu-prof-md --cpu-prof-dir=/tmp/p"), each path loaded with oha from 4-7,12-15
cd $(dirname $0)
# the app's @archlast/forge-runtime, linked to this checkout (a workspace member would need a lockfile change)
[ -e forge/node_modules/@archlast/forge-runtime ] || { mkdir -p forge/node_modules/@archlast && ln -s ../../../../../../packages/runtime forge/node_modules/@archlast/forge-runtime; }
FORGE=${FORGE:-forge} PORT=4900 HTTP_ENGINE=${HTTP_ENGINE:-archlast} taskset -c 0-3 bun ${BUNARGS:-} serve.ts > server.log 2>&1 &
SPID=$!
for i in $(seq 1 100); do curl -s -o /dev/null localhost:4900/http/ping && break; sleep 0.3; done
[ "${FORGE:-forge}" = forge-db ] && curl -s -X POST localhost:4900/http/seed > /dev/null   # the ctx.db app starts empty
# a path starting with ~ is a regular expression for oha's --rand-regex-url (many different paths, as real traffic has): ~/http/li/([1-9][0-9]{0,2})
for p in "$@"; do
  mode=(); url="http://127.0.0.1:4900$p"
  if [[ "$p" == ~* ]]; then mode=(--rand-regex-url); p=${p:1}; url="http://127.0.0.1:4900$p"; fi
  taskset -c 4-7,12-15 oha --no-tui -z 2s -c 64 "${mode[@]}" "$url" > /dev/null 2>&1
  cpu() { awk '{print $14 + $15}' /proc/$SPID/task/$SPID/stat; }   # the JavaScript thread's CPU time in clock ticks (user + system)
  c0=$(cpu)
  out=$(taskset -c 4-7,12-15 oha --no-tui -z 5s -c 64 "${mode[@]}" "$url" 2>&1)
  c1=$(cpu)
  n=$(echo "$out" | grep -E '\[200\]' | grep -oE '[0-9]+ responses' | head -1 | awk '{print $1}')
  us=$(awk -v a=$c0 -v b=$c1 -v n=${n:-1} 'BEGIN { printf "%.2f", (b - a) * 10000 / n }')   # 100 ticks a second: a tick is 10000 us
  echo "$p  $(echo "$out" | grep -E 'Requests/sec' | awk '{print $2}') req/s  ${us} us on the JS thread per request   $(echo "$out" | grep -E 'Success rate' | awk '{print $3}') ok   $(echo "$out" | grep -E '\[(2|4|5)[0-9][0-9]\]' | head -2 | tr '\n' ' ')"
done
kill -TERM $SPID; sleep 3
