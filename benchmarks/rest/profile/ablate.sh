#!/bin/bash
# ablate.sh VAR=value ...: the Forge Nest read at 256 connections with the given environment (what a feature costs)
cd $(dirname $0)
env "$@" PORT=4900 FORGE=forge HTTP_ENGINE=archlast taskset -c 0-3 bun serve.ts > /dev/null 2>&1 &
pid=$!
for i in $(seq 1 100); do curl -s -o /dev/null http://127.0.0.1:4900/http/items/1 && break; sleep 0.3; done
taskset -c 4-7,12-15 oha --no-tui -z 2s -c 256 --rand-regex-url "http://127.0.0.1:4900/http/items/([1-9][0-9]{0,2})" >/dev/null 2>&1
out=$(taskset -c 4-7,12-15 oha --no-tui -z 5s -c 256 --rand-regex-url "http://127.0.0.1:4900/http/items/([1-9][0-9]{0,2})" 2>&1)
echo "$* : $(echo "$out" | grep Requests/sec | awk '{print $2}') req/s"
pkill -TERM -P $pid 2>/dev/null; kill -TERM $pid 2>/dev/null; wait $pid 2>/dev/null; sleep 1
