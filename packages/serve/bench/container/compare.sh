#!/bin/bash
# Forge's RPC handler on Bun.serve vs archlast-serve inside containers with fixed resources.
#   server container: SERVER_CPUS (default 0-3, four physical cores), SERVER_MEM (2g)
#   client container: CLIENT_CPUS (default 4-7)
# usage: bench/container/compare.sh [engine...]   engines: bun archlast        env: THREADS (Rust I/O threads, default 2), BACKEND, HTTP_CONNS, WS_CONNS, SECS
cd "$(dirname "$0")/../.."
ENGINES=${@:-bun archlast}
SERVER_CPUS=${SERVER_CPUS:-0-3}; SERVER_MEM=${SERVER_MEM:-2g}; CLIENT_CPUS=${CLIENT_CPUS:-4-7,12-15}
SECS=${SECS:-6}
BODY='{"blob":"xxxxxxxxxxxxxxxx"}'
FRAME='[[1,"echo.back",{"blob":"xxxxxxxxxxxxxxxx"}]]'
PORT=4400
client() { docker run --rm --network host --cpuset-cpus=$CLIENT_CPUS --entrypoint "$1" archlast-bench "${@:2}"; }
cpu_usec() { awk '/^usage_usec/ {print $2}' /sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat; }
for E in $ENGINES; do
  PORT=$((PORT+1))
  CID=$(docker run -d --rm --network host --cpuset-cpus=$SERVER_CPUS --memory=$SERVER_MEM --memory-swap=$SERVER_MEM \
    -e ENGINE=${E%%:*} -e PORT=$PORT -e THREADS=${THREADS:-2} -e ARCHLAST_BACKEND=${BACKEND:-napi} ${SERVER_ENV} archlast-bench bun bench/servers/forge-rpc.ts)
  for i in $(seq 1 80); do curl -s -o /dev/null -X POST -H "authorization: Bearer bench-token" -d "$BODY" http://127.0.0.1:$PORT/echo.back && break; sleep 0.25; done
  sleep 1
  for c in ${HTTP_CONNS:-1 16 64 256}; do
    client oha --no-tui -c $c -z 2s -m POST -H "authorization: Bearer bench-token" -d "$BODY" http://127.0.0.1:$PORT/echo.back >/dev/null 2>&1
    u0=$(cpu_usec $CID)
    client oha --no-tui --output-format json -c $c -z ${SECS}s -m POST -H "authorization: Bearer bench-token" -d "$BODY" http://127.0.0.1:$PORT/echo.back 2>/dev/null > $CLAUDE_JOB_DIR/tmp/oha.json
    u1=$(cpu_usec $CID)
    bun -e 'const j=JSON.parse(await Bun.file(process.argv[1]).text());const [l,c,u0,u1,secs]=process.argv.slice(2);const rps=j.summary.requestsPerSec,cores=(u1-u0)/1e6/secs;console.log(`${l.padEnd(12)} http c=${c.padEnd(4)} ${String(Math.round(rps)).padStart(7)} req/s  ${cores.toFixed(2)} cores  ${(cores/rps*1e6).toFixed(2)} us/req  p50 ${(j.latencyPercentiles.p50*1000).toFixed(3)}ms p99 ${(j.latencyPercentiles.p99*1000).toFixed(3)}ms`)' $CLAUDE_JOB_DIR/tmp/oha.json "$E" $c $u0 $u1 $SECS
  done
  for cs in ${WS_CASES:-1:1 16:1 256:16 512:32}; do
    c=${cs%%:*}; k=${cs##*:}
    envs=(-e "WS_EXTRA_HEADER=Authorization: Bearer bench-token" -e WS_LENIENT=1 -e "WS_MESSAGE=$FRAME" -e WS_PIPELINE=$k)
    docker run --rm --network host --cpuset-cpus=$CLIENT_CPUS "${envs[@]}" --entrypoint wsclient archlast-bench ws-echo --url ws://127.0.0.1:$PORT/_ws --conns $c --secs 2 --warmup 0.5 --threads 8 >/dev/null 2>&1
    u0=$(cpu_usec $CID); w0=$(date +%s.%N)
    out=$(docker run --rm --network host --cpuset-cpus=$CLIENT_CPUS "${envs[@]}" --entrypoint wsclient archlast-bench ws-echo --url ws://127.0.0.1:$PORT/_ws --conns $c --secs $SECS --warmup 0.5 --threads 8 2>/dev/null | tail -1)
    u1=$(cpu_usec $CID); w1=$(date +%s.%N)
    bun -e 'const j=JSON.parse(process.argv[1]);const [l,c,k,u0,u1,w0,w1]=process.argv.slice(2);const wall=Number(w1)-Number(w0);const msgs=j.msgs_per_sec*(wall-0.9);const cpu=(u1-u0)/1e6;console.log(`${l.padEnd(12)} ws   c=${c.padEnd(4)} pipe=${k.padEnd(3)} ${String(Math.round(j.msgs_per_sec)).padStart(7)} msg/s  ${(cpu/(wall-0.3)).toFixed(2)} cores  ${(cpu/msgs*1e6).toFixed(2)} us/msg  p50 ${(j.p50_us/1000).toFixed(3)}ms p99 ${(j.p99_us/1000).toFixed(3)}ms`)' "$out" "$E" $c $k $u0 $u1 $w0 $w1
  done
  docker stop -t 1 $CID >/dev/null 2>&1
  sleep 0.5
done
