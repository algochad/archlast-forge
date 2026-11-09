#!/bin/bash
# Samples the Rust side of Tuyere under WebSocket load (needs the library built with --features profile).
# usage: profile-ws.sh conns   -> $CLAUDE_JOB_DIR/tmp/folded.txt and a summary
cd "$(dirname "$0")/.."
C=${1:-64}; PORT=4801; OUT=${CLAUDE_JOB_DIR:-/tmp}/tmp/folded.txt
ENGINE=archlast PORT=$PORT THREADS=${THREADS:-2} ARCHLAST_BACKEND=napi ARCHLAST_PROFILE=$OUT:12 taskset -c 0-3 bun bench/servers/forge-rpc.ts >/dev/null 2>&1 & pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null -X POST -H "authorization: Bearer bench-token" -d '{"blob":"x"}' http://127.0.0.1:$PORT/echo.back && break; sleep 0.25; done
export WS_EXTRA_HEADER="Authorization: Bearer bench-token" WS_LENIENT=1 WS_MESSAGE='[[1,"echo.back",{"blob":"xxxxxxxxxxxxxxxx"}]]'  WS_PIPELINE=${WS_PIPELINE:-16}
taskset -c 4-7 bench/client/target/release/client ws-echo --url ws://127.0.0.1:$PORT/_ws --conns $C --warmup 0.5 --threads 4 --secs 13 2>/dev/null | tail -1
sleep 1; kill $pid; wait $pid 2>/dev/null
python3 bench/fold-summary.py $OUT "${2:-archlast-io}"
