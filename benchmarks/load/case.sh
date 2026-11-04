#!/usr/bin/env bash
# One benchmark case. usage: case.sh <label> <server cores> <load: get|getmany|post|patch|fanout> [env assignments for the server...]
# The server runs pinned to <server cores>; the load generator on core 3. Prints one JSON line with load, per-core CPU and loop delay.
set -u
B=$(dirname "$0")
LABEL=$1 CORES=$2 KIND=$3; shift 3
PORT=${PORT:-3100}
LIST=$B/list.$PORT
KEY=bench-admin-key-0123456789abcdef0123
cpu() { awk '/^cpu[0-9]/ {busy=$2+$3+$4+$7+$8+$9; tot=busy+$5+$6; print $1, busy, tot}' /proc/stat; }

env PORT=$PORT LIST_FILE=$LIST "$@" taskset -c "$CORES" bun "$B/serve.ts" > "$B/serve.$PORT.log" 2>&1 &
SPID=$!
for _ in $(seq 1 120); do grep -q READY "$B/serve.$PORT.log" && break; sleep 0.25; done
grep -q READY "$B/serve.$PORT.log" || { echo "{\"label\":\"$LABEL\",\"error\":\"server did not start\"}"; tail -5 "$B/serve.$PORT.log" >&2; kill $SPID; exit 1; }
LISTID=$(head -1 "$LIST")
# SECOND_CORES: a second replica on PORT+1 (same database), and the load spread over both.
if [ -n "${SECOND_CORES:-}" ]; then
  P2=$((PORT + 1))
  env PORT=$P2 NO_SEED=1 "$@" taskset -c "$SECOND_CORES" bun "$B/serve.ts" > "$B/serve.$P2.log" 2>&1 &
  S2PID=$!
  for _ in $(seq 1 120); do grep -q READY "$B/serve.$P2.log" && break; sleep 0.25; done
  PORTS=$PORT,$P2
fi
TODOIDS=$(node -e 'process.stdout.write(JSON.stringify(require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n")))' "$LIST.todos" 2>/dev/null || echo '[]')
GETPATH="/rpc/todos:listByList?args=$(node -e "process.stdout.write(encodeURIComponent(JSON.stringify({listId:'$LISTID'})))")"
# Every seeded list (SEED_LISTS=64 on the server), round-robin: identical calls rarely overlap, so none share a run.
GETPATHS=$(node -e 'const ids=require("fs").readFileSync(process.argv[1],"utf8").trim().split("\n"); process.stdout.write(JSON.stringify(ids.map((id)=>"/rpc/todos:listByList?args="+encodeURIComponent(JSON.stringify({listId:id})))))' "$LIST")
load() {
  case $KIND in
    getmany) RATE=${RATE:-} PORTS=${PORTS:-$PORT} REQ_PATHS="$GETPATHS" CONNS=${CONNS:-64} SECONDS=$1 taskset -c 3 node "$B/load.mjs" ;;
    get) RATE=${RATE:-} PORTS=${PORTS:-$PORT} REQ_PATH="$GETPATH" CONNS=${CONNS:-64} SECONDS=$1 taskset -c 3 node "$B/load.mjs" ;;
    post) RATE=${RATE:-} PORTS=${PORTS:-$PORT} POST_PATH=/rpc/todos:add BODY="{\"listId\":\"$LISTID\",\"title\":\"t {n}\"}" CONNS=${CONNS:-64} SECONDS=$1 taskset -c 3 node "$B/load.mjs" ;;
    # a read-modify-write: toggles the seeded todos in turn (SEED_LISTS=64 on the server: 1,280 of them)
    patch) RATE=${RATE:-} PORTS=${PORTS:-$PORT} POST_PATH=/rpc/todos:toggle BODY='{"id":"{id}"}' BODY_IDS="$TODOIDS" CONNS=${CONNS:-64} SECONDS=$1 taskset -c 3 node "$B/load.mjs" ;;
    fanout) PORT=$PORT SECONDS=$1 taskset -c 3 bun "$B/fanout.ts" ;;
  esac
}
[ "$KIND" != fanout ] && load 3 > /dev/null # warm-up
kill -USR2 $SPID
T0=$(date +%s%3N)
C0=$(cpu)
OUT=$(load ${SECONDS_:-20})
C1=$(cpu)
T1=$(date +%s%3N)
CPU=$(paste <(echo "$C0") <(echo "$C1") | awk '{printf "%s%s:%d", (NR>1?",":""), $1, 100*($5-$2)/($6-$3)}')
# Function-runtime processes' loop delay, from telemetry (10 s samples at 20 ms resolution): the worst p99 and max in the run.
WORKERS=$(curl -s -H "x-admin-key: $KEY" "http://127.0.0.1:$PORT/_admin/obs.runtime?input=$(node -e "process.stdout.write(encodeURIComponent(JSON.stringify({from:$T0,to:$T1+15000})))")" |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const r=JSON.parse(s);const out=r.series.filter(x=>x.role==="runtime").map(x=>{const p=x.points.filter(q=>q.loop_p99!=null);return {p99:Math.max(0,...p.map(q=>q.loop_p99)),max:Math.max(0,...p.map(q=>q.loop_max))}});process.stdout.write(JSON.stringify(out))}catch{process.stdout.write("null")}})')
kill -TERM $SPID ${S2PID:-}; wait $SPID ${S2PID:-} 2>/dev/null
LOOP=$(grep -o 'LOOP .*' "$B/serve.$PORT.log" | sed 's/LOOP //')
echo "{\"label\":\"$LABEL\",\"load\":$OUT,\"cpu\":\"$CPU\",\"serverLoop\":${LOOP:-null},\"workerLoops\":${WORKERS:-null}}"
