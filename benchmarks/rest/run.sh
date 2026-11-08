#!/bin/bash
# The benchmark's CRUD API in six stacks, each in a container with the same limits, loaded with oha from outside.
#   ./run.sh [server...]        servers: axum go dotnet bun node serve forge forge-bun forge-notelemetry   (default: all; a run of some servers keeps the others' results)
#   env: SERVER_CPUS (0-3)  SERVER_MEM (2g)  CLIENT_CPUS (4-7,12-15)  CONNS (64)  SECS (5)  RUNS (3)
# Builds the images first (docker build, context: this folder), checks each server with conformance.ts, then for each scenario warms up for 2 s and
# measures RUNS runs of SECS seconds: requests/s, latency, the CPU the container used (cgroup cpu.stat) and its peak memory (memory.peak).
set -u
HERE=$(cd "$(dirname "$0")" && pwd)
SERVER_CPUS=${SERVER_CPUS:-0-3}; SERVER_MEM=${SERVER_MEM:-2g}; CLIENT_CPUS=${CLIENT_CPUS:-4-7,12-15}
CONNS=${CONNS:-64}; SECS=${SECS:-5}; RUNS=${RUNS:-3}; PORT=4600
OUT=$HERE/results.raw
TMP=${TMPDIR:-/tmp}/rest-bench.$$; mkdir -p "$TMP"
BODY='{"name":"widget","quantity":7}'
FORGE_ENV=(-e RATE_LIMIT_PER_MINUTE=0 -e BETTER_AUTH_SECRET=ssssssssssssssssssssssssssssssss -e ALLOW_INSECURE_HTTP=1 --tmpfs /data:rw,uid=1000,gid=1000,size=256m)

# name | image | url prefix | docker arguments
declare -A IMAGE PREFIX ARGS LABEL
def() { IMAGE[$1]=$2; PREFIX[$1]=$3; ARGS[$1]=$4; LABEL[$1]=$5; }
def axum bench-rest-axum "" "" "Rust (Axum 0.8, Tokio)"
def go bench-rest-go "" "" "Go (fasthttp)"
def dotnet bench-rest-dotnet "" "" ".NET 10 (Minimal APIs)"
def bun bench-rest-bun "" "" "Bun.serve"
def serve bench-rest-archlast-serve "" "-e THREADS=3" "archlast-serve (native App API, 3 I/O threads)"
def node bench-rest-express "" "" "Node.js 24 (Express 5)"
def forge bench-rest-forge /http "${FORGE_ENV[*]}" "archlast-forge (NestJS path, archlast-serve)"
def forge-bun bench-rest-forge /http "${FORGE_ENV[*]} -e HTTP_ENGINE=bun" "archlast-forge (NestJS path, Bun.serve)"
def forge-notelemetry bench-rest-forge /http "${FORGE_ENV[*]} -e TELEMETRY=off" "archlast-forge (NestJS path, archlast-serve, telemetry off)"
SERVERS=${*:-axum go dotnet bun node serve forge forge-bun forge-notelemetry}

build() {
  for s in axum go dotnet bun express archlast-serve forge; do
    docker image inspect bench-rest-$s >/dev/null 2>&1 || docker build -q -f "$HERE/servers/$s/Dockerfile" -t bench-rest-$s "$HERE" >/dev/null || exit 1
  done
}
[ "${SKIP_BUILD:-0}" = 1 ] || build

cpu_usec() { awk '/^usage_usec/ {print $2}' "/sys/fs/cgroup/system.slice/docker-$1.scope/cpu.stat"; }
oha() { taskset -c "$CLIENT_CPUS" oha --no-tui -c "$CONNS" "$@"; }

: > "$OUT.tmp"
for name in $SERVERS; do
  PORT=$((PORT+1)); pre=${PREFIX[$name]}
  cid=$(docker run -d --rm --network host --cpuset-cpus="$SERVER_CPUS" --memory="$SERVER_MEM" --memory-swap="$SERVER_MEM" -e PORT=$PORT ${ARGS[$name]} ${IMAGE[$name]})
  for _ in $(seq 1 120); do curl -s -o /dev/null "localhost:$PORT$pre/items/1" && break; sleep 0.5; done
  if ! bun "$HERE/conformance.ts" "http://127.0.0.1:$PORT" "$pre" >"$TMP/conf.log" 2>&1; then echo "$name does not conform:"; grep ✗ "$TMP/conf.log"; docker stop -t 1 "$cid" >/dev/null; continue; fi
  # the conformance run changed items 2 and 3; start the measurements from a fresh server
  docker stop -t 1 "$cid" >/dev/null; sleep 1
  cid=$(docker run -d --rm --network host --cpuset-cpus="$SERVER_CPUS" --memory="$SERVER_MEM" --memory-swap="$SERVER_MEM" -e PORT=$PORT ${ARGS[$name]} ${IMAGE[$name]})
  for _ in $(seq 1 120); do curl -s -o /dev/null "localhost:$PORT$pre/items/1" && break; sleep 0.5; done
  base="http://127.0.0.1:$PORT$pre"
  # scenario | oha arguments
  while IFS='|' read -r scenario args; do
    eval "set -- $args"
    oha -z 2s "$@" >/dev/null 2>&1
    for run in $(seq 1 "$RUNS"); do
      u0=$(cpu_usec "$cid")
      oha -z "${SECS}s" --output-format json "$@" 2>/dev/null > "$TMP/oha.json"
      u1=$(cpu_usec "$cid")
      bun -e '
        const j = JSON.parse(await Bun.file(process.argv[1]).text());
        const [name, scenario, run, u0, u1, secs] = process.argv.slice(2);
        const ok = Object.entries(j.statusCodeDistribution).filter(([c]) => c.startsWith("2")).reduce((a, [, n]) => a + Number(n), 0);
        const total = Object.values(j.statusCodeDistribution).reduce((a, n) => a + Number(n), 0);
        const rps = j.summary.requestsPerSec;
        console.log(JSON.stringify({ name, scenario, run: Number(run), rps, p50ms: j.latencyPercentiles.p50 * 1000, p99ms: j.latencyPercentiles.p99 * 1000, success: ok / total, cores: (u1 - u0) / 1e6 / Number(secs) }));
      ' "$TMP/oha.json" "$name" "$scenario" "$run" "$u0" "$u1" "$SECS" >> "$OUT.tmp"
    done
    tail -n "$RUNS" "$OUT.tmp" | bun -e 'const rows = (await Bun.stdin.text()).trim().split("\n").map((l) => JSON.parse(l)).sort((a, b) => a.rps - b.rps); const m = rows[Math.floor(rows.length / 2)]; console.log(`${m.name.padEnd(18)} ${m.scenario.padEnd(7)} ${String(Math.round(m.rps)).padStart(8)} req/s  p50 ${m.p50ms.toFixed(2)} ms  p99 ${m.p99ms.toFixed(2)} ms  ${m.cores.toFixed(2)} cores  ok ${(m.success * 100).toFixed(1)}%`)'
  done <<SCENARIOS
read|--rand-regex-url '$base/items/([1-9][0-9]{0,2})'
list|'$base/items?limit=20'
update|-m PUT -H 'content-type: application/json' -d '$BODY' --rand-regex-url '$base/items/([1-9][0-9]{0,2})'
create|-m POST -H 'content-type: application/json' -d '$BODY' '$base/items'
SCENARIOS
  peak=$(awk '{printf "%.0f", $1/1048576}' "/sys/fs/cgroup/system.slice/docker-$cid.scope/memory.peak")
  echo "{\"name\":\"$name\",\"scenario\":\"_memory\",\"peakMiB\":$peak}" >> "$OUT.tmp"
  echo "$name peak memory ${peak} MiB"
  docker stop -t 1 "$cid" >/dev/null; sleep 1
done
# a run of some servers keeps the results of the others
if [ -s "$OUT" ]; then
  keep=$(cat "$OUT"); for name in $SERVERS; do keep=$(printf '%s\n' "$keep" | grep -v "\"name\":\"$name\"" || true); done
  { printf '%s\n' "$keep" | grep -v '^$'; cat "$OUT.tmp"; } > "$OUT.new" && mv "$OUT.new" "$OUT"; rm -f "$OUT.tmp"
else mv "$OUT.tmp" "$OUT"; fi
rm -rf "$TMP"
