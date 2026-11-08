#!/bin/bash
# run.sh <path...>: the benchmark API in-process, pinned to cores 0-3 (HTTP_ENGINE=archlast by default; BUNARGS e.g. "--cpu-prof-md --cpu-prof-dir=/tmp/p"), each path loaded with oha from 4-7,12-15
cd $(dirname $0)
# the app's @archlast/forge-runtime, linked to this checkout (a workspace member would need a lockfile change)
[ -e forge/node_modules/@archlast/forge-runtime ] || { mkdir -p forge/node_modules/@archlast && ln -s ../../../../../../packages/runtime forge/node_modules/@archlast/forge-runtime; }
PORT=4900 HTTP_ENGINE=${HTTP_ENGINE:-archlast} taskset -c 0-3 bun ${BUNARGS:-} serve.ts > server.log 2>&1 &
SPID=$!
for i in $(seq 1 100); do curl -s -o /dev/null localhost:4900/http/ping && break; sleep 0.3; done
for p in "$@"; do
  taskset -c 4-7,12-15 oha --no-tui -z 2s -c 64 http://127.0.0.1:4900$p > /dev/null 2>&1
  out=$(taskset -c 4-7,12-15 oha --no-tui -z 5s -c 64 http://127.0.0.1:4900$p 2>&1)
  echo "$p  $(echo "$out" | grep -E 'Requests/sec' | awk '{print $2}') req/s   $(echo "$out" | grep -E 'Success rate' | awk '{print $3}') ok   $(echo "$out" | grep -E '\[(2|4|5)[0-9][0-9]\]' | head -2 | tr '\n' ' ')"
done
kill -TERM $SPID; sleep 3
