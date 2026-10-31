#!/usr/bin/env bash
# CPU per process and thread during a saturation run. usage: threads.sh <server cores> [server env...]
cd "$(dirname "$0")"
CORES=$1; shift
env PORT=3100 LIST_FILE=list.3100 "$@" taskset -c "$CORES" bun serve.ts > serve.thr.log 2>&1 &
SP=$!
for _ in $(seq 1 80); do grep -q READY serve.thr.log && break; sleep 0.25; done
LID=$(cat list.3100)
P="/rpc/todos:listByList?args=$(node -e "process.stdout.write(encodeURIComponent(JSON.stringify({listId:'$LID'})))")"
REQ_PATH="$P" SECONDS=3 taskset -c 3 node load.mjs > /dev/null
PIDS="$SP $(pgrep -P $SP | tr '\n' ' ')"
snap() { for p in $PIDS; do for t in /proc/$p/task/*; do echo "$p/$(basename $t) $(tr -d '()' < $t/comm | tr ' ' _) $(awk '{print $14+$15}' $t/stat)"; done; done | sort; }
A=$(snap)
R=$(REQ_PATH="$P" SECONDS=10 taskset -c 3 node load.mjs)
B=$(snap)
kill -TERM $SP; wait $SP 2>/dev/null
echo "$R"
# ticks are 1/100 s, over 10 s: ticks/10 = % of one core
join <(echo "$A") <(echo "$B" | awk '{print $1, $3}') | awk -v sp=$SP '{d=$4-$3; split($1,a,"/"); who=(a[1]==sp?"server":"worker" a[1]); if (d>=10) printf "%-14s %-16s %5.1f%%\n", who, $2, d/10; tot[who]+=d} END {for (w in tot) printf "TOTAL %-8s %5.1f%% of a core\n", w, tot[w]/10}' | sort -k3 -rn
