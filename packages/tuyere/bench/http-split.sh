#!/bin/bash
# Per-thread CPU per request of Forge's RPC handler over HTTP (oha closed loop). usage: http-split.sh engine conns [secs]
cd "$(dirname "$0")/.."
E=$1; C=${2:-64}; S=${3:-6}; PORT=5101
ENGINE=$E PORT=$PORT THREADS=${THREADS:-2} ARCHLAST_BACKEND=${BACKEND:-napi} taskset -c 0-3 bun bench/servers/forge-rpc.ts >/dev/null 2>&1 & pid=$!
for i in $(seq 1 60); do curl -s -o /dev/null -X POST -H "authorization: Bearer bench-token" -d '{"blob":"x"}' http://127.0.0.1:$PORT/echo.back && break; sleep 0.25; done; sleep 0.5
OHA="taskset -c 4-7,12-15 $HOME/.cargo/bin/oha --no-tui -m POST -H authorization:Bearer\ bench-token -d {\"blob\":\"xxxxxxxxxxxxxxxx\"} -c $C http://127.0.0.1:$PORT/echo.back"
eval "$OHA -z 2s" >/dev/null 2>&1
snap() { for t in /proc/$pid/task/*; do echo "$(cat $t/comm) $(awk '{print $14, $15}' $t/stat)"; done | sort; }
snap > $CLAUDE_JOB_DIR/tmp/h0.txt
out=$(eval "$OHA -z ${S}s --output-format json" 2>/dev/null)
snap > $CLAUDE_JOB_DIR/tmp/h1.txt
kill $pid; wait $pid 2>/dev/null
echo "$out" | python3 -c "
import json,sys
j=json.load(sys.stdin); print('$E c=$C', round(j['summary']['requestsPerSec']), 'req/s')" 
python3 - <<PY
import os
def rd(f):
    out=[]
    for l in open(f).read().strip().split("\n"):
        parts=l.rsplit(" ",2); out.append([parts[0].replace(" ","_"),parts[1],parts[2]])
    return out
a=rd(os.environ['CLAUDE_JOB_DIR']+'/tmp/h0.txt'); b=rd(os.environ['CLAUDE_JOB_DIR']+'/tmp/h1.txt')
import json
rps=json.loads('''$out''')['summary']['requestsPerSec']; reqs=rps*$S
tot=0
for x,y in zip(a,b):
    if x[0]!=y[0]: continue
    du=(int(y[1])-int(x[1]))*10; ds=(int(y[2])-int(x[2]))*10
    tot+=du+ds
    if du+ds>50: print(f"   {y[0]:18s} user {du*1e6/reqs:6.0f} sys {ds*1e6/reqs:6.0f} ns/req")
print(f"   total {tot*1e6/reqs:.0f} ns/req")
PY
