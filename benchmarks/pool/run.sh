#!/bin/bash
# An API with blocking work, with and without the thread pool (Anvil, `computePool`): the same function on the serving thread and on workers.
#   ./run.sh        env: SERVER_CPUS (0-3)  SERVER_MEM (2g)  CLIENT_CPUS (4-7,12-15)  ROUNDS (20000)  CONNS (32)  SECS (6)  RUNS (3)
# /work/inline hashes `ROUNDS` times on the thread that serves requests, /work/pool does it on a worker, /ping does nothing. Throughput is measured
# on each work route alone; then /ping is measured while the work route is under load, which shows what the serving thread has left for other requests.
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SERVER_CPUS=${SERVER_CPUS:-0-3}; SERVER_MEM=${SERVER_MEM:-2g}; CLIENT_CPUS=${CLIENT_CPUS:-4-7,12-15}
ROUNDS=${ROUNDS:-20000}; CONNS=${CONNS:-32}; SECS=${SECS:-6}; RUNS=${RUNS:-3}; PORT=4700
OUT=$HERE/results.raw; TMP=${TMPDIR:-/tmp}/pool-bench.$$; mkdir -p "$TMP"
ENVS=(-e RATE_LIMIT_PER_MINUTE=0 -e BETTER_AUTH_SECRET=ssssssssssssssssssssssssssssssss -e ALLOW_INSECURE_HTTP=1 --tmpfs /data:rw,uid=1000,gid=1000,size=256m)
docker image inspect bench-pool-forge >/dev/null 2>&1 || docker build -q -f "$HERE/forge/Dockerfile" -t bench-pool-forge "$HERE/forge" >/dev/null || exit 1

cpu_usec() { awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat"; }
oha() { taskset -c "$CLIENT_CPUS" oha --no-tui "$@"; }
# summary <file> <name> <scenario> <cores>: one JSON line
summary() { bun -e '
  const j = JSON.parse(await Bun.file(process.argv[1]).text());
  const ok = Object.entries(j.statusCodeDistribution).filter(([c]) => c.startsWith("2")).reduce((a, [, n]) => a + Number(n), 0);
  const total = Object.values(j.statusCodeDistribution).reduce((a, n) => a + Number(n), 0);
  console.log(JSON.stringify({ name: process.argv[2], scenario: process.argv[3], rps: j.summary.requestsPerSec, p50ms: j.latencyPercentiles.p50 * 1000, p99ms: j.latencyPercentiles.p99 * 1000, success: ok / total, cores: Number(process.argv[4]) }));
' "$@"; }

: > "$OUT.tmp"
for mode in inline pool; do
  PORT=$((PORT+1))
  cid=$(docker run -d --rm --network host --cpuset-cpus="$SERVER_CPUS" --memory="$SERVER_MEM" --memory-swap="$SERVER_MEM" -e PORT=$PORT "${ENVS[@]}" bench-pool-forge)
  for _ in $(seq 1 120); do curl -s -o /dev/null "localhost:$PORT/http/ping" && break; sleep 0.5; done
  base="http://127.0.0.1:$PORT/http"
  oha -z 3s -c "$CONNS" "$base/work/$mode?rounds=$ROUNDS" >/dev/null 2>&1   # the pool's threads start with the first call
  # throughput of the work route alone
  for run in $(seq 1 "$RUNS"); do
    u0=$(cpu_usec "$cid"); oha -z "${SECS}s" -c "$CONNS" --output-format json "$base/work/$mode?rounds=$ROUNDS" 2>/dev/null > "$TMP/o.json"; u1=$(cpu_usec "$cid")
    summary "$TMP/o.json" "$mode" work "$(bun -e "console.log((($u1-$u0)/1e6/$SECS).toFixed(2))")" >> "$OUT.tmp"
  done
  # /ping while the work route is under load (the work client is not measured)
  for run in $(seq 1 "$RUNS"); do
    oha -z "$((SECS+4))s" -c "$CONNS" "$base/work/$mode?rounds=$ROUNDS" >/dev/null 2>&1 &
    load=$!; sleep 2
    oha -z "${SECS}s" -c 4 --output-format json "$base/ping" 2>/dev/null > "$TMP/o.json"
    wait $load
    summary "$TMP/o.json" "$mode" ping-under-load 0 >> "$OUT.tmp"
  done
  docker stop -t 1 "$cid" >/dev/null; sleep 1
done
# the idle server's /ping, for reference
PORT=$((PORT+1))
cid=$(docker run -d --rm --network host --cpuset-cpus="$SERVER_CPUS" --memory="$SERVER_MEM" --memory-swap="$SERVER_MEM" -e PORT=$PORT "${ENVS[@]}" bench-pool-forge)
for _ in $(seq 1 120); do curl -s -o /dev/null "localhost:$PORT/http/ping" && break; sleep 0.5; done
oha -z 2s -c 4 "http://127.0.0.1:$PORT/http/ping" >/dev/null 2>&1
for run in $(seq 1 "$RUNS"); do oha -z "${SECS}s" -c 4 --output-format json "http://127.0.0.1:$PORT/http/ping" 2>/dev/null > "$TMP/o.json"; summary "$TMP/o.json" idle ping 0 >> "$OUT.tmp"; done
docker stop -t 1 "$cid" >/dev/null
echo "{\"rounds\":$ROUNDS,\"conns\":$CONNS,\"secs\":$SECS}" > "$HERE/params.json"
mv "$OUT.tmp" "$OUT"; rm -rf "$TMP"
bun "$HERE/report.ts"
