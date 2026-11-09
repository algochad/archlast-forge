#!/bin/bash
# Per-thread CPU (user/sys ms per 1000 messages) of a server under WebSocket load. usage: thread-split.sh engine conns [secs]
cd "$(dirname "$0")/.."
E=$1; C=${2:-64}; S=${3:-6}; PORT=4501
ENGINE=$E PORT=$PORT THREADS=${THREADS:-2} ARCHLAST_BACKEND=${BACKEND:-napi} taskset -c 0-3 bun ${BUNFLAGS} bench/servers/forge-rpc.ts >/dev/null 2>&1 & pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null -X POST -H "authorization: Bearer bench-token" -d '{"blob":"x"}' http://127.0.0.1:$PORT/echo.back && break; sleep 0.25; done; sleep 0.5
export WS_EXTRA_HEADER="Authorization: Bearer bench-token" WS_LENIENT=1 WS_MESSAGE='[[1,"echo.back",{"blob":"xxxxxxxxxxxxxxxx"}]]'  WS_PIPELINE=${WS_PIPELINE:-1}
CL="taskset -c 4-7,12-15 bench/client/target/release/client ws-echo --url ws://127.0.0.1:$PORT/_ws --conns $C --warmup 0.5 --threads 8"
$CL --secs 2 >/dev/null 2>&1
snap() { for t in /proc/$pid/task/*; do echo "$(cat $t/comm) $(awk '{print $14, $15}' $t/stat)"; done | sort; }
snap > $CLAUDE_JOB_DIR/tmp/s0.txt
out=$($CL --secs $S 2>/dev/null | tail -1)
snap > $CLAUDE_JOB_DIR/tmp/s1.txt
kill $pid; wait $pid 2>/dev/null
bun bench/thread-split.ts $CLAUDE_JOB_DIR/tmp/s0.txt $CLAUDE_JOB_DIR/tmp/s1.txt "$out" $S "$E conns=$C"
