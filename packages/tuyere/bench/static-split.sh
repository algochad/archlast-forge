#!/bin/bash
# Per-thread CPU per request on a static route (never enters JS). usage: static-split.sh engine conns
cd "$(dirname "$0")/.."
E=$1; C=${2:-1}; PORT=5202
PORT=$PORT THREADS=${THREADS:-2} BACKEND=napi taskset -c 0-3 bun bench/servers/static-$E.ts >/dev/null 2>&1 & pid=$!
for k in $(seq 1 40); do curl -s -o /dev/null http://127.0.0.1:$PORT/json && break; sleep 0.25; done
OHA="taskset -c 4-7,12-15 $HOME/.cargo/bin/oha --no-tui -c $C http://127.0.0.1:$PORT/json"
$OHA -z 2s >/dev/null 2>&1
snap() { for t in /proc/$pid/task/*; do echo "$(cat $t/comm | tr ' ' _) $(awk '{print $14, $15}' $t/stat)"; done | sort; }
snap > $CLAUDE_JOB_DIR/tmp/st0.txt
out=$($OHA -z 5s --output-format json 2>/dev/null)
snap > $CLAUDE_JOB_DIR/tmp/st1.txt
kill $pid; wait $pid 2>/dev/null
python3 - "$out" <<'PY'
import json,os,sys
j=json.loads(sys.argv[1]); rps=j['summary']['requestsPerSec']; reqs=rps*5
rd=lambda f:[l.split() for l in open(os.environ['CLAUDE_JOB_DIR']+'/tmp/'+f).read().strip().split("\n")]
a,b=rd('st0.txt'),rd('st1.txt'); tot=0
print(f"c=$C {rps:.0f} req/s  p50 {j['latencyPercentiles']['p50']*1e6:.1f} us")
for x,y in zip(a,b):
    if x[0]!=y[0]: continue
    du=(int(y[1])-int(x[1]))*10; ds=(int(y[2])-int(x[2]))*10; tot+=du+ds
    if du+ds>80: print(f"   {y[0]:16s} user {du*1e6/reqs:6.0f} sys {ds*1e6/reqs:6.0f} ns/req")
print(f"   total {tot*1e6/reqs:.0f} ns/req")
PY
